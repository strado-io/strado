import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import type { FocusJarvisRunner } from '../../src/routes/focusJarvis';
import type { ChatEntry } from '../../src/services/jarvisChat/types';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let calls: Array<[string, ...unknown[]]>;
let focusId: string;
/** Runs after runner.stop resolves, as a real turn's last write does. */
let lateWrite: (() => Promise<unknown>) | null;

const local = { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000' };
const base = () => `/api/w/default/focuses/${focusId}/jarvis`;
const post = (url: string, payload: unknown, headers: Record<string, string> = local) =>
  app.inject({ method: 'POST', url, headers, payload: payload as object });
const store = async () => (await app.deps.registry.get('default')).jarvis;

const context = {
  worktree: null, focused: null, tabs: [], worktrees: [], focus: null, focuses: [],
  scripts: [], packageManager: 'npm', agents: [],
};

/** Records calls; send appends the user entry the way the real runner does. */
function fakeRunner(): FocusJarvisRunner {
  return {
    async send(ws, id, input) {
      calls.push(['send', ws, id, input.text, input.windowId]);
      return (await store()).append(id, { type: 'user', text: input.text, windowId: input.windowId });
    },
    async approve(ws, id, entryId, input) {
      calls.push(['approve', ws, id, entryId, input.approve]);
    },
    async stop(ws, id) {
      calls.push(['stop', ws, id]);
      const late = lateWrite;
      if (late) setTimeout(() => void late().catch(() => undefined), 0);
    },
    /** Like the real one: the turn's last writes land before it resolves. */
    async forget(ws, id) {
      calls.push(['forget', ws, id]);
      if (lateWrite) await lateWrite();
    },
  };
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-focus-jarvis-')));
  calls = [];
  lateWrite = null;
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp({ ...deps, jarvis: fakeRunner() });
  const res = await post('/api/w/default/focuses', { name: 'Login fix' });
  expect(res.statusCode).toBe(200);
  focusId = res.json().focus.id;
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET log', () => {
  it('GET log returns entries and meta', async () => {
    const s = await store();
    const a = await s.append(focusId, { type: 'user', text: 'hi', windowId: 'w' });
    const b = await s.append(focusId, { type: 'jarvis', turnId: 't', text: 'hello', done: true });
    const res = await app.inject({ method: 'GET', url: base() });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.map((e: ChatEntry) => e.id)).toEqual([a.id, b.id]);
    expect(res.json().meta).toMatchObject({ focusId, agent: 'claude', sessionId: null, running: false, pendingApprovals: 0 });
    const older = await app.inject({ method: 'GET', url: `${base()}?before=${b.id}&limit=5` });
    expect(older.json().entries.map((e: ChatEntry) => e.id)).toEqual([a.id]);
    expect((await app.inject({ method: 'GET', url: `${base()}?limit=0` })).statusCode).toBe(400);
  });

  it('unknown focus 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/w/default/focuses/nope/jarvis' })).statusCode).toBe(404);
    expect((await post('/api/w/default/focuses/nope/jarvis/messages', { text: 'x', windowId: 'w', context })).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('POST message', () => {
  it('POST message 202 and calls runner.send', async () => {
    const res = await post(`${base()}/messages`, { text: 'open a shell in api', windowId: 'w1', context });
    expect(res.statusCode).toBe(202);
    expect(res.json().entry).toMatchObject({ type: 'user', text: 'open a shell in api' });
    expect(calls).toEqual([['send', 'default', focusId, 'open a shell in api', 'w1']]);
  });

  it('two windows posting at once: both accepted, both handed to the runner (it queues them)', async () => {
    const [a, b] = await Promise.all([
      post(`${base()}/messages`, { text: 'first', windowId: 'w1', context }),
      post(`${base()}/messages`, { text: 'second', windowId: 'w2', context }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(calls.map((c) => c[3]).sort()).toEqual(['first', 'second']);
    expect((await app.inject({ method: 'GET', url: base() })).json().entries).toHaveLength(2);
  });

  it('a secret in a message is redacted in the reply, the log and on disk', async () => {
    const res = await post(`${base()}/messages`, { text: 'deploy with token=abc123', windowId: 'w1', context });
    expect(res.json().entry.text).toBe('deploy with token=[redacted]');
    expect(JSON.stringify((await app.inject({ method: 'GET', url: base() })).json())).not.toContain('abc123');
    const raw = await fs.readFile(path.join(app.deps.registry.workspaceDir('default'), 'jarvis', `${focusId}.jsonl`), 'utf8');
    expect(raw).not.toContain('abc123');
  });

  it('bad bodies 400: empty, too long, extra keys, no context', async () => {
    expect((await post(`${base()}/messages`, { text: '', windowId: 'w', context })).statusCode).toBe(400);
    expect((await post(`${base()}/messages`, { text: 'x'.repeat(16 * 1024 + 1), windowId: 'w', context })).statusCode).toBe(400);
    expect((await post(`${base()}/messages`, { text: 'x', windowId: 'w', context, extra: 1 })).statusCode).toBe(400);
    expect((await post(`${base()}/messages`, { text: 'x', windowId: 'w' })).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses a relayed window and a foreign origin', async () => {
    const body = { text: 'x', windowId: 'w', context };
    expect((await post(`${base()}/messages`, body, { host: '127.0.0.1:4000', 'x-strado-via': 'relay' })).statusCode).toBe(403);
    expect((await post(`${base()}/messages`, body, { host: '127.0.0.1:4000', origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post(`${base()}/stop`, {}, { host: '127.0.0.1:4000', 'x-strado-via': 'relay' })).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('stop, approvals, agent', () => {
  it('POST stop 204 and calls runner.stop', async () => {
    expect((await post(`${base()}/stop`, {})).statusCode).toBe(204);
    expect(calls).toEqual([['stop', 'default', focusId]]);
  });

  it('approve unknown entry 404; a non-approval entry 404', async () => {
    const u = await (await store()).append(focusId, { type: 'user', text: 'hi', windowId: 'w' });
    expect((await post(`${base()}/approvals/nope`, { approve: true, windowId: 'w', context })).statusCode).toBe(404);
    expect((await post(`${base()}/approvals/${u.id}`, { approve: true, windowId: 'w', context })).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it('approve non-pending 409; pending 202 calls runner.approve', async () => {
    const s = await store();
    const done = await s.append(focusId, { type: 'approval', turnId: 't', action: 'shell.run', args: {}, summary: 'Run ls', state: 'declined' });
    const open = await s.append(focusId, { type: 'approval', turnId: 't', action: 'shell.run', args: {}, summary: 'Run ls', state: 'pending' });
    expect((await post(`${base()}/approvals/${done.id}`, { approve: true, windowId: 'w', context })).statusCode).toBe(409);
    expect((await post(`${base()}/approvals/${open.id}`, { approve: false, windowId: 'w', context })).statusCode).toBe(202);
    expect(calls).toEqual([['approve', 'default', focusId, open.id, false]]);
  });

  it('after a restart mid-turn: the turn reads interrupted, a pending approval is still approvable', async () => {
    const s = await store();
    await s.append(focusId, { type: 'turn', turnId: 't1', state: 'running' });
    const ap = await s.append(focusId, { type: 'approval', turnId: 't1', action: 'shell.run', args: { command: 'ls' }, summary: 'Run ls', state: 'pending' });
    await app.close();
    const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
    app = await buildApp({ ...deps, jarvis: fakeRunner() });
    const log = (await app.inject({ method: 'GET', url: base() })).json();
    expect(log.entries[0]).toMatchObject({ type: 'turn', state: 'interrupted' });
    expect(log.meta).toMatchObject({ running: false, pendingApprovals: 1 });
    expect((await post(`${base()}/approvals/${ap.id}`, { approve: true, windowId: 'w', context })).statusCode).toBe(202);
    expect(calls).toEqual([['approve', 'default', focusId, ap.id, true]]);
  });

  it('PUT agent: same agent is a no-op; an unknown one 400', async () => {
    const res = await app.inject({ method: 'PUT', url: `${base()}/agent`, headers: local, payload: { agent: 'claude' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ focusId, agent: 'claude' });
    expect(await (await store()).page(focusId, {})).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: `${base()}/agent`, headers: local, payload: { agent: 'emacs' } })).statusCode).toBe(400);
  });
});

describe('SSE', () => {
  async function open(url: string) {
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { signal: ac.signal });
    return { res, ac };
  }

  /** Reads until `want` events have arrived (or the stream ends). */
  async function events(res: Response, want: number): Promise<Array<{ event: string; data: unknown }>> {
    const reader = res.body!.getReader();
    const out: Array<{ event: string; data: unknown }> = [];
    let buf = '';
    while (out.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
      }
    }
    reader.releaseLock();
    return out;
  }

  it('SSE sends entry events on append', async () => {
    const { res, ac } = await open(`${base()}/events`);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const first = await events(res, 1);
    expect(first[0]).toMatchObject({ event: 'meta', data: { focusId } });
    const s = await store();
    await s.append('someoneelse', { type: 'event', text: 'not mine' });
    await s.append(focusId, { type: 'user', text: 'hi', windowId: 'w' });
    await s.append(focusId, { type: 'turn', turnId: 't', state: 'running' });
    const got = await events(res, 3);
    expect(got.map((e) => e.event)).toEqual(['entry', 'entry', 'meta']);
    expect(got[0]!.data).toMatchObject({ type: 'user', text: 'hi' });
    expect(got[2]!.data).toMatchObject({ running: true });
    ac.abort();
  });

  it('delete focus mid-turn: the turn\'s late last write does not bring the chat back', async () => {
    const s = await store();
    const turn = await s.append(focusId, { type: 'turn', turnId: 't1', state: 'running' });
    lateWrite = () => s.upsert(focusId, { ...turn, state: 'stopped' } as ChatEntry);
    // A runner without forget: stop, and the store refuses the late write.
    delete (app.deps.jarvis as Partial<FocusJarvisRunner>).forget;
    expect((await app.inject({ method: 'DELETE', url: `/api/w/default/focuses/${focusId}` })).statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(await fs.readdir(path.join(app.deps.registry.workspaceDir('default'), 'jarvis')).catch(() => [])).toEqual([]);
    expect((await app.inject({ method: 'GET', url: base() })).statusCode).toBe(404);
  });

  it("delete focus mid-turn: forget lets the turn's last write land first, then the chat is removed", async () => {
    const s = await store();
    const turn = await s.append(focusId, { type: 'turn', turnId: 't1', state: 'running' });
    lateWrite = () => s.upsert(focusId, { ...turn, state: 'stopped' } as ChatEntry);
    expect((await app.inject({ method: 'DELETE', url: `/api/w/default/focuses/${focusId}` })).statusCode).toBe(204);
    expect(calls).toEqual([['forget', 'default', focusId]]);
    expect(await fs.readdir(path.join(app.deps.registry.workspaceDir('default'), 'jarvis')).catch(() => [])).toEqual([]);
  });

  it('unknown focus SSE 404', async () => {
    const { res, ac } = await open('/api/w/default/focuses/nope/jarvis/events');
    expect(res.status).toBe(404);
    ac.abort();
  });

  it('delete focus stops jarvis', async () => {
    const s = await store();
    await s.append(focusId, { type: 'user', text: 'hi', windowId: 'w' });
    await s.setMeta(focusId, { sessionId: 'sess' });
    const { res } = await open(`${base()}/events`);
    await events(res, 1);
    const del = await app.inject({ method: 'DELETE', url: `/api/w/default/focuses/${focusId}` });
    expect(del.statusCode).toBe(204);
    expect(calls).toEqual([['forget', 'default', focusId]]);
    // The open stream ends; the files are gone; later reads 404.
    expect(await events(res, 1)).toEqual([]);
    const dir = path.join(app.deps.registry.workspaceDir('default'), 'jarvis');
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
    expect((await app.inject({ method: 'GET', url: base() })).statusCode).toBe(404);
    const { res: again } = await open(`${base()}/events`);
    expect(again.status).toBe(404);
  });
});
