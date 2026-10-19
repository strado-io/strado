import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';
import { createTerminalManager, claudeKey, codexKey, shellKey } from '../../src/services/terminalManager';
import { HUMAN, INTERCOM_CHANNEL } from '../../src/services/intercomStore';
import { MCP_NUDGE, NUDGE } from '../../src/services/intercomPush';
import { RUN_MARKER_PREFIX } from '../../src/services/intercomSchema';
import type { BusEvent } from '../../src/events/bus';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let deps: Awaited<ReturnType<typeof buildDeps>>;

async function makeRepo(): Promise<void> {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-intercom-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a'), '1');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });
}

async function boot(): Promise<void> {
  deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  deps.terminal = createTerminalManager(() => ({ file: 'cat', args: [] }), undefined, undefined, undefined, deps.agents.envFor);
  app = await buildApp(deps);
  await app.inject({
    method: 'POST', url: '/api/w/default/repos',
    payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
  });
}

afterEach(async () => {
  // killUnder signals the PTY asynchronously. Its exit persists the registry,
  // so wait for exits before closing and removing the test's state directory.
  app.deps.terminal.killUnder(tmp);
  await vi.waitFor(() => expect(app.deps.terminal.liveSessions().filter((s) => s.path.startsWith(tmp + path.sep))).toEqual([]), { timeout: 5000 });
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('intercom wiring', () => {
  beforeEach(async () => { await makeRepo(); await boot(); });

  it('opens <homeStateDir>/intercom.sqlite at boot with mode 0600 and closes it with the app', async () => {
    const file = path.join(tmp, 'home', 'intercom.sqlite');
    expect(((await fs.stat(file)).mode & 0o777)).toBe(0o600);
    expect(deps.intercom.listScope('default')).toEqual([]);
    await app.close();
    expect(() => deps.intercom.listScope('default')).toThrow();
    app = await buildApp(await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') })); // afterEach closes this one
  });
});

describe('intercom fail-soft', () => {
  beforeEach(async () => {
    await makeRepo();
    // A directory where the database file must go: DatabaseSync cannot open it.
    await fs.mkdir(path.join(tmp, 'home', 'intercom.sqlite'), { recursive: true });
    await boot();
  });

  it('boots with a disabled store; health is 200; intercom methods throw UNAVAILABLE', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(() => deps.intercom.listScope('default')).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(deps.intercom.sweep()).toEqual({ expired: 0, deleted: 0, turnsDeleted: 0, tasksDeleted: 0, escalationsDeleted: 0, escalationsRetargeted: 0 });
  });

  it('the turn diary routes answer 503 on a disabled store', async () => {
    const { token } = await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
    const tokenRoute = await app.inject({
      method: 'GET', url: '/api/intercom/diary?agent=claude-1@repo', headers: { authorization: `Bearer ${token}` },
    });
    expect(tokenRoute.statusCode).toBe(503);
    const scopedRoute = await app.inject({ method: 'GET', url: '/api/w/default/intercom/diary?agent=claude-1@repo' });
    expect(scopedRoute.statusCode).toBe(503);
  });
});

describe('intercom routes', () => {
  let tokA: string;
  let tokB: string;
  let tokC: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeEach(async () => {
    await makeRepo();
    await boot();
    tokA = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
    tokB = (await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' })).token;
    tokC = (await deps.agents.register({ key: shellKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
  });

  it('GET /api/w/:ws/intercom/stations lists every tab with the calls waiting on the human', async () => {
    const realList = deps.agents.list.bind(deps.agents);
    deps.agents.list = async (scopeId: string) => (await realList(scopeId)).map((a) => a.agentId === 'claude-2@repo' ? { ...a, lifecycle: 'needs_input' as const, live: true } : a);
    const call = await app.inject({ method: 'POST', url: '/api/intercom/escalations', headers: auth(tokA), payload: { title: 'Change Mohan?', body: 'found it in webhooks' } });
    expect(call.statusCode).toBe(201);
    // A peer-addressed escalation is not a call for the human.
    await app.inject({ method: 'POST', url: '/api/intercom/escalations', headers: auth(tokA), payload: { to: 'claude-2@repo', title: 'peer q', body: 'q?' } });
    deps.ptyActivity.noteOutput(claudeKey(repo, '1'));

    const res = await app.inject({ method: 'GET', url: '/api/w/default/intercom/stations' });
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.json().stations.map((s: { agentId: string }) => [s.agentId, s]));
    expect(Object.keys(byId).sort()).toEqual(['claude-1@repo', 'claude-2@repo', 'shell-1@repo']);
    expect(byId['claude-1@repo']).toMatchObject({
      name: 'claude-1', mode: 'claude', worktreeName: path.basename(repo), sessionId: '1', needsYou: true,
      calls: [{ id: call.json().escalation.id, title: 'Change Mohan?', body: 'found it in webhooks' }],
    });
    expect(byId['claude-1@repo'].lastActivityAt).toBeGreaterThan(Date.now() - 5000);
    expect(byId['claude-2@repo']).toMatchObject({ needsYou: true, calls: [] }); // permission prompt
    expect(byId['shell-1@repo']).toMatchObject({ needsYou: false, calls: [], lastActivityAt: null });
  });

  it('401 UNAUTHENTICATED on every route without a token', async () => {
    const calls = [
      { method: 'POST', url: '/api/intercom/messages', payload: { to: 'claude-2@repo', body: 'x' } },
      { method: 'POST', url: '/api/intercom/pull', payload: {} },
      { method: 'POST', url: '/api/intercom/messages/abc/ack' },
      { method: 'GET', url: '/api/intercom/messages/abc' },
      { method: 'GET', url: '/api/intercom/peers' },
    ] as const;
    for (const c of calls) {
      const r = await app.inject({ ...c });
      expect(r.statusCode, c.url).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('send → pull → ack round trip with receipts, sender from the token only', async () => {
    const seen: unknown[] = [];
    const off = deps.bus.on('intercom', (e) => seen.push(e));
    const sent = await app.inject({
      method: 'POST', url: '/api/intercom/messages', headers: auth(tokA),
      payload: { to: 'claude-2@repo', body: 'review src/a.ts', context: [{ kind: 'file', value: 'src/a.ts', label: 'target' }], from: 'shell-1@repo' },
    });
    expect(sent.statusCode).toBe(201);
    const { id } = sent.json();
    expect(sent.json()).toMatchObject({ state: 'queued', deliveryCount: 0, replyId: null });

    const pulled = await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: auth(tokB), payload: {} });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json().messages).toHaveLength(1);
    expect(pulled.json().messages[0]).toMatchObject({
      id, to: 'claude-2@repo', kind: 'message', body: 'review src/a.ts', state: 'delivered', redelivery: false, deliveryCount: 1,
      from: { agentId: 'claude-1@repo', alias: null }, context: [{ kind: 'file', value: 'src/a.ts', label: 'target' }],
    });
    expect(pulled.json().messages[0].from.executionId).toBeTypeOf('string');
    expect(pulled.json().batchId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(pulled.json().messages[0]).toMatchObject({ batchId: pulled.json().batchId, confirmed: false });
    const empty = await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: auth(tokB) });   // no body at all
    expect(empty.json().messages).toEqual([]);
    expect(empty.json().batchId).toBeNull();

    const byA = await app.inject({ method: 'GET', url: `/api/intercom/messages/${id}`, headers: auth(tokA) });
    expect(byA.json().state).toBe('delivered');
    const byC = await app.inject({ method: 'GET', url: `/api/intercom/messages/${id}`, headers: auth(tokC) });
    expect(byC.statusCode).toBe(404);

    const ackByA = await app.inject({ method: 'POST', url: `/api/intercom/messages/${id}/ack`, headers: auth(tokA) });
    expect(ackByA.statusCode).toBe(404);
    const acked = await app.inject({ method: 'POST', url: `/api/intercom/messages/${id}/ack`, headers: auth(tokB) });
    expect(acked.statusCode).toBe(200);
    expect(acked.json().state).toBe('acknowledged');
    off();
    // Push delivery (step 5) shares this channel: an arrival trigger fires for the
    // 'message.queued' below and reports its own push.skipped/push.sent event —
    // irrelevant to this round trip, so it's filtered out here.
    expect(seen.filter((e: any) => !e.type.startsWith('push.')).map((e: any) => e.type)).toEqual(['message.queued', 'message.delivered', 'message.acknowledged']);
    expect(JSON.stringify(seen)).not.toContain('review src/a.ts');
  });

  it('resolves an alias, 404s an unknown recipient, 409s an idempotency mismatch, 200s a replay', async () => {
    await app.inject({ method: 'PUT', url: '/api/w/default/agents/claude-2@repo/alias', payload: { alias: 'reviewer' } });
    const first = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'Reviewer', body: 'x', idempotencyKey: 'k' } });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'Reviewer', body: 'x', idempotencyKey: 'k' } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    const clash = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'Reviewer', body: 'y', idempotencyKey: 'k' } });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('CONFLICT');
    const nobody = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'ghost', body: 'x' } });
    expect(nobody.statusCode).toBe(404);
    const pulled = await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: auth(tokB), payload: {} });
    expect(pulled.json().messages.map((m: any) => m.to)).toEqual(['claude-2@repo']);
  });

  it('request/reply: replyId appears on the request receipt; a second reply is 409', async () => {
    const req = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'claude-2@repo', kind: 'request', body: 'ready?' } });
    const reqId = req.json().id;
    const rep = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokB), payload: { to: 'claude-1@repo', kind: 'reply', replyTo: reqId, body: 'yes' } });
    expect(rep.statusCode).toBe(201);
    const receipt = await app.inject({ method: 'GET', url: `/api/intercom/messages/${reqId}`, headers: auth(tokA) });
    expect(receipt.json().replyId).toBe(rep.json().id);
    const again = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokB), payload: { to: 'claude-1@repo', kind: 'reply', replyTo: reqId, body: 'yes again' } });
    expect(again.statusCode).toBe(409);
  });

  it('400 VALIDATION for oversize body and a reply without replyTo', async () => {
    const big = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'claude-2@repo', body: 'x'.repeat(65 * 1024) } });
    expect(big.statusCode).toBe(400);
    expect(big.json().error.code).toBe('VALIDATION');
    const noReplyTo = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'claude-2@repo', kind: 'reply', body: 'x' } });
    expect(noReplyTo.statusCode).toBe(400);
  });

  it('a released execution can no longer send', async () => {
    await deps.agents.release(claudeKey(repo, '1'));
    const r = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'claude-2@repo', body: 'x' } });
    expect(r.statusCode).toBe(401);
  });

  it('peers lists every agent in the caller scope without tokens', async () => {
    await deps.agents.register({ key: claudeKey('/elsewhere', '1'), cwd: '/elsewhere', scopeId: 'other' });
    const r = await app.inject({ method: 'GET', url: '/api/intercom/peers', headers: auth(tokA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().peers.map((p: any) => p.agentId)).toEqual(['claude-1@repo', 'claude-2@repo', 'shell-1@repo']);
    expect(JSON.stringify(r.json())).not.toMatch(/token/i);
  });

  it('a sandboxed tab reaches only peers of its own worktree by message, ask, diary and task; the human stays reachable', async () => {
    const other = path.join(tmp, 'other-wt');
    await fs.mkdir(other, { recursive: true });
    await deps.agents.register({ key: claudeKey(other, '1'), cwd: other, scopeId: 'default' });
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth(tokA), payload: payload as object });
    // Unsandboxed: cross-worktree traffic is fine.
    expect((await post('/api/intercom/messages', { to: 'claude-1@other-wt', body: 'hi' })).statusCode).toBe(201);
    const foreignTask = deps.intercom.createTask({ scopeId: 'default', by: HUMAN, title: 'theirs', worktreePath: other });
    const anyTask = deps.intercom.createTask({ scopeId: 'default', by: HUMAN, title: 'anyone' });
    deps.sandboxSlugs.set(repo, 'repo-sbx');
    try {
      const msg = await post('/api/intercom/messages', { to: 'claude-1@other-wt', body: 'hi' });
      expect(msg.statusCode).toBe(403);
      expect(msg.json().error.code).toBe('FORBIDDEN');
      expect((await post('/api/intercom/escalations', { to: 'claude-1@other-wt', title: 'q', body: 'q?' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/intercom/diary?agent=claude-1@other-wt', headers: auth(tokA) })).statusCode).toBe(403);
      expect((await post('/api/intercom/tasks', { title: 'x', worktreePath: other })).statusCode).toBe(403);
      expect((await post(`/api/intercom/tasks/${foreignTask.id}/claim`, {})).statusCode).toBe(403);
      // Its own worktree, the human, and unscoped tasks stay reachable.
      expect((await post('/api/intercom/messages', { to: 'claude-2@repo', body: 'hi' })).statusCode).toBe(201);
      expect((await post('/api/intercom/escalations', { title: 'q', body: 'q?' })).statusCode).toBe(201);
      expect((await post(`/api/intercom/tasks/${anyTask.id}/claim`, {})).statusCode).toBe(200);
    } finally { deps.sandboxSlugs.delete(repo); }
  });
});

describe('intercom routes when disabled', () => {
  beforeEach(async () => {
    await makeRepo();
    await fs.mkdir(path.join(tmp, 'home', 'intercom.sqlite'), { recursive: true });
    await boot();
  });

  it('503 UNAVAILABLE with a valid token', async () => {
    const tok = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
    const r = await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: { authorization: `Bearer ${tok}` }, payload: {} });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('UNAVAILABLE');
  });
});

