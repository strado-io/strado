import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors.js';
import { KEY_CHANGED } from '../agentLogins/sync.js';
import { createSetupRun } from '../sshSetup/job.js';
import {
  checkConnection, createConnectionCache, disconnectConnection, runConnect,
  type ConnectDeps, type PinQuestion,
} from './connect.js';
import type { ConnectionAgent, ConnectProgress } from './types.js';

const TOKEN = `sk-ant-oat01-${'x'.repeat(60)}`;
const agents = { claude: 'written', codex: 'skipped', opencode: 'skipped' } as const;

type Call = { path: string; method: string };

/** A fake runner: answers the RUNNER_CONNECTION_PATHS and records every call. */
function fakeRunner(over: { check?: unknown; device?: unknown; waits?: unknown[]; disconnect?: unknown } = {}) {
  const calls: Call[] = [];
  const waits = [...(over.waits ?? [{ done: true, ok: true }])];
  const fetch = vi.fn(async (_id: string, path: string, init?: { method?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    if (/\/connections\/[a-z]+\/check$/.test(path)) return over.check ?? { state: 'connected', detail: 'Logged in', needsTerminal: false };
    if (/\/connections\/[a-z]+\/device$/.test(path)) {
      return over.device ?? { loginId: 'L1', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', expiresAt: 10_000_000 };
    }
    if (path.startsWith('/api/sandbox/connections/device/') && init?.method === 'DELETE') return null;
    if (path.startsWith('/api/sandbox/connections/device/')) return waits.length > 1 ? waits.shift() : waits[0];
    if (/\/connections\/[a-z]+\/disconnect$/.test(path)) return over.disconnect ?? { state: 'not-connected', detail: null };
    throw new Error(`unexpected ${path}`);
  });
  return { fetch: fetch as unknown as ConnectDeps['fetch'], calls };
}

function setup(over: Partial<ConnectDeps> = {}, runner = fakeRunner()) {
  let clock = 1_000_000;
  const frames: { message: string; data?: unknown }[] = [];
  const ctx = { progress: (message: string, data?: unknown) => frames.push({ message, data }) };
  const deps: ConnectDeps = {
    fetch: runner.fetch,
    isOnline: vi.fn(async () => true),
    hasClaudeToken: vi.fn(async () => false),
    captureSetupToken: vi.fn(async ({ onPhase }) => { onPhase('opening-browser'); onPhase('waiting-approval'); onPhase('saving'); }),
    sync: vi.fn(async () => ({ fingerprint: 'fp', agents, pin: 'match' as const })),
    now: () => clock,
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
    devicePollMs: 2_000,
    ...over,
  };
  const run = createSetupRun<PinQuestion>('connect cancelled');
  const cache = createConnectionCache();
  const go = (agent: ConnectionAgent) => runConnect(ctx, { runnerId: 'r1', agent }, deps, run, cache);
  return { deps, frames, run, cache, go, calls: runner.calls, tick: (ms: number) => { clock += ms; } };
}

const phases = (frames: { data?: unknown }[]) =>
  frames.map((f) => (f.data as { phase?: string })?.phase).filter(Boolean);

describe('runConnect: claude', () => {
  it('no token yet: captures one, syncs, checks; the row is connected and cached', async () => {
    const s = setup();
    const res = await s.go('claude');
    expect(s.deps.captureSetupToken).toHaveBeenCalledTimes(1);
    expect(s.deps.sync).toHaveBeenCalledWith('r1', expect.any(Function), 'claude');
    expect(phases(s.frames)).toEqual(['opening-browser', 'waiting-approval', 'saving', 'syncing', 'checking']);
    expect(s.calls).toEqual([{ path: '/api/sandbox/connections/claude/check', method: 'POST' }]);
    expect(res.connection).toEqual({ agent: 'claude', state: 'connected', detail: 'Logged in', checkedAt: 1_000_000, needsTerminal: false });
    expect(s.cache.list('r1').find((c) => c.agent === 'claude')).toEqual(res.connection);
  });

  it('a stored token skips the browser and goes straight to sync', async () => {
    const s = setup({ hasClaudeToken: async () => true });
    await s.go('claude');
    expect(s.deps.captureSetupToken).not.toHaveBeenCalled();
    expect(phases(s.frames)).toEqual(['syncing', 'checking']);
  });

  it('first pin: the question carries both fingerprints and the answer decides', async () => {
    let answer: Promise<boolean> | undefined;
    const sync = vi.fn(async (_id: string, confirm: (r: string, l: string, prev: string | null) => Promise<boolean>) => {
      answer = confirm('RUN-FP', 'LAP-FP', null);
      if (!(await answer)) throw new AppError('FORBIDDEN', 'runner not trusted yet');
      return { fingerprint: 'fp', agents, pin: 'new' as const };
    });
    const s = setup({ hasClaudeToken: async () => true, sync });
    const p = s.go('claude');
    await vi.waitFor(() => expect(s.frames.some((f) => (f.data as { question?: unknown })?.question)).toBe(true));
    const q = (s.frames.find((f) => (f.data as { question?: unknown })?.question)!.data as Extract<ConnectProgress, { question: unknown }>).question;
    expect(q).toEqual({ id: expect.any(String), kind: 'pin', runnerFingerprint: 'RUN-FP', laptopFingerprint: 'LAP-FP' });
    s.run.answer(q.id, false);
    await expect(p).rejects.toThrow('runner not trusted yet');
    expect(s.calls).toEqual([]);
  });

  it('a changed key: the question also carries the old pinned fingerprint', async () => {
    const s = setup({
      hasClaudeToken: async () => true,
      sync: async (_id, confirm) => ((await confirm('NEW-FP', 'LAP-FP', 'OLD-FP')) ? { fingerprint: 'fp', agents, pin: 'new' } : Promise.reject(new AppError('FORBIDDEN', 'runner not trusted yet'))),
    });
    const p = s.go('claude');
    await vi.waitFor(() => expect(s.frames.some((f) => (f.data as { question?: unknown })?.question)).toBe(true));
    const q = (s.frames.find((f) => (f.data as { question?: unknown })?.question)!.data as Extract<ConnectProgress, { question: unknown }>).question;
    expect(q).toEqual({ id: expect.any(String), kind: 'pin', runnerFingerprint: 'NEW-FP', laptopFingerprint: 'LAP-FP', previousFingerprint: 'OLD-FP' });
    s.run.answer(q.id, true);
    await expect(p).resolves.toBeTruthy();
  });

  it('an unanswered pin question times out as a no', async () => {
    let answered: boolean | undefined;
    const s = setup({
      hasClaudeToken: async () => true,
      pinTimeoutMs: 20,
      sync: async (_id, confirm) => {
        answered = await confirm('RUN-FP', 'LAP-FP', null);
        throw new AppError('FORBIDDEN', 'runner not trusted yet');
      },
    });
    await expect(s.go('claude')).rejects.toThrow('runner not trusted yet');
    expect(answered).toBe(false);
  });

  it("the runner couldn't store the login → fixed failure, the row reads failed", async () => {
    const s = setup({ hasClaudeToken: async () => true, sync: async () => ({ fingerprint: 'fp', agents: { ...agents, claude: 'failed' }, pin: 'match' }) });
    await expect(s.go('claude')).rejects.toThrow('the runner could not store the Claude login');
    expect(s.cache.list('r1').find((c) => c.agent === 'claude')!.state).toBe('failed');
  });

  it('a trust refusal (FORBIDDEN) leaves the row as it was', async () => {
    const s = setup({ hasClaudeToken: async () => true, sync: async () => { throw new AppError('FORBIDDEN', 'runner not trusted yet'); } });
    await expect(s.go('claude')).rejects.toThrow('runner not trusted yet');
    expect(s.cache.list('r1').find((c) => c.agent === 'claude')!.state).toBe('unknown');
  });

  it("a changed runner key reaches the job as sync's own error, details and wording intact", async () => {
    const s = setup({ hasClaudeToken: async () => true, sync: async () => { throw new AppError('FORBIDDEN', KEY_CHANGED, { expected: 'OLD', actual: 'NEW' }); } });
    const err = await s.go('claude').catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'FORBIDDEN', details: { expected: 'OLD', actual: 'NEW' } });
    expect((err as AppError).message).toMatch(/runner key changed/);
    expect(s.cache.list('r1').find((c) => c.agent === 'claude')!.state).toBe('unknown');
  });

  it('a setup-token failure is its fixed text; an unexpected error is a generic one', async () => {
    const s = setup({ captureSetupToken: async () => { throw new Error('Claude sign-in timed out'); } });
    await expect(s.go('claude')).rejects.toThrow('Claude sign-in timed out');
    const u = setup({ captureSetupToken: async () => { throw new Error(`pty said ${TOKEN}`); } });
    await expect(u.go('claude')).rejects.toThrow(/^connect failed$/);
    expect(s.cache.list('r1').find((c) => c.agent === 'claude')!.detail).toBe('Claude sign-in timed out');
    const t = setup({ hasClaudeToken: async () => { throw new TypeError(`boom ${TOKEN}`); } });
    const err = await t.go('claude').catch((e: Error) => e);
    expect((err as Error).message).toBe('connect failed');
    expect(JSON.stringify(t.cache.list('r1'))).not.toContain('sk-ant');
  });

  it('nothing secret reaches a frame', async () => {
    const s = setup({ captureSetupToken: async ({ onPhase }) => { onPhase('saving'); void TOKEN; } });
    await s.go('claude');
    expect(JSON.stringify(s.frames)).not.toMatch(/sk-ant/);
  });
});

