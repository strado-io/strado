// Laptop side of agent-login sync: the sync/repin routes, the rpc denylist,
// the Claude-token routes, and the auto-sync inside remote worktree create.
// The runner is a stubbed global fetch behind the relay ticket hop.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../app.js';
import { VIA_RELAY_HEADER } from './appControl.js';
import { fingerprintOf, generateBoxKey } from '../services/agentLogins/seal.js';
import { checkPin, peekPin } from '../services/agentLogins/pins.js';
import { loadSenderKey } from '../services/agentLogins/senderKey.js';

// Never read the real ~/.claude.json, ~/.codex or opencode files from a test.
vi.mock('../services/agentLogins/collect.js', () => ({
  collectBundle: async () => ({ claude: { token: 'sk-ant-oat01-PLAINTEXT' }, codex: { apiKey: 'sk-proj-PLAINTEXT' } }),
}));

let tmp: string;
let home: string;
let prevHome: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;

const RUNNER = 'https://fake-runner.test';
const box = generateBoxKey();
const agents = { claude: 'written', codex: 'written', opencode: 'skipped' };

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runners-agent-logins-')));
  home = path.join(tmp, 'strado-home');
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, 'license.json'),
    JSON.stringify({ token: 'a'.repeat(64), name: 'Test User', deviceId: 'device-1234', email: 'test@example.com' }),
  );
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = home;
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'state') });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

type Call = { url: string; method: string; body?: unknown };