describe('GET /api/w/:ws/intercom/messages', () => {
  beforeEach(async () => {
    await makeRepo();
    await boot();
  });

  it('agent= narrows to one station\'s line, sent or received, and still honours limit', async () => {
    const a = await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
    const b = await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' });
    const c = await deps.agents.register({ key: claudeKey(repo, '3'), cwd: repo, scopeId: 'default' });
    const send = (tok: string, to: string, body: string) =>
      app.inject({ method: 'POST', url: '/api/intercom/messages', headers: { authorization: `Bearer ${tok}` }, payload: { to, body } });
    await send(a.token, 'claude-2@repo', 'a→b');
    await send(b.token, 'claude-3@repo', 'b→c');
    await send(c.token, 'claude-1@repo', 'c→a');
    const line = async (q: string) => (await app.inject({ method: 'GET', url: `/api/w/default/intercom/messages?${q}` })).json().messages.map((m: { body: string }) => m.body).sort();
    expect(await line('agent=claude-1@repo')).toEqual(['a→b', 'c→a']);
    expect(await line('agent=claude-3@repo')).toEqual(['b→c', 'c→a']);
    expect(await line('agent=claude-1@repo&limit=1')).toHaveLength(1);
    expect(await line('agent=nobody@repo')).toEqual([]);
  });

  it('lists both directions with state, newest first, honouring since and limit, without tokens', async () => {
    const a = await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
    const b = await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' });
    await deps.agents.register({ key: claudeKey('/elsewhere', '1'), cwd: '/elsewhere', scopeId: 'other' });
    const send = (tok: string, to: string, body: string) =>
      app.inject({ method: 'POST', url: '/api/intercom/messages', headers: { authorization: `Bearer ${tok}` }, payload: { to, body } });
    const m1 = (await send(a.token, 'claude-2@repo', 'one')).json();
    const m2 = (await send(b.token, 'claude-1@repo', 'two')).json();
    const m3 = (await send(a.token, 'claude-2@repo', 'three')).json();
    await app.inject({ method: 'POST', url: `/api/intercom/messages/${m2.id}/ack`, headers: { authorization: `Bearer ${a.token}` } });

    await app.inject({ method: 'PUT', url: '/api/w/default/agents/claude-1@repo/alias', payload: { alias: 'lead' } });

    const all = await app.inject({ method: 'GET', url: '/api/w/default/intercom/messages' });
    expect(all.statusCode).toBe(200);
    const ids = all.json().messages.map((m: any) => m.id);
    expect(new Set(ids)).toEqual(new Set([m1.id, m2.id, m3.id]));
    const stamps = all.json().messages.map((m: any) => m.createdAt);
    expect(stamps).toEqual([...stamps].sort((x, y) => y - x));             // newest first (same-ms ties may be in any order)
    const byId = Object.fromEntries(all.json().messages.map((m: any) => [m.id, m]));
    expect(byId[m2.id]).toMatchObject({ state: 'acknowledged', from: { agentId: 'claude-2@repo', alias: null }, to: 'claude-1@repo', body: 'two' });
    expect(byId[m1.id].state).toBe('queued');
    expect(byId[m1.id].from.alias).toBe('lead');
    expect(JSON.stringify(all.json())).not.toMatch(/token/i);

    const limited = await app.inject({ method: 'GET', url: '/api/w/default/intercom/messages?limit=1' });
    expect(limited.json().messages).toHaveLength(1);
    const since = await app.inject({ method: 'GET', url: `/api/w/default/intercom/messages?since=${m3.createdAt}` });
    const sinceIds = since.json().messages.map((m: any) => m.id);
    expect(sinceIds).toContain(m3.id);                                     // others sent in the same ms may legitimately appear
    expect(since.json().messages.every((m: any) => m.createdAt >= m3.createdAt)).toBe(true);
    const bad = await app.inject({ method: 'GET', url: '/api/w/default/intercom/messages?limit=201' });
    expect(bad.statusCode).toBe(400);

    const other = await app.inject({ method: 'GET', url: '/api/w/other/intercom/messages' });
    expect(other.statusCode).toBe(404);                                    // the /api/w prefix hook 404s an unconfigured workspace
  });

  it('GET /api/w/:ws/intercom/peers lists the workspace agents without tokens', async () => {
    await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
    const r = await app.inject({ method: 'GET', url: '/api/w/default/intercom/peers' });
    expect(r.statusCode).toBe(200);
    const peers = r.json().peers as Array<Record<string, unknown>>;
    expect(peers.map((p) => p.agentId)).toEqual(['claude-1@repo']);
    expect(peers[0]).toMatchObject({ mode: 'claude', worktreePath: repo, sessionId: '1' });
    expect(JSON.stringify(r.json())).not.toContain('token');
  });
});

