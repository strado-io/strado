import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';
import { claudeKey, shellKey } from '../../src/services/terminalManager';
import { assertHubRequest, normaliseUrl, promptLine, refKey } from '../../src/routes/appControl';
import { createUiClients, type UiCommand } from '../../src/services/uiClients';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let deps: Awaited<ReturnType<typeof buildDeps>>;
let tok: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function makeRepo(): Promise<void> {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-appcontrol-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a'), '1');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });
}

beforeEach(async () => {
  await makeRepo();
  deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  // No deps.terminal swap: the shell runner and the registry's liveness check
  // read the manager buildDeps created (in-process PTY under STRADO_INPROC_PTY).
  app = await buildApp(deps);
  await app.inject({
    method: 'POST', url: '/api/w/default/repos',
    payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
  });
  // The caller: a live Claude tab (cat stands in for the harness).
  await deps.terminal.ensure(claudeKey(repo, '1'), repo, { file: 'cat', args: [] });
  tok = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
});

afterEach(async () => {
  delete process.env.STRADO_MCP_APP_CONTROL;
  app.deps.terminal.killUnder(tmp);
  await vi.waitFor(() => expect(app.deps.terminal.liveSessions().filter((s) => s.path.startsWith(tmp + path.sep))).toEqual([]), { timeout: 5000 });
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A fake hub window: registers with uiClients and acks every command with `answer`. */
function fakeWindow(answer: (cmd: UiCommand) => { applied: boolean; reason?: string; result?: Record<string, unknown> } | null) {
  const got: UiCommand[] = [];
  deps.uiClients.connect({
    clientId: 'win-1', wsId: 'default', remote: false,
    send: (cmd) => {
      got.push(cmd);
      const a = answer(cmd);
      if (a) queueMicrotask(() => deps.uiClients.ack('default', 'win-1', cmd.id, a));
    },
  });
  deps.uiClients.report('default', 'win-1', { focused: true, worktreePath: repo, visibleKeys: [refKey({ worktreePath: repo, mode: 'claude', sessionId: '1' })], layout: null });
  return got;
}

const spawn = (payload: Record<string, unknown>, t = tok) =>
  app.inject({ method: 'POST', url: '/api/intercom/agents/spawn', headers: auth(t), payload });

describe('app control: agent_spawn', () => {
  it('401 without a token, 503 when switched off', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/intercom/agents/spawn', payload: { mode: 'shell' } })).statusCode).toBe(401);
    process.env.STRADO_MCP_APP_CONTROL = '0';
    expect((await spawn({ mode: 'shell' })).statusCode).toBe(503);
  });

  it('opens a shell tab, places it right of the caller, and runs the command', async () => {
    const got = fakeWindow(() => ({ applied: true }));
    const res = await spawn({ mode: 'shell', command: 'echo hello-from-spawn' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.agent).toMatchObject({ mode: 'shell', worktreePath: repo });
    expect(body.placement).toEqual({ applied: true, clientId: 'win-1' });
    expect(body.command.output).toContain('hello-from-spawn');
    expect(got[0]).toEqual({ id: expect.any(String), op: 'place', args: { tab: { worktreePath: repo, mode: 'shell', sessionId: '1' }, split: 'right', anchor: { worktreePath: repo, mode: 'claude', sessionId: '1' }, focus: false } });
    expect(deps.terminal.liveSessions().some((s) => s.mode === 'shell' && s.path === repo)).toBe(true);
  }, 30_000);

  it('places a second shell below the first by anchor', async () => {
    const got = fakeWindow(() => ({ applied: true }));
    const first = (await spawn({ mode: 'shell', place: null })).json();
    expect(first.placement).toEqual({ applied: false, reason: 'not_requested' });
    const second = await spawn({ mode: 'shell', place: { split: 'down', anchor: first.agent.agentId } });
    expect(second.statusCode).toBe(201);
    expect(got).toHaveLength(1);
    expect(got[0]!.args).toEqual({ split: 'down', anchor: { worktreePath: repo, mode: 'shell', sessionId: '1' }, tab: { worktreePath: repo, mode: 'shell', sessionId: '2' }, focus: false });
  }, 30_000);

  it('still spawns with no window open, reporting no_window', async () => {
    const res = await spawn({ mode: 'shell' });
    expect(res.statusCode).toBe(201);
    expect(res.json().placement).toEqual({ applied: false, reason: 'no_window' });
  }, 30_000);

  it('rejects an unknown anchor before spawning anything', async () => {
    const res = await spawn({ mode: 'shell', place: { split: 'down', anchor: 'nobody' } });
    expect(res.statusCode).toBe(404);
    expect(deps.terminal.liveSessions().some((s) => s.mode === 'shell')).toBe(false);
  });

  it('validates command/prompt against mode and a foreign worktreePath', async () => {
    expect((await spawn({ mode: 'claude', command: 'ls' })).statusCode).toBe(400);
    expect((await spawn({ mode: 'shell', prompt: 'hi' })).statusCode).toBe(400);
    expect((await spawn({ mode: 'shell', command: 'a\nb' })).statusCode).toBe(400);
    expect((await spawn({ mode: 'shell', worktreePath: '/etc' })).statusCode).toBe(400);
  });

  it('replays the same response for the same idempotency key', async () => {
    const a = await spawn({ mode: 'shell', place: null, idempotencyKey: 'k1' });
    const b = await spawn({ mode: 'shell', place: null, idempotencyKey: 'k1' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(deps.terminal.liveSessions().filter((s) => s.mode === 'shell')).toHaveLength(1);
  }, 30_000);

  it('an agent opened by agent_spawn cannot open more (depth 1)', async () => {
    const child = (await spawn({ mode: 'shell', place: null })).json();
    const childTok = deps.agents.byKey(shellKey(repo, '1'))!.token;
    expect(child.agent.agentId).toBe(deps.agents.byKey(shellKey(repo, '1'))!.agentId);
    const res = await spawn({ mode: 'shell', place: null }, childTok);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toMatchObject({ reason: 'spawn_depth' });
  }, 30_000);

  it('rate-limits spawns per caller', async () => {
    for (let i = 0; i < 6; i += 1) expect((await spawn({ mode: 'shell', place: null })).statusCode).toBe(201);
    const res = await spawn({ mode: 'shell', place: null });
    expect(res.statusCode).toBe(429);
  }, 60_000);
});

describe('app control: review fixes', () => {
  it('same idempotency key with a different body is a 409', async () => {
    expect((await spawn({ mode: 'shell', place: null, idempotencyKey: 'k2' })).statusCode).toBe(201);
    const res = await spawn({ mode: 'shell', place: null, command: 'echo x', idempotencyKey: 'k2' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ reason: 'idempotency_mismatch' });
  }, 30_000);

  it('parallel spawns cannot exceed the per-minute rate', async () => {
    const all = await Promise.all(Array.from({ length: 9 }, () => spawn({ mode: 'shell', place: null })));
    expect(all.filter((r) => r.statusCode === 201)).toHaveLength(6);
    expect(all.filter((r) => r.statusCode === 429)).toHaveLength(3);
  }, 60_000);

  it('a spawned tab may not run_in_shell into other shells', async () => {
    const shellK = shellKey(repo, '9');
    await deps.terminal.ensure(shellK, repo, { file: '/bin/sh', args: ['-i'] });
    await deps.agents.register({ key: shellK, cwd: repo, scopeId: 'default' });
    await spawn({ mode: 'shell', place: null });
    const childTok = deps.agents.byKey(shellKey(repo, '10'))!.token;
    const run = await app.inject({ method: 'POST', url: '/api/intercom/shell/run', headers: auth(childTok), payload: { target: 'shell-9@repo', command: 'echo hi' } });
    expect(run.statusCode).toBe(403);
    // The human's own caller is not affected.
    const ok = await app.inject({ method: 'POST', url: '/api/intercom/shell/run', headers: auth(tok), payload: { target: 'shell-9@repo', command: 'echo hi' } });
    expect(ok.statusCode).toBe(200);
  }, 60_000);

  it('a sandboxed tab cannot read another worktree agent status', async () => {
    const other = path.join(tmp, 'other');
    await deps.terminal.ensure(claudeKey(other, '1'), tmp, { file: 'cat', args: [] }).catch(() => undefined);
    await deps.agents.register({ key: claudeKey(other, '1'), cwd: other, scopeId: 'default' });
    deps.sandboxSlugs.set(repo, 'repo-sbx');
    try {
      const res = await app.inject({ method: 'GET', url: '/api/intercom/agents/claude-1@other/status', headers: auth(tok) });
      expect(res.statusCode).toBe(403);
      const own = await app.inject({ method: 'GET', url: '/api/intercom/agents/claude-1@repo/status', headers: auth(tok) });
      expect(own.statusCode).toBe(200);
    } finally { deps.sandboxSlugs.delete(repo); }
  });

  it('preview_open refuses the Strado server itself', async () => {
    fakeWindow(() => ({ applied: true }));
    const res = await app.inject({ method: 'POST', url: '/api/intercom/ui/browser', headers: auth(tok), payload: { url: `localhost:${process.env.PORT ?? 7777}` } });
    expect(res.statusCode).toBe(403);
  });

  it('the window channel refuses foreign origins and hosts; a relayed window is remote', async () => {
    const evil = await app.inject({ method: 'POST', url: '/api/w/default/ui/clients/x/state', headers: { origin: 'https://evil.example' }, payload: { focused: true, worktreePath: null, visible: [] } });
    expect(evil.statusCode).toBe(403);
    expect(() => assertHubRequest({ host: 'rebind.example:7777' })).toThrow();
    expect(() => assertHubRequest({ host: '127.0.0.1:7777', origin: 'http://localhost:5173' })).not.toThrow();
    expect(() => assertHubRequest({ host: 'localhost:7777', origin: 'null' })).toThrow();
    expect(() => assertHubRequest({ host: '127.0.0.1:7777' })).not.toThrow();
  });
});

describe('app control: ui_place, browser, state, status', () => {
  it('ui_place resolves target and anchor and dispatches one command', async () => {
    const got = fakeWindow(() => ({ applied: true }));
    await spawn({ mode: 'shell', place: null });
    const res = await app.inject({ method: 'POST', url: '/api/intercom/ui/place', headers: auth(tok), payload: { target: 'shell-1@repo', split: 'tab', focus: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true, clientId: 'win-1' });
    expect(got[0]!.args).toEqual({ tab: { worktreePath: repo, mode: 'shell', sessionId: '1' }, split: 'tab', focus: true, anchor: { worktreePath: repo, mode: 'claude', sessionId: '1' } });
  }, 30_000);

  it('preview_open normalises the url and returns the window tab id', async () => {
    const got = fakeWindow((c) => (c.op === 'browser.open' ? { applied: true, result: { tabId: '2' } } : null));
    const res = await app.inject({ method: 'POST', url: '/api/intercom/ui/browser', headers: auth(tok), payload: { url: 'google.com' } });
    expect(res.json()).toEqual({ applied: true, url: 'https://google.com/', tabId: '2' });
    expect(got[0]).toMatchObject({ op: 'browser.open', args: { worktreePath: repo, url: 'https://google.com/' } });
    const bad = await app.inject({ method: 'POST', url: '/api/intercom/ui/browser', headers: auth(tok), payload: { url: 'javascript:alert(1)' } });
    expect(bad.statusCode).toBe(400);
  });

  it('a window that never acks times out without failing the call', async () => {
    deps.uiClients = createUiClients({ ackTimeoutMs: 50 });
    fakeWindow(() => null);
    const res = await app.inject({ method: 'POST', url: '/api/intercom/ui/browser', headers: auth(tok), payload: { url: 'https://example.com' } });
    expect(res.json()).toEqual({ applied: false, reason: 'timeout', url: 'https://example.com/' });
  });

  it('ui_state lists windows and what they show', async () => {
    fakeWindow(() => ({ applied: true }));
    const res = await app.inject({ method: 'GET', url: '/api/intercom/ui/state', headers: auth(tok) });
    expect(res.json()).toMatchObject({ target: 'win-1', clients: [{ clientId: 'win-1', focused: true, worktreePath: repo, visible: [{ agentId: 'claude-1@repo', mode: 'claude' }] }] });
  });

  it('agent status reports lifecycle and the last turn', async () => {
    await spawn({ mode: 'shell', place: null });
    const res = await app.inject({ method: 'GET', url: '/api/intercom/agents/shell-1@repo/status', headers: auth(tok) });
    expect(res.json()).toMatchObject({ agentId: 'shell-1@repo', mode: 'shell', live: true, lastTurn: null });
  }, 30_000);

  it('the window state route maps TabRefs so anchors match', async () => {
    deps.uiClients.connect({ clientId: 'win-abcdef', wsId: 'default', remote: false, send: () => {} });
    const st = await app.inject({ method: 'POST', url: '/api/w/default/ui/clients/win-abcdef/state', payload: { focused: true, worktreePath: repo, visible: [{ worktreePath: repo, mode: 'claude', sessionId: '1' }] } });
    expect(st.statusCode).toBe(200);
    expect(deps.uiClients.pick('default', refKey({ worktreePath: repo, mode: 'claude', sessionId: '1' }))?.clientId).toBe('win-abcdef');
  });

  it('window routes: state for an unknown client is 404; ack needs the client header', async () => {
    const st = await app.inject({ method: 'POST', url: '/api/w/default/ui/clients/nope/state', payload: { focused: true, worktreePath: null, visible: [] } });
    expect(st.statusCode).toBe(404);
    const ack = await app.inject({ method: 'POST', url: '/api/w/default/ui/commands/x/ack', payload: { applied: true } });
    expect(ack.json()).toEqual({ accepted: false });
  });
});

describe('helpers', () => {
  it('normaliseUrl', () => {
    expect(normaliseUrl('google.com')).toBe('https://google.com/');
    expect(normaliseUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(normaliseUrl('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    expect(() => normaliseUrl('file:///etc/passwd')).toThrow();
  });
  it('promptLine strips control characters (ESC, Ctrl-C, shift-tab)', () => {
    expect(promptLine('a\x1b[Zb\x03c\td\x9be', 'x')).toBe('a[Zbc de (Asked by x via Strado; when done, tell it with intercom_send to=x.)');
  });
  it('normaliseUrl blocks the given loopback ports only', () => {
    expect(() => normaliseUrl('localhost:7777', new Set([7777]))).toThrow();
    expect(() => normaliseUrl('http://127.0.0.1:7777/api', new Set([7777]))).toThrow();
    expect(normaliseUrl('localhost:3000', new Set([7777]))).toBe('http://localhost:3000/');
    expect(normaliseUrl('https://example.com:7777', new Set([7777]))).toBe('https://example.com:7777/');
  });
  it('promptLine flattens newlines and names the asker', () => {
    expect(promptLine('fix\n\nthe bug', 'claude-1@repo')).toBe('fix the bug (Asked by claude-1@repo via Strado; when done, tell it with intercom_send to=claude-1@repo.)');
  });
});