/** The runner: answers box-key with `key` and the sync POST with outcomes. */
function stubRunner(o: { key?: string; boxKeyStatus?: number; extra?: (u: string, init?: RequestInit) => Response | undefined } = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (u.includes('/v1/runners/socket-ticket')) {
      return json({ ticket: 'tkt-1', httpBase: RUNNER, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    }
    if (!u.startsWith(RUNNER)) throw new Error(`unexpected fetch to ${u}`);
    const p = new URL(u).pathname;
    calls.push({ url: p, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = o.key ?? box.publicKey;
    if (p === '/api/sandbox/box-key') {
      return o.boxKeyStatus ? json({ error: 'nope' }, o.boxKeyStatus) : json({ publicKey: key, fingerprint: fingerprintOf(key) });
    }
    if (p === '/api/sandbox/agent-logins') return json({ fingerprint: fingerprintOf(key), agents });
    const extra = o.extra?.(u, init);
    if (extra) return extra;
    throw new Error(`unexpected runner call ${p}`);
  }));
  return calls;
}

describe('the old Sync and Repin routes', () => {
  it('are gone: Connect is the only way to pin or re-pin', async () => {
    const calls = stubRunner();
    for (const p of ['sync', 'repin']) {
      expect((await app.inject({ method: 'POST', url: `/api/runners/runner-1/agent-logins/${p}` })).statusCode).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('/api/runners/:id/rpc denylist', () => {
  it.each([
    '/api/sandbox/agent-logins', '/api/sandbox/box-key', '/api/SANDBOX/agent-logins',
    '/api/w/../sandbox/agent-logins', '/api/w/%2e%2e/sandbox/agent-logins', '/api/sandbox',
    '/api%2fsandbox/agent-logins', '/api/w/x%2F..%2F..%2Fsandbox', '/api/w%5csandbox', '/api/w%5C..%5Csandbox',
  ])('%s → 403, fetch not called (GET and POST)', async (p) => {
    const calls = stubRunner();
    const url = `/api/runners/runner-1/rpc?path=${encodeURIComponent(p)}`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('other paths still pass through', async () => {
    const calls = stubRunner({ extra: (u) => (new URL(u).pathname === '/api/workspaces' ? new Response('{"workspaces":[]}', { headers: { 'content-type': 'application/json' } }) : undefined) });
    const res = await app.inject({ method: 'GET', url: `/api/runners/runner-1/rpc?path=${encodeURIComponent('/api/workspaces')}` });
    expect(res.statusCode).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(['/api/workspaces']);
  });
});

describe('/api/agent-logins/sender-fingerprint', () => {
  it("creates the laptop sender key on first ask and returns only its fingerprint", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-logins/sender-fingerprint' });
    expect(res.statusCode).toBe(200);
    const key = await loadSenderKey();
    expect(res.json()).toEqual({ fingerprint: fingerprintOf(key.publicKey) });
    expect(res.body).not.toContain(key.publicKey);
    expect(res.body).not.toContain(key.privateKey);
    expect((await app.inject({ method: 'GET', url: '/api/agent-logins/sender-fingerprint' })).json()).toEqual(res.json());
  });
});

describe('/api/agent-logins/claude-token', () => {
  it('GET only ever discloses presence + last four; POST is local hub only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/agent-logins/claude-token' })).json()).toEqual({ present: false, last4: null });
    const relayed = await app.inject({ method: 'POST', url: '/api/agent-logins/claude-token', headers: { [VIA_RELAY_HEADER]: '1' }, payload: { key: 'sk-ant-oat01-SECRET1234' } });
    expect(relayed.statusCode).toBe(403);
    const set = await app.inject({ method: 'POST', url: '/api/agent-logins/claude-token', payload: { key: 'sk-ant-oat01-SECRET1234' } });
    expect(set.json()).toEqual({ present: true, last4: '1234' });
    const got = await app.inject({ method: 'GET', url: '/api/agent-logins/claude-token' });
    expect(got.body).not.toContain('SECRET');
    expect((await app.inject({ method: 'POST', url: '/api/agent-logins/claude-token', payload: { key: null } })).json().present).toBe(false);
  });
});

describe('auto-sync during remote worktree create', () => {
  function createRunner(o: { boxKeyStatus?: number }) {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    return stubRunner({
      boxKeyStatus: o.boxKeyStatus,
      extra: (u, init) => {
        const p = new URL(u).pathname;
        if (p === '/api/workspaces') return json({ activeWorkspaceId: 'rws', workspaces: [{ id: 'rws' }] });
        if (p === '/api/capabilities') return json({ sandbox: { runtime: 'podman' } });
        if (p === '/api/w/rws/repos/clone') return json({ repo: { id: 'strado' }, alreadyRegistered: true, path: '/r/strado' });
        if (p === '/api/w/rws/worktrees' && init?.method === 'POST') return json({ jobId: 'rj-1' });
        if (p === '/events/jobs/rj-1') return new Response('event: done\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
        return undefined;
      },
    });
  }

  async function create() {
    const stores = await app.deps.registry.get('default');
    await stores.repos.add({
      id: 'strado', name: 'strado', path: path.join(tmp, 'repo'), cloneUrl: 'https://github.com/strado-io/strado.git',
      projectSubdir: null, startCommand: 'npm run dev', defaultPort: 3000, editor: 'code',
    } as never);
    const res = await app.inject({
      method: 'POST', url: '/api/w/default/remote-worktrees',
      payload: { runnerId: 'runner-1', repoId: 'strado', ticketId: '', title: 't', sourceBranch: 'main' },
    });
    expect(res.statusCode).toBe(200);
    return app.deps.jobs.wait((res.json() as { jobId: string }).jobId);
  }

  it('a sandboxing runner gets the sealed logins before the worktree POST', async () => {
    await checkPin('runner-1', fingerprintOf(box.publicKey));
    const calls = createRunner({});
    expect((await create()).status).toBe('done');
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posts.indexOf('/api/sandbox/agent-logins')).toBeGreaterThanOrEqual(0);
    expect(posts.indexOf('/api/sandbox/agent-logins')).toBeLessThan(posts.indexOf('/api/w/rws/worktrees'));
  });

  it('never pins: an unpinned runner gets nothing and no pin is recorded', async () => {
    const calls = createRunner({});
    expect((await create()).status).toBe('done');
    expect(calls.some((c) => c.url === '/api/sandbox/agent-logins')).toBe(false);
    expect(await peekPin('runner-1')).toBeNull();
  });

  it('create still succeeds when the sync fails', async () => {
    await checkPin('runner-1', fingerprintOf(box.publicKey));
    const calls = createRunner({ boxKeyStatus: 500 });
    expect((await create()).status).toBe('done');
    expect(calls.some((c) => c.url === '/api/w/rws/worktrees')).toBe(true);
  });
});