describe('POST /api/intercom/hook', () => {
  let tokA: string;
  let tokB: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const hook = (tok: string, event: string, transport?: string) =>
    app.inject({ method: 'POST', url: '/api/intercom/hook', headers: auth(tok), payload: { event, ...(transport ? { transport } : {}) } });
  const send = (tok: string, to: string, body: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tok), payload: { to, body, ...extra } });
  const states = async () => Object.fromEntries((await app.inject({ method: 'GET', url: '/api/w/default/intercom/messages' })).json().messages.map((m: any) => [m.body, m.state]));

  beforeEach(async () => {
    await makeRepo();
    await boot();
    tokA = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
    tokB = (await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' })).token;
  });

  it('SessionStart with an empty inbox returns null context and no batch', async () => {
    const r = await hook(tokB, 'SessionStart');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ additionalContext: null, batchId: null, delivered: 0, acknowledged: 0 });
  });

  it('delivers as a batch; Stop acknowledges only after confirm; mid-turn arrivals stay queued', async () => {
    await send(tokA, 'claude-2@repo', 'first');
    await send(tokA, 'claude-2@repo', 'second', { kind: 'request' });
    const up = await hook(tokB, 'UserPromptSubmit');
    expect(up.statusCode).toBe(200);
    expect(up.json().delivered).toBe(2);
    expect(up.json().additionalContext).toContain('\nfirst\n');
    expect(up.json().additionalContext).toContain('\nsecond\n');
    expect(up.json().additionalContext).toContain('2 new messages');
    expect(up.json().additionalContext).toContain('"kind":"reply"');
    expect(up.json().additionalContext).not.toContain(tokB);
    const batchId = up.json().batchId as string;
    expect(batchId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await states()).toEqual({ first: 'delivered', second: 'delivered' });

    await send(tokA, 'claude-2@repo', 'third');                                   // arrives mid-turn

    const stopEarly = await hook(tokB, 'Stop');                                    // hook died before printing → no confirm
    expect(stopEarly.json()).toEqual({ additionalContext: null, batchId: null, delivered: 0, acknowledged: 0 });
    expect(await states()).toEqual({ first: 'delivered', second: 'delivered', third: 'queued' });

    const foreign = await app.inject({ method: 'POST', url: '/api/intercom/hook/confirm', headers: auth(tokA), payload: { batchId } });
    expect(foreign.json()).toEqual({ confirmed: 0 });
    const ok = await app.inject({ method: 'POST', url: '/api/intercom/hook/confirm', headers: auth(tokB), payload: { batchId } });
    expect(ok.json()).toEqual({ confirmed: 2 });

    const stop = await hook(tokB, 'Stop');
    expect(stop.json().acknowledged).toBe(2);
    expect(await states()).toEqual({ first: 'acknowledged', second: 'acknowledged', third: 'queued' });

    const next = await hook(tokB, 'UserPromptSubmit');
    expect(next.json().delivered).toBe(1);
    expect(next.json().additionalContext).toContain('1 new message ');
    expect(next.json().additionalContext).toContain('\nthird\n');
  });

  it('a later execution cannot acknowledge an earlier execution\'s confirmed batch', async () => {
    await send(tokA, 'claude-2@repo', 'old-exec');
    const up = await hook(tokB, 'UserPromptSubmit');
    await app.inject({ method: 'POST', url: '/api/intercom/hook/confirm', headers: auth(tokB), payload: { batchId: up.json().batchId } });
    await deps.agents.release(claudeKey(repo, '2'));
    const tokB2 = (await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' })).token;
    const stop = await hook(tokB2, 'Stop');
    expect(stop.json().acknowledged).toBe(0);
    expect(await states()).toEqual({ 'old-exec': 'delivered' });
  });

  it('claims only the prefix that fits the budget; the rest stay queued and are never acknowledged', async () => {
    for (let i = 0; i < 11; i++) await send(tokA, 'claude-2@repo', `${String(i).padStart(2, '0')}-${'y'.repeat(6 * 1024)}`);
    const up = await hook(tokB, 'UserPromptSubmit');
    const n = up.json().delivered as number;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(11);
    expect(Buffer.byteLength(up.json().additionalContext, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    const st = await states();
    expect(Object.values(st).filter((s) => s === 'delivered')).toHaveLength(n);
    expect(Object.values(st).filter((s) => s === 'queued')).toHaveLength(11 - n);
    // Oldest first: no queued message may be older than a delivered one (equal timestamps are allowed — same-ms sends have no defined order).
    const rows = (await app.inject({ method: 'GET', url: '/api/w/default/intercom/messages' })).json().messages as { state: string; createdAt: number }[];
    const newestDelivered = Math.max(...rows.filter((r) => r.state === 'delivered').map((r) => r.createdAt));
    expect(rows.filter((r) => r.state === 'queued').every((r) => r.createdAt >= newestDelivered)).toBe(true);
    await app.inject({ method: 'POST', url: '/api/intercom/hook/confirm', headers: auth(tokB), payload: { batchId: up.json().batchId } });
    expect((await hook(tokB, 'Stop')).json().acknowledged).toBe(n);
    expect(Object.values(await states()).filter((s) => s === 'queued')).toHaveLength(11 - n);
  });

  it('socket transport changes only the reply hint', async () => {
    await send(tokA, 'claude-2@repo', 'sock');
    const r = await hook(tokB, 'UserPromptSubmit', 'socket');
    expect(r.json().additionalContext).toContain('--unix-socket $STRADO_SERVER_SOCKET');
    expect(r.json().additionalContext).not.toContain('$STRADO_STATUS_PORT');
  });

  it('401 without a token, 400 on an unknown event or bad confirm body', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/intercom/hook', payload: { event: 'Stop' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/intercom/hook/confirm', payload: { batchId: 'x' } })).statusCode).toBe(401);
    const bad = await hook(tokB, 'Nope');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION');
    expect((await app.inject({ method: 'POST', url: '/api/intercom/hook/confirm', headers: auth(tokB), payload: {} })).statusCode).toBe(400);
  });
});