describe('runConnect: codex and opencode (device login on the runner)', () => {
  it('starts the login, shows the code, waits for approval, then checks', async () => {
    const runner = fakeRunner({ waits: [{ done: false }, { done: false }, { done: true, ok: true }] });
    const s = setup({}, runner);
    const res = await s.go('codex');
    const device = s.frames.map((f) => (f.data as { device?: unknown })?.device).find(Boolean);
    expect(device).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', expiresAt: 10_000_000 });
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/sandbox/connections/codex/device',
      'GET /api/sandbox/connections/device/L1',
      'GET /api/sandbox/connections/device/L1',
      'GET /api/sandbox/connections/device/L1',
      'POST /api/sandbox/connections/codex/check',
    ]);
    expect(phases(s.frames)).toEqual(['checking']);
    // The code frame stays the latest while waiting, for a page that attaches late.
    expect(s.frames.findIndex((f) => (f.data as { device?: unknown })?.device)).toBe(s.frames.length - 2);
    expect(res.connection.state).toBe('connected');
  });

  it('opencode uses the same device flow on its own path', async () => {
    const s = setup();
    await s.go('opencode');
    expect(s.calls[0]).toEqual({ path: '/api/sandbox/connections/opencode/device', method: 'POST' });
    expect(s.deps.sync).not.toHaveBeenCalled();
  });

  it('an approved login is not cancelled; a failing cancel call never masks the real error', async () => {
    const s = setup();
    await s.go('codex');
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);
    const runner = fakeRunner({ waits: [{ done: false }] });
    const inner = runner.fetch as unknown as ReturnType<typeof vi.fn>;
    const orig = inner.getMockImplementation()!;
    inner.mockImplementation(async (id: string, path: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') throw new Error('r1: boom');
      return orig(id, path, init);
    });
    const t = setup({}, runner);
    await expect(t.go('codex')).rejects.toThrow('approval timed out');
  });

  it('the login ends without approval → fixed failure', async () => {
    const s = setup({}, fakeRunner({ waits: [{ done: true, ok: false }] }));
    await expect(s.go('codex')).rejects.toThrow('the login was not approved');
    expect(s.cache.list('r1').find((c) => c.agent === 'codex')!.state).toBe('failed');
  });

  it('never approved before the code expires → approval timed out', async () => {
    const s = setup({}, fakeRunner({ device: { loginId: 'L1', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', expiresAt: 1_000_000 + 15 * 60_000 }, waits: [{ done: false }] }));
    await expect(s.go('codex')).rejects.toThrow('approval timed out');
    expect(s.calls.at(-1)).toEqual({ path: '/api/sandbox/connections/device/L1', method: 'DELETE' });
  });

  it('a device answer of the wrong shape is a fixed failure', async () => {
    for (const device of [
      { loginId: 'L1', url: 'http://evil', code: 'ABCD-EFGH', expiresAt: 1 },
      { loginId: 'L1', url: 'https://evil.example/codex/device', code: 'ABCD-EFGH', expiresAt: 1 },
      { loginId: 'L1', url: 'https://auth.openai.com.evil.example/x', code: 'ABCD-EFGH', expiresAt: 1 },
      { loginId: 'L1', url: 'https://auth.openai.com@evil.example/x', code: 'ABCD-EFGH', expiresAt: 1 },
      { loginId: '../x', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', expiresAt: 1 },
      { loginId: 'L1', url: 'https://auth.openai.com/codex/device', code: '<b>', expiresAt: 1 },
      {},
    ]) {
      const s = setup({}, fakeRunner({ device }));
      await expect(s.go('codex')).rejects.toThrow('the runner could not start a login');
    }
  });

  it('cancel while waiting for approval → connect cancelled, no check', async () => {
    const s = setup({ sleep: async () => { await new Promise((r) => setTimeout(r, 5)); } }, fakeRunner({ waits: [{ done: false }] }));
    const p = s.go('codex');
    await vi.waitFor(() => expect(s.frames.some((f) => (f.data as { device?: unknown })?.device)).toBe(true));
    s.run.cancel();
    await expect(p).rejects.toThrow('connect cancelled');
    expect(s.calls.some((c) => c.path.endsWith('/check'))).toBe(false);
    await vi.waitFor(() => expect(s.calls.at(-1)).toEqual({ path: '/api/sandbox/connections/device/L1', method: 'DELETE' }));
  });

  it('runner errors while polling are fixed text, never the far side\'s', async () => {
    const runner = fakeRunner();
    (runner.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_id: string, path: string) => {
      if (path.endsWith('/device')) return { loginId: 'L1', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', expiresAt: 10_000_000 };
      throw new Error('r1: secret far-side text');
    });
    const s = setup({}, runner);
    const err = await s.go('codex').catch((e: Error) => e);
    expect((err as Error).message).toBe('runner unreachable');
  });
});

describe('runConnect: pi', () => {
  it('syncs the static entries (asking for the first pin), then checks', async () => {
    const s = setup();
    await s.go('pi');
    expect(s.deps.sync).toHaveBeenCalledWith('r1', expect.any(Function), 'pi');
    expect(s.deps.captureSetupToken).not.toHaveBeenCalled();
    expect(s.calls).toEqual([{ path: '/api/sandbox/connections/pi/check', method: 'POST' }]);
  });
});

describe('offline', () => {
  it('connect, check and disconnect refuse with a fixed message and never reach the runner', async () => {
    const s = setup({ isOnline: async () => false });
    await expect(s.go('claude')).rejects.toThrow('runner is offline');
    await expect(checkConnection('r1', 'codex', s.deps, s.cache)).rejects.toThrow('runner is offline');
    await expect(disconnectConnection('r1', 'codex', s.deps, s.cache)).rejects.toThrow('runner is offline');
    expect(s.calls).toEqual([]);
    expect(s.deps.captureSetupToken).not.toHaveBeenCalled();
  });
});

describe('check + disconnect', () => {
  it('check stores the verified state with its time', async () => {
    const s = setup({}, fakeRunner({ check: { state: 'not-connected', detail: null } }));
    const c = await checkConnection('r1', 'codex', s.deps, s.cache);
    expect(c).toEqual({ agent: 'codex', state: 'not-connected', detail: null, checkedAt: 1_000_000 });
    expect(s.cache.list('r1').find((x) => x.agent === 'codex')).toEqual(c);
  });

  it('a check answer of the wrong shape is a fixed failure', async () => {
    const s = setup({}, fakeRunner({ check: { state: 'logged-in', detail: null } }));
    await expect(checkConnection('r1', 'codex', s.deps, s.cache)).rejects.toThrow('the runner sent no usable check');
  });

  it('a long detail (many providers) is cut, not refused', async () => {
    const s = setup({}, fakeRunner({ check: { state: 'connected', detail: 'x'.repeat(500) } }));
    expect((await checkConnection('r1', 'opencode', s.deps, s.cache)).detail).toHaveLength(200);
  });

  it('disconnect posts to the runner and stores what it reports', async () => {
    const s = setup();
    const c = await disconnectConnection('r1', 'claude', s.deps, s.cache);
    expect(s.calls).toEqual([{ path: '/api/sandbox/connections/claude/disconnect', method: 'POST' }]);
    expect(c.state).toBe('not-connected');
  });
});

describe('createConnectionCache', () => {
  it('lists every agent, unknown until checked, per runner', () => {
    const cache = createConnectionCache();
    cache.set('r1', { agent: 'pi', state: 'connected', detail: null, checkedAt: 5 });
    expect(cache.list('r1').map((c) => [c.agent, c.state])).toEqual([
      ['claude', 'unknown'], ['codex', 'unknown'], ['opencode', 'unknown'], ['pi', 'connected'],
    ]);
    expect(cache.list('r2').every((c) => c.state === 'unknown' && c.checkedAt === null)).toBe(true);
  });
});