describe('POST /api/intercom/hook when disabled', () => {
  beforeEach(async () => {
    await makeRepo();
    await fs.mkdir(path.join(tmp, 'home', 'intercom.sqlite'), { recursive: true });
    await boot();
  });

  it('503 UNAVAILABLE', async () => {
    const tok = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
    const r = await app.inject({ method: 'POST', url: '/api/intercom/hook', headers: { authorization: `Bearer ${tok}` }, payload: { event: 'UserPromptSubmit' } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('UNAVAILABLE');
  });
});

describe('turn diary routes', () => {
  let tokA: string;
  let tokB: string;
  let agentHome: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const line = (role: 'user' | 'assistant', text: string, ts: string) =>
    JSON.stringify({ type: role, timestamp: ts, message: { role, content: [{ type: 'text', text }] } }) + '\n';

  beforeEach(async () => {
    await makeRepo();
    agentHome = path.join(tmp, 'agent-home');
    deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home'), agentHomeDir: agentHome });
    deps.terminal = createTerminalManager(() => ({ file: 'cat', args: [] }), undefined, undefined, undefined, deps.agents.envFor);
    app = await buildApp(deps);
    await app.inject({
      method: 'POST', url: '/api/w/default/repos',
      payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
    });
    tokA = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
    tokB = (await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' })).token;
    const dir = path.join(agentHome, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'sid-b.jsonl'),
      line('user', 'fix login', '2026-09-06T10:00:00.000Z') + line('assistant', 'Fixed the redirect.', '2026-09-06T10:00:09.000Z'));
  });

  const stop = () => app.inject({
    method: 'POST', url: '/api/claude/status',
    payload: { cwd: repo, status: 'idle', sessionId: '2', providerSessionId: 'sid-b' },
  });

  it('a Stop status post records the turn; a peer reads it by id or alias; unknown agent is 404', async () => {
    expect((await stop()).statusCode).toBe(200);
    await app.deps.turnDiary.settle();
    const r = await app.inject({ method: 'GET', url: '/api/intercom/diary?agent=claude-2@repo', headers: auth(tokA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().agent).toEqual({ agentId: 'claude-2@repo', alias: null });
    expect(r.json().turns).toEqual([expect.objectContaining({ agentId: 'claude-2@repo', turnIndex: 0, prompt: 'fix login', reply: 'Fixed the redirect.', providerSessionId: 'sid-b' })]);
    await deps.agents.setAlias('default', 'claude-2@repo', 'builder');
    const byAlias = await app.inject({ method: 'GET', url: '/api/intercom/diary?agent=builder', headers: auth(tokB) });
    expect(byAlias.json().agent).toEqual({ agentId: 'claude-2@repo', alias: 'builder' });
    expect(byAlias.json().turns).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/intercom/diary?agent=ghost', headers: auth(tokA) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/intercom/diary?agent=claude-2@repo' })).statusCode).toBe(401);
  });

  it('validates the query and pages with before; the scoped route mirrors the token route', async () => {
    await stop();
    await app.deps.turnDiary.settle();
    expect((await app.inject({ method: 'GET', url: '/api/intercom/diary', headers: auth(tokA) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/intercom/diary?agent=claude-2@repo&limit=51', headers: auth(tokA) })).statusCode).toBe(400);
    const first = (await app.inject({ method: 'GET', url: '/api/intercom/diary?agent=claude-2@repo&limit=1', headers: auth(tokA) })).json();
    const next = (await app.inject({ method: 'GET', url: `/api/intercom/diary?agent=claude-2@repo&before=${first.turns[0].id}`, headers: auth(tokA) })).json();
    expect(next.turns).toEqual([]);
    const scoped = await app.inject({ method: 'GET', url: '/api/w/default/intercom/diary?agent=claude-2@repo' });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toEqual(first);
  });

  it('every status except closed refreshes (Codex only ever posts waiting)', async () => {
    await app.inject({ method: 'POST', url: '/api/claude/status', payload: { cwd: repo, status: 'waiting', sessionId: '2', providerSessionId: 'sid-b' } });
    await app.deps.turnDiary.settle();
    expect(deps.intercom.listTurns('default', 'claude-2@repo', { limit: 5 })).toHaveLength(1);
    const r = await app.inject({ method: 'POST', url: '/api/claude/status', payload: { cwd: repo, status: 'closed', sessionId: '2', providerSessionId: 'sid-b' } });
    expect(r.statusCode).toBe(200);
    await app.deps.turnDiary.settle();
    expect(deps.intercom.listTurns('default', 'claude-2@repo', { limit: 5 })).toHaveLength(1);
  });
});

describe('push delivery', () => {
  let tokA: string;
  let keyB: string;
  let events: BusEvent[];
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const status = (s: 'idle' | 'working' | 'waiting') =>
    app.inject({ method: 'POST', url: '/api/claude/status', payload: { cwd: repo, status: s, sessionId: '2' } });
  const send = (body: string) =>
    app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'claude-2@repo', body } });
  const pushEvents = () => events.filter((e) => e.type.startsWith('push.')).map((e) => [e.type, (e.data as { reason?: string }).reason ?? '']);
  const sent = () => pushEvents().filter(([t]) => t === 'push.sent').length;
  // `cat` echoes stdin, and the PTY echoes keystrokes too, so the nudge shows up
  // in the snapshot more than once — count pushes by event, prove PTY arrival by containment.
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return pred();
  };

  beforeEach(async () => {
    await makeRepo();
    // No deps.terminal swap here: the pusher and the registry's liveness check
    // read the manager buildDeps created (in-process under STRADO_INPROC_PTY),
    // so tab B is a real PTY running `cat`.
    deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
    app = await buildApp(deps);
    await app.inject({
      method: 'POST', url: '/api/w/default/repos',
      payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
    });
    tokA = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
    keyB = claudeKey(repo, '2');
    await deps.terminal.ensure(keyB, repo, { file: 'cat', args: [] });
    await deps.agents.register({ key: keyB, cwd: repo, scopeId: 'default' });
    events = [];
    deps.bus.on(INTERCOM_CHANNEL, (e) => events.push(e));
  });
  afterEach(() => { deps.terminal.killUnder(repo); delete process.env.STRADO_INTERCOM_PUSH; });

  it('a Stop with a queued message writes exactly one nudge; a repeat Stop is already-pushed', async () => {
    await send('hello B');
    await deps.intercomPush.settle();
    expect(pushEvents()).toEqual([['push.skipped', 'not-idle']]);   // arrival before any status: tab is "starting", not idle
    expect((await status('idle')).statusCode).toBe(200);
    await deps.intercomPush.settle();
    expect(sent()).toBe(1);
    expect(await until(() => deps.terminal.snapshot(keyB).includes(NUDGE(1)))).toBe(true);
    await status('idle');
    await deps.intercomPush.settle();
    expect(sent()).toBe(1);
    expect(pushEvents()).toContainEqual(['push.skipped', 'already-pushed']);
  });

  it('working re-arms the marker; waiting never pushes; arrival while idle pushes', async () => {
    await status('idle');
    await deps.intercomPush.settle();
    expect(pushEvents()).toEqual([['push.skipped', 'inbox-empty']]);
    await send('one');                                              // arrival while idle
    await deps.intercomPush.settle();
    expect(sent()).toBe(1);
    await status('working');                                        // the nudged turn started
    await status('waiting');                                        // permission prompt mid-turn
    await send('two');
    await deps.intercomPush.settle();
    expect(sent()).toBe(1);
    expect(pushEvents()).toContainEqual(['push.skipped', 'not-idle']);
    await status('idle');
    await deps.intercomPush.settle();
    // The first nudge's echo reset the output clock, so this push goes through the
    // 1 s output-quiet retry: poll for it rather than asserting right after settle().
    expect(await until(() => sent() === 2)).toBe(true);
    expect(await until(() => deps.terminal.snapshot(keyB).includes(NUDGE(2)))).toBe(true);   // both still queued: nobody claimed them
  });

  it('a Codex tab is nudged with the MCP wording: on arrival while fresh, and again after its turn completes (step 5b)', async () => {
    const keyC = codexKey(repo, '1');
    await deps.terminal.ensure(keyC, repo, { file: 'cat', args: [] });
    await deps.agents.register({ key: keyC, cwd: repo, scopeId: 'default' });
    const codexStatus = (s: 'working' | 'waiting') =>
      app.inject({ method: 'POST', url: '/api/codex/status', payload: { cwd: repo, status: s, sessionId: '1' } });
    const sendC = (body: string) =>
      app.inject({ method: 'POST', url: '/api/intercom/messages', headers: auth(tokA), payload: { to: 'codex-1@repo', body } });
    await sendC('one');                                              // fresh tab, no status yet → 'starting' is reachable
    await deps.intercomPush.settle();
    expect(await until(() => sent() === 1)).toBe(true);
    expect(await until(() => deps.terminal.snapshot(keyC).includes(MCP_NUDGE(1)))).toBe(true);
    expect(pushEvents()).not.toContainEqual(['push.skipped', 'unsupported-mode']);
    await sendC('two');                                              // marker set: not pushed until the turn ends
    await deps.intercomPush.settle();
    expect(sent()).toBe(1);
    expect(pushEvents()).toContainEqual(['push.skipped', 'already-pushed']);
    expect((await codexStatus('waiting')).statusCode).toBe(200);     // turn complete: re-arm and look again
    expect(await until(() => sent() === 2)).toBe(true);
    expect(await until(() => deps.terminal.snapshot(keyC).includes(MCP_NUDGE(2)))).toBe(true);   // both still queued: nobody claimed them
  });

  it('recent keystrokes on the tab suppress the push', async () => {
    await send('x');
    deps.ptyActivity.noteInput(keyB);
    await status('idle');
    await deps.intercomPush.settle();
    expect(sent()).toBe(0);
    expect(pushEvents()).toContainEqual(['push.skipped', 'input-busy']);
  });

  it('the kill switch disables pushing without touching passive delivery', async () => {
    process.env.STRADO_INTERCOM_PUSH = '0';
    await send('x');
    await status('idle');
    await deps.intercomPush.settle();
    expect(sent()).toBe(0);
    expect(pushEvents()).toContainEqual(['push.skipped', 'disabled']);
    const tokB = deps.agents.byKey(keyB)!.token;
    const hook = await app.inject({ method: 'POST', url: '/api/intercom/hook', headers: auth(tokB), payload: { event: 'UserPromptSubmit' } });
    expect(hook.json().delivered).toBe(1);
  });

  it('push and passive delivery compose: the nudged turn receives the message once', async () => {
    await send('read me');
    await status('idle');
    await deps.intercomPush.settle();
    expect(sent()).toBe(1);
    const tokB = deps.agents.byKey(keyB)!.token;
    await status('working');
    const hook = await app.inject({ method: 'POST', url: '/api/intercom/hook', headers: auth(tokB), payload: { event: 'UserPromptSubmit' } });
    expect(hook.json().delivered).toBe(1);
    expect(hook.json().additionalContext).toContain('read me');
    expect(deps.intercom.peek('default', 'claude-2@repo', 10)).toEqual([]);
  });
});

/** Wait until an interactive shell has printed its first prompt, so the run's
 * write is not swallowed by a shell that is still starting up. macOS's native
 * PTY helper can take several seconds to attach after earlier terminals exit;
 * allow that startup time without relaxing any command execution assertions. */
async function atPrompt(key: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (/[$#%>]\s*$/.test(deps.terminal.snapshot(key))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no shell prompt in ${key}: ${JSON.stringify(deps.terminal.snapshot(key).slice(-200))}`);
}

describe('shell adapters', () => {
  let tokA: string;      // Claude tab: the caller
  let shellK: string;    // shell tab 1: the target, a real PTY running an interactive `sh`
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const run = (payload: unknown, tok = tokA) =>
    app.inject({ method: 'POST', url: '/api/intercom/shell/run', headers: auth(tok), payload });
  const read = (agent: string, qs = '', tok = tokA) =>
    app.inject({ method: 'GET', url: `/api/intercom/tabs/${agent}/read${qs}`, headers: auth(tok) });

  beforeEach(async () => {
    await makeRepo();
    // No deps.terminal swap: the runner and the registry's liveness check must
    // read the manager buildDeps created (in-process PTY under STRADO_INPROC_PTY).
    deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
    app = await buildApp(deps);
    await app.inject({
      method: 'POST', url: '/api/w/default/repos',
      payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
    });
    tokA = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
    shellK = shellKey(repo, '1');
    await deps.terminal.ensure(shellK, repo, { file: '/bin/sh', args: ['-i'] });
    await deps.agents.register({ key: shellK, cwd: repo, scopeId: 'default' });
    await atPrompt(shellK);
  }, 35_000);
  afterEach(() => { deps.terminal.killUnder(repo); delete process.env.STRADO_INTERCOM_SHELL_RUN; });

  it('runs a command in the shell tab and returns its output as soon as the sentinel lands', async () => {
    const res = await run({ target: 'shell-1@repo', command: 'echo hi' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ target: { agentId: 'shell-1@repo', alias: null }, settled: true });
    expect(res.json().output).toContain('\nhi');               // the result line, not just the echo
    expect(res.json().output).not.toContain(RUN_MARKER_PREFIX); // the sentinel never reaches the caller
    expect(res.json().durationMs).toBeLessThan(2000);           // no quiet window to wait out
    expect(res.json().output).not.toContain('\x1b');
  });

  it('settles on output that ends without a newline', async () => {
    const res = await run({ target: 'shell-1@repo', command: 'printf abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json().settled).toBe(true);
    expect(res.json().output.endsWith('abc')).toBe(true);      // the sentinel sat on the same line
    expect(res.json().output).not.toContain(RUN_MARKER_PREFIX);
    expect(res.json().durationMs).toBeLessThan(2000);
  });

  it('waits for a slow command instead of settling on a lull in its output', async () => {
    const res = await run({ target: 'shell-1@repo', command: 'sleep 1; echo done-slow', timeoutMs: 10000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().settled).toBe(true);
    expect(res.json().output).toContain('\ndone-slow');
    expect(res.json().durationMs).toBeGreaterThanOrEqual(1000);
  });

  it('read returns the last N cleaned lines of any live tab, clamped to READ_LINES_MAX', async () => {
    await run({ target: 'shell-1@repo', command: 'echo one' });
    const five = await read('shell-1@repo', '?lines=5');
    expect(five.statusCode).toBe(200);
    expect(five.json().target).toEqual({ agentId: 'shell-1@repo', alias: null });
    expect(five.json().status).toBe('running');
    expect(five.json().lines.length).toBeLessThanOrEqual(5);
    expect(five.json().lines.some((l: string) => l.includes('echo one'))).toBe(true);
    const many = await read('shell-1@repo', '?lines=999');
    expect(many.statusCode).toBe(200);
    expect(many.json().lines.length).toBeLessThanOrEqual(400);
    expect((await read('shell-1@repo', '?lines=0')).statusCode).toBe(400);
  });

  it('rejects a non-shell target, a target without a PTY, an unknown target, and another scope', async () => {
    const claude = await run({ target: 'claude-1@repo', command: 'echo x' });
    expect(claude.statusCode).toBe(400);
    expect(claude.json().error.message).toBe('target is not a shell tab');
    await deps.agents.register({ key: shellKey(repo, '2'), cwd: repo, scopeId: 'default' });   // registered, never spawned
    const dead = await run({ target: 'shell-2@repo', command: 'echo x' });
    expect(dead.statusCode).toBe(400);
    expect(dead.json().error.message).toBe('target is not live');
    expect((await run({ target: 'ghost', command: 'echo x' })).statusCode).toBe(404);
    const other = (await deps.agents.register({ key: claudeKey(repo, '9'), cwd: repo, scopeId: 'other' })).token;
    expect((await run({ target: 'shell-1@repo', command: 'echo x' }, other)).statusCode).toBe(404);
    // read: a live check too, and 404 for strangers
    expect((await read('claude-1@repo')).statusCode).toBe(400);
    expect((await read('ghost')).statusCode).toBe(404);
  });

  it('400 on a multi-line or empty command; 401 without a token', async () => {
    expect((await run({ target: 'shell-1@repo', command: 'echo a\necho b' })).statusCode).toBe(400);
    expect((await run({ target: 'shell-1@repo', command: '' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/intercom/shell/run', payload: { target: 'shell-1@repo', command: 'x' } })).statusCode).toBe(401);
  });

  it('409 INPUT_BUSY when the user typed recently; 409 BUSY while a run is in flight', async () => {
    deps.ptyActivity.noteInput(shellK);
    const typing = await run({ target: 'shell-1@repo', command: 'echo x' });
    expect(typing.statusCode).toBe(409);
    expect(typing.json().error).toMatchObject({ code: 'CONFLICT', details: { reason: 'INPUT_BUSY' } });
    deps.ptyActivity.forget(shellK);
    const inflight = deps.shellRunner.run(shellK, 'sleep 1', { timeoutMs: 5000 });
    const second = await run({ target: 'shell-1@repo', command: 'echo x' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.details).toEqual({ reason: 'BUSY' });
    await inflight;
  });

  it('settled is false when the command is still running at the cap', async () => {
    const res = await run({ target: 'shell-1@repo', command: 'sleep 5', timeoutMs: 1000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().settled).toBe(false);
    expect(res.json().durationMs).toBeGreaterThanOrEqual(1000);
    expect(res.json().durationMs).toBeLessThan(3000);
    // Interrupt the sleep so the tab is idle again (afterEach kills it anyway).
    deps.terminal.write(shellK, '\x03');
    await new Promise((r) => setTimeout(r, 300));
  });

  it('the kill switch answers 503 for run and leaves read alone', async () => {
    process.env.STRADO_INTERCOM_SHELL_RUN = '0';
    const res = await run({ target: 'shell-1@repo', command: 'echo x' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UNAVAILABLE');
    expect((await read('shell-1@repo')).statusCode).toBe(200);
  });

  it('a sandboxed caller reaches only tabs of its own worktree; an unsandboxed caller is unaffected', async () => {
    // A second worktree in the same workspace with its own live shell tab.
    const repo2 = path.join(tmp, 'repo2');
    await fs.mkdir(repo2);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo2 });
    const shellK2 = shellKey(repo2, '1');
    await deps.terminal.ensure(shellK2, repo2, { file: '/bin/sh', args: ['-i'] });
    const other = await deps.agents.register({ key: shellK2, cwd: repo2, scopeId: 'default' });
    await atPrompt(shellK2);
    try {
      // Unsandboxed caller: cross-worktree run and read are allowed.
      expect((await run({ target: other.agentId, command: 'echo x' })).statusCode).toBe(200);
      expect((await read(other.agentId)).statusCode).toBe(200);
      // Mark the caller's worktree sandboxed.
      deps.sandboxSlugs.set(repo, 'repo-sbx');
      const crossRun = await run({ target: other.agentId, command: 'echo x' });
      expect(crossRun.statusCode).toBe(403);
      expect(crossRun.json().error).toMatchObject({ code: 'FORBIDDEN' });
      expect((await read(other.agentId)).statusCode).toBe(403);
      // Same-worktree stays allowed from inside the sandbox.
      expect((await run({ target: 'shell-1@repo', command: 'echo same' })).statusCode).toBe(200);
      expect((await read('shell-1@repo')).statusCode).toBe(200);
    } finally {
      deps.terminal.killUnder(repo2);
    }
  });

  it('401 comes before the kill switch', async () => {
    process.env.STRADO_INTERCOM_SHELL_RUN = '0';
    const res = await app.inject({ method: 'POST', url: '/api/intercom/shell/run', payload: { target: 'shell-1@repo', command: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('emits shell.run on the intercom channel with no command or output text', async () => {
    const seen: BusEvent[] = [];
    const off = deps.bus.on(INTERCOM_CHANNEL, (e) => seen.push(e));
    await run({ target: 'shell-1@repo', command: 'echo secret-word' });
    off();
    const evt = seen.find((e) => e.type === 'shell.run');
    expect(evt).toBeDefined();
    expect(evt!.data).toMatchObject({ key: shellK, settled: true });
    expect(JSON.stringify(seen)).not.toContain('secret-word');
  });
});

describe('tasks and escalations routes', () => {
  let tokA: string; let tokB: string; let exA: { agentId: string; executionId: string };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const H = (t: string, extra: Record<string, string> = {}) => ({ ...auth(t), 'content-type': 'application/json', ...extra });

  beforeEach(async () => {
    await makeRepo();
    // No deps.terminal swap here (unlike boot()): the human-route "assign to a
    // live agent" test needs the registry's liveness check to see the same
    // manager a later deps.terminal.ensure() spawns into — see the "shell
    // adapters" and "push delivery" describes above for the same reasoning.
    deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
    app = await buildApp(deps);
    await app.inject({
      method: 'POST', url: '/api/w/default/repos',
      payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
    });
    const a = await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' });
    tokA = a.token; exA = { agentId: a.agentId, executionId: a.executionId };
    tokB = (await deps.agents.register({ key: claudeKey(repo, '2'), cwd: repo, scopeId: 'default' })).token;
  });

  it('401 without a token on every agent route; 503 when the kill switch is off', async () => {
    for (const c of [
      { method: 'POST', url: '/api/intercom/tasks', payload: { title: 'x' } },
      { method: 'GET', url: '/api/intercom/tasks' },
      { method: 'POST', url: '/api/intercom/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV/claim' },
      { method: 'POST', url: '/api/intercom/escalations', payload: { title: 'x', body: 'y' } },
      { method: 'GET', url: '/api/intercom/escalations/01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    ] as const) {
      const r = await app.inject({ ...c });
      expect(r.statusCode, c.url).toBe(401);
    }
    process.env.STRADO_INTERCOM_TASKS = '0';
    try {
      const r = await app.inject({ method: 'POST', url: '/api/intercom/tasks', headers: H(tokA), payload: { title: 'x' } });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toBe('tasks and escalations are disabled');
      const w = await app.inject({ method: 'GET', url: '/api/w/default/intercom/tasks' });
      expect(w.statusCode).toBe(503);
    } finally { process.env.STRADO_INTERCOM_TASKS = ''; }
  });

  it('create → list → claim → done as an agent; wrong owner 403; second claim 409 with reason', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/intercom/tasks', headers: H(tokA), payload: { title: 'add tests', body: 'for X', ticketKey: 'FLT-9' } });
    expect(c.statusCode).toBe(201);
    const id = c.json().task.id as string;
    expect(c.json().task.createdBy).toEqual(exA);
    const l = await app.inject({ method: 'GET', url: '/api/intercom/tasks?status=open', headers: auth(tokB) });
    expect(l.json().tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    const cl = await app.inject({ method: 'POST', url: `/api/intercom/tasks/${id}/claim`, headers: H(tokB), payload: {} });
    expect(cl.statusCode).toBe(200);
    expect(cl.json().task.claimedBy.agentId).toBe('claude-2@repo');
    const again = await app.inject({ method: 'POST', url: `/api/intercom/tasks/${id}/claim`, headers: H(tokA), payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.reason).toBe('already_claimed');
    const wrong = await app.inject({ method: 'POST', url: `/api/intercom/tasks/${id}/done`, headers: H(tokA), payload: {} });
    expect(wrong.statusCode).toBe(403);
    const mine = await app.inject({ method: 'GET', url: '/api/intercom/tasks?mine=1', headers: auth(tokB) });
    expect(mine.json().tasks).toHaveLength(1);
    const done = await app.inject({ method: 'POST', url: `/api/intercom/tasks/${id}/done`, headers: H(tokB), payload: {} });
    expect(done.json().task.status).toBe('done');
  });

  it('human routes: create, assign to a live agent (409 offline), cancel, release; 400 on a bad body', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/w/default/intercom/tasks', headers: { 'content-type': 'application/json' }, payload: { title: 'triage' } });
    expect(c.statusCode).toBe(201);
    expect(c.json().task.createdBy).toEqual({ agentId: 'human', executionId: 'human' });
    const id = c.json().task.id as string;
    const bad = await app.inject({ method: 'POST', url: '/api/w/default/intercom/tasks', headers: { 'content-type': 'application/json' }, payload: { title: '' } });
    expect(bad.statusCode).toBe(400);
    const off = await app.inject({ method: 'POST', url: `/api/w/default/intercom/tasks/${id}/assign`, headers: { 'content-type': 'application/json' }, payload: { agent: 'claude-2@repo' } });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.details.reason).toBe('agent_offline');
    await deps.terminal.ensure(claudeKey(repo, '2'), repo, { file: '/bin/sh', args: ['-i'] });
    const on = await app.inject({ method: 'POST', url: `/api/w/default/intercom/tasks/${id}/assign`, headers: { 'content-type': 'application/json' }, payload: { agent: 'claude-2@repo' } });
    expect(on.statusCode).toBe(200);
    expect(on.json().task.claimedBy.agentId).toBe('claude-2@repo');
    const rel = await app.inject({ method: 'POST', url: `/api/w/default/intercom/tasks/${id}/release`, payload: {} , headers: { 'content-type': 'application/json' } });
    expect(rel.json().task.status).toBe('open');
    const can = await app.inject({ method: 'POST', url: `/api/w/default/intercom/tasks/${id}/cancel`, payload: {}, headers: { 'content-type': 'application/json' } });
    expect(can.json().task.status).toBe('cancelled');
    const list = await app.inject({ method: 'GET', url: '/api/w/default/intercom/tasks' });
    expect(list.json().tasks[0].status).toBe('cancelled');
    deps.terminal.killUnder(repo);
  });

  it('a released execution loses its claims; a dead peer retargets open asks to the human', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/intercom/tasks', headers: H(tokB), payload: { title: 'x' } });
    const id = c.json().task.id as string;
    await app.inject({ method: 'POST', url: `/api/intercom/tasks/${id}/claim`, headers: H(tokB), payload: {} });
    const ask = await app.inject({ method: 'POST', url: '/api/intercom/escalations', headers: H(tokA), payload: { title: 'q', body: 'which?', to: 'claude-2@repo', timeoutMs: 60000 } });
    expect(ask.statusCode).toBe(201);
    expect(ask.json().escalation.to).toBe('claude-2@repo');
    await deps.agents.release(claudeKey(repo, '2'));
    await deps.agents.flush();
    expect(deps.intercom.getTask('default', id).status).toBe('open');
    expect(deps.intercom.getEscalation('default', ask.json().escalation.id).to).toBe('human');
  });

  it('reconcile at boot releases claims of executions whose terminal session died while the server was down', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/intercom/tasks', headers: H(tokB), payload: { title: 'x' } });
    const id = c.json().task.id as string;
    await app.inject({ method: 'POST', url: `/api/intercom/tasks/${id}/claim`, headers: H(tokB), payload: {} });
    await app.close();
    // Same homeStateDir: the persisted execution for claude-2 loads back in,
    // but this fresh terminal manager has no live session for its key, so
    // agents.reconcile() (called during buildDeps, before any route exists)
    // drops it — and the intercom store must already exist by then for
    // onDropped to release the claim into, or it never happens.
    deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
    app = await buildApp(deps);
    expect(deps.intercom.getTask('default', id).status).toBe('open');
  });

  it('escalation to the human: agent creates (no message), only the human resolves, resolution lands in the inbox and on SSE', async () => {
    const seen: string[] = [];
    const off = deps.bus.on('intercom', (evt) => { if (String(evt.type).startsWith('escalation.')) seen.push(evt.type); });
    const c = await app.inject({ method: 'POST', url: '/api/intercom/escalations', headers: H(tokA), payload: { title: 'db?', body: 'pg or sqlite', context: [{ kind: 'text', value: 'ctx' }] } });
    expect(c.statusCode).toBe(201);
    const id = c.json().escalation.id as string;
    const byAgent = await app.inject({ method: 'POST', url: `/api/intercom/escalations/${id}/resolve`, headers: H(tokB), payload: { resolution: 'no' } });
    expect(byAgent.statusCode).toBe(403);
    const own = await app.inject({ method: 'GET', url: `/api/intercom/escalations/${id}`, headers: auth(tokA) });
    expect(own.json().escalation.status).toBe('open');
    const notMine = await app.inject({ method: 'GET', url: `/api/intercom/escalations/${id}`, headers: auth(tokB) });
    expect(notMine.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/intercom/escalations?status=open' });
    expect(list.json().escalations[0]).toMatchObject({ id, body: 'pg or sqlite', context: [{ kind: 'text', value: 'ctx' }] });
    const res = await app.inject({ method: 'POST', url: `/api/w/default/intercom/escalations/${id}/resolve`, headers: { 'content-type': 'application/json' }, payload: { resolution: 'sqlite' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().escalation).toMatchObject({ status: 'resolved', resolvedBy: 'human' });
    const inbox = await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: H(tokA), payload: {} });
    expect(inbox.json().messages[0]).toMatchObject({ from: { agentId: 'human', alias: null }, kind: 'message', body: 'sqlite', escalationId: id });
    expect(seen).toEqual(['escalation.opened', 'escalation.resolved']);
    off();
    const dis = await app.inject({ method: 'POST', url: `/api/w/default/intercom/escalations/${id}/dismiss`, payload: {}, headers: { 'content-type': 'application/json' } });
    expect(dis.statusCode).toBe(409);
  });

  it('send to "human" is a 400 pointing at intercom_escalate; alias "human" is refused', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: H(tokA), payload: { to: 'human', body: 'hi' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('use intercom_escalate to reach the human (or kind=reply to answer a question the human asked you)');
    await expect(deps.agents.setAlias('default', 'claude-1@repo', 'human')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('GET /events/intercom streams task and escalation events, filtered by ws, and no message events', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/events/intercom?ws=default`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const chunks: string[] = [];
    const readUntil = async (needle: string) => { for (let i = 0; i < 20 && !chunks.join('').includes(needle); i++) { const { value } = await reader.read(); if (value) chunks.push(Buffer.from(value).toString()); } };
    deps.intercom.createTask({ scopeId: 'other', by: HUMAN, title: 'elsewhere' });
    await app.inject({ method: 'POST', url: '/api/intercom/tasks', headers: H(tokA), payload: { title: 'streamed' } });
    await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: H(tokA), payload: { to: 'claude-2@repo', body: 'not on the wire' } });
    await app.inject({ method: 'POST', url: '/api/intercom/escalations', headers: H(tokA), payload: { title: 'e', body: 'b' } });
    await readUntil('escalation.opened');
    const text = chunks.join('');
    expect(text).toContain('event: task.created');
    expect(text).toContain('"title":"streamed"');
    expect(text).toContain('event: escalation.opened');
    expect(text).not.toContain('message.queued');
    expect(text).not.toContain('not on the wire');
    // Only a scope-level "refetch" signal: no ids, parties or body.
    expect(text).toContain('event: feed.changed\ndata: {"scopeId":"default"}');
    expect(text).not.toContain('claude-2@repo');
    expect(text).not.toContain('elsewhere'); // a different workspace's task is excluded by the ws filter
    ac.abort();
  });

  it("GET /events/intercom names an answer to the human's question (ids only, never the body)", async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/events/intercom?ws=default`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const chunks: string[] = [];
    const readUntil = async (needle: string) => { for (let i = 0; i < 20 && !chunks.join('').includes(needle); i++) { const { value } = await reader.read(); if (value) chunks.push(Buffer.from(value).toString()); } };
    const { receipt } = deps.intercom.send({ scopeId: 'default', fromAgentId: HUMAN.agentId, fromExecutionId: HUMAN.executionId, toAgentId: 'claude-1@repo', kind: 'request', replyTo: null, body: 'do the tests pass?', context: [], idempotencyKey: null, expiresInMs: null });
    const r = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: H(tokA), payload: { to: 'human', kind: 'reply', replyTo: receipt.id, body: 'secret-ish answer text' } });
    expect(r.statusCode).toBe(201);
    await readUntil(`"replyTo":"${receipt.id}"`);
    const text = chunks.join('');
    expect(text).toContain(`event: message.queued\ndata: {"id":"${r.json().id}","scopeId":"default","from":"claude-1@repo","to":"human","kind":"reply","replyTo":"${receipt.id}"}`);
    expect(text).not.toContain('do the tests pass?');
    expect(text).not.toContain('secret-ish answer text');
    ac.abort();
  });
});

describe('reserved names and peer events', () => {
  let tokA: string;
  const H = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

  beforeEach(async () => {
    await makeRepo();
    deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
    app = await buildApp(deps);
    await app.inject({
      method: 'POST', url: '/api/w/default/repos',
      payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
    });
    tokA = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
  });
  afterEach(() => { deps.terminal.killUnder(repo); });

  it('"strado" is reserved: refused as an alias, unresolvable as a peer or message target', async () => {
    const toStrado = await app.inject({ method: 'POST', url: '/api/intercom/messages', headers: H(tokA), payload: { to: 'strado', body: 'hi' } });
    expect(toStrado.statusCode).toBe(404);

    await expect(deps.agents.setAlias('default', 'claude-1@repo', 'strado')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(deps.agents.resolve('default', 'strado')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const peers = await app.inject({ method: 'GET', url: '/api/intercom/peers', headers: H(tokA) });
    expect(peers.json().peers.map((p: any) => p.agentId)).not.toContain('strado');
  });

  it('GET /events/intercom carries peer.registered and peer.dropped (ids only), filtered by ws', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/events/intercom?ws=default`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const chunks: string[] = [];
    const readUntil = async (needle: string) => { for (let i = 0; i < 20 && !chunks.join('').includes(needle); i++) { const { value } = await reader.read(); if (value) chunks.push(Buffer.from(value).toString()); } };
    await deps.agents.register({ key: shellKey('/elsewhere', '9'), cwd: '/elsewhere', scopeId: 'other' });
    const ex = await deps.agents.register({ key: shellKey(repo, '7'), cwd: repo, scopeId: 'default' });
    await readUntil('peer.registered');
    await deps.agents.release(shellKey(repo, '7'));
    await readUntil('peer.dropped');
    const text = chunks.join('');
    expect(text).toContain('event: peer.registered');
    expect(text).toContain('event: peer.dropped');
    expect(text).toContain(`"agentId":"${ex.agentId}"`);
    expect(text).not.toContain(ex.token);
    expect(text).not.toContain('"scopeId":"other"');
    ac.abort();
  });
});
