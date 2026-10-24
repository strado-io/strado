import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors.js';
import { fingerprintOf, generateBoxKey, generateSenderKey, openBundle, verifySealed } from './seal.js';
import { KEY_CHANGED, SENDER_UNTRUSTED, STALE_BUNDLE, syncAgentLogins, waitAtMost, type SyncDeps } from './sync.js';
import { AGENT_LOGIN_PATHS, type SealedBundle } from './types.js';
import type { CollectedBundle } from './collect.js';

const box = generateBoxKey();
const sender = generateSenderKey();
const FP = fingerprintOf(box.publicKey);
const bundle: CollectedBundle = { claude: { token: 'sk-ant-oat01-PLAINTEXT' }, codex: { apiKey: 'sk-proj-PLAINTEXT' } };
const agents = { claude: 'written', codex: 'pending', opencode: 'skipped' } as const;

function deps(over: Partial<SyncDeps> = {}) {
  const sent: unknown[] = [];
  const fetch = vi.fn(async (_id: string, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> => {
    if (path === AGENT_LOGIN_PATHS.boxKey) return { publicKey: box.publicKey, fingerprint: FP };
    if (path === AGENT_LOGIN_PATHS.sync && init?.method === 'POST') { sent.push(init.body); return { fingerprint: FP, agents }; }
    throw new Error('unexpected');
  });
  const d: SyncDeps = {
    fetch: fetch as SyncDeps['fetch'],
    checkPin: vi.fn(async () => 'match' as const),
    peekPin: vi.fn(async () => FP),
    collect: async () => bundle,
    senderKey: async () => sender,
    issuedAt: () => 1_700_000_000_123,
    ...over,
  };
  return { d, fetch, sent };
}

/** The runner answering the sync POST with one of its fixed errors (runner.fetch shape). */
const runnerRefuses = (fetch: ReturnType<typeof deps>['fetch'], message: string) =>
  fetch.mockImplementation(async (_id: string, path: string): Promise<unknown> => {
    if (path === AGENT_LOGIN_PATHS.boxKey) return { publicKey: box.publicKey, fingerprint: FP };
    throw new AppError('VALIDATION', `r1: ${message}`);
  });

describe('syncAgentLogins', () => {
  it('seals and signs the bundle, stamped with issuedAt; returns the outcome with the pin state', async () => {
    const { d, sent } = deps({ checkPin: vi.fn(async () => 'new' as const) });
    const res = await syncAgentLogins('r1', d);
    expect(res).toEqual({ fingerprint: FP, agents, pin: 'new' });
    expect(sent).toHaveLength(1);
    const body = sent[0] as SealedBundle;
    expect(Object.keys(body).sort()).toEqual(['ct', 'epk', 'iv', 'sig', 'spk', 'tag', 'v']);
    expect(body.spk).toBe(sender.publicKey);
    expect(verifySealed(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('PLAINTEXT');
    expect(openBundle(body, box.privateKey, box.publicKey)).toEqual({ ...bundle, issuedAt: 1_700_000_000_123 });
  });

  it("accepts the runner's 'pending' outcome (a fresh runner with no image yet)", async () => {
    const { d } = deps();
    expect((await syncAgentLogins('r1', d)).agents.codex).toBe('pending');
  });

  it('pins the fingerprint it computes itself, not the one the runner reports', async () => {
    const checkPin = vi.fn(async () => 'match' as const);
    const { d, fetch } = deps({ checkPin });
    fetch.mockImplementationOnce(async () => ({ publicKey: box.publicKey, fingerprint: 'aaaa-aaaa-aaaa-aaaa' }));
    const err = await syncAgentLogins('r1', d).then(() => null, (e: AppError) => e);
    expect(err).toMatchObject({ code: 'FORBIDDEN', message: 'runner sent an inconsistent key' });
    expect(err!.details).toBeUndefined();
    expect(checkPin).not.toHaveBeenCalled();
  });

  it('pin changed → FORBIDDEN with both fingerprints in details, and nothing is sent', async () => {
    const { d, fetch, sent } = deps({ checkPin: vi.fn(async () => 'changed' as const), peekPin: vi.fn(async () => 'aaaa-bbbb-cccc-dddd') });
    await expect(syncAgentLogins('r1', d)).rejects.toMatchObject({
      code: 'FORBIDDEN', message: KEY_CHANGED, details: { expected: 'aaaa-bbbb-cccc-dddd', actual: FP },
    });
    expect(sent).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a malformed box key is refused before anything is sealed', async () => {
    const { d, fetch, sent } = deps();
    fetch.mockImplementationOnce(async () => ({ publicKey: 'short', fingerprint: 'x' }));
    await expect(syncAgentLogins('r1', d)).rejects.toThrow('runner sent no usable key');
    expect(sent).toHaveLength(0);
  });

  it('far-side failure text never reaches the error (it could echo a secret)', async () => {
    const { d, fetch } = deps();
    runnerRefuses(fetch, 'sk-ant-oat01-PLAINTEXT');
    const err = await syncAgentLogins('r1', d).then(() => new Error('resolved'), (e: Error) => e);
    expect(err.message).toBe('agent login sync failed on the runner');
    expect(JSON.stringify(err)).not.toContain('PLAINTEXT');
  });

  it("the runner's 'sender not trusted' maps to its own fixed FORBIDDEN", async () => {
    const { d, fetch } = deps();
    runnerRefuses(fetch, 'sender not trusted by this runner');
    await expect(syncAgentLogins('r1', d)).rejects.toMatchObject({ code: 'FORBIDDEN', message: SENDER_UNTRUSTED });
    expect(SENDER_UNTRUSTED).toMatch(/sender not trusted/i);
  });

  it("the runner's 'stale bundle' maps to its own fixed CONFLICT", async () => {
    const { d, fetch } = deps();
    runnerRefuses(fetch, 'stale bundle');
    await expect(syncAgentLogins('r1', d)).rejects.toMatchObject({ code: 'CONFLICT', message: STALE_BUNDLE });
  });

  it('a runner answer of the wrong shape is a fixed failure', async () => {
    const { d, fetch } = deps();
    fetch.mockImplementation(async (_id: string, path: string): Promise<unknown> =>
      path === AGENT_LOGIN_PATHS.boxKey ? { publicKey: box.publicKey, fingerprint: FP } : { ok: true });
    await expect(syncAgentLogins('r1', d)).rejects.toThrow('agent login sync failed on the runner');
  });

  it('an unreachable runner is a fixed failure too', async () => {
    const { d, fetch } = deps();
    fetch.mockRejectedValue(new Error('r1 returned 502: whatever'));
    await expect(syncAgentLogins('r1', d)).rejects.toThrow('runner unreachable');
  });
});

describe('syncAgentLogins, auto mode (worktree create)', () => {
  it('sends when the key already matches the pin, without recording anything', async () => {
    const checkPin = vi.fn(async () => 'new' as const);
    const { d, sent } = deps({ checkPin });
    expect((await syncAgentLogins('r1', d, 'auto')).pin).toBe('match');
    expect(sent).toHaveLength(1);
    expect(checkPin).not.toHaveBeenCalled();
  });

  it('never pins: an unpinned runner is skipped and nothing is sent', async () => {
    const checkPin = vi.fn(async () => 'new' as const);
    const { d, sent } = deps({ checkPin, peekPin: vi.fn(async () => null) });
    await expect(syncAgentLogins('r1', d, 'auto')).rejects.toThrow('runner not trusted yet');
    expect(checkPin).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('a changed key is refused like the explicit path', async () => {
    const { d, sent } = deps({ peekPin: vi.fn(async () => 'aaaa-bbbb-cccc-dddd') });
    await expect(syncAgentLogins('r1', d, 'auto')).rejects.toMatchObject({ message: KEY_CHANGED });
    expect(sent).toHaveLength(0);
  });
});

describe('waitAtMost', () => {
  it('resolves when the promise settles first', async () => {
    await expect(waitAtMost(Promise.resolve(), 15_000)).resolves.toBe('settled');
  });

  it('gives up after the cap and leaves the promise running', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const slow = new Promise<void>((r) => { finish = r; });
      const waited = waitAtMost(slow, 15_000);
      await vi.advanceTimersByTimeAsync(14_999);
      let done = false;
      void waited.then(() => { done = true; });
      await Promise.resolve();
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waited).resolves.toBe('timed-out');
      finish();
      await slow;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('syncAgentLogins, first pin confirmed by the person', () => {
  it('a never-pinned runner: asks with both fingerprints before pinning; yes pins and sends', async () => {
    const order: string[] = [];
    const confirmPin = vi.fn(async () => { order.push('ask'); return true; });
    const checkPin = vi.fn(async () => { order.push('pin'); return 'new' as const; });
    const { d, sent } = deps({ peekPin: vi.fn(async () => null), checkPin, confirmPin });
    const res = await syncAgentLogins('r1', d);
    expect(confirmPin).toHaveBeenCalledWith(FP, fingerprintOf(sender.publicKey), null);
    expect(order).toEqual(['ask', 'pin']);
    expect(res.pin).toBe('new');
    expect(sent).toHaveLength(1);
  });

  it('no → the fixed refusal, nothing pinned, nothing sent', async () => {
    const checkPin = vi.fn(async () => 'new' as const);
    const { d, sent } = deps({ peekPin: vi.fn(async () => null), checkPin, confirmPin: async () => false });
    await expect(syncAgentLogins('r1', d)).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'runner not trusted yet' });
    expect(checkPin).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('an already-pinned runner is not asked again', async () => {
    const confirmPin = vi.fn(async () => true);
    const { d } = deps({ confirmPin });
    await syncAgentLogins('r1', d);
    expect(confirmPin).not.toHaveBeenCalled();
  });

  it('auto mode never asks', async () => {
    const confirmPin = vi.fn(async () => true);
    const { d } = deps({ peekPin: vi.fn(async () => null), confirmPin });
    await expect(syncAgentLogins('r1', d, 'auto')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(confirmPin).not.toHaveBeenCalled();
  });
});

describe('syncAgentLogins, Pi outcome', () => {
  it("passes the runner's pi outcome through, and an older runner without one still parses", async () => {
    const { d, fetch } = deps();
    fetch.mockImplementation(async (_id: string, path: string): Promise<unknown> =>
      path === AGENT_LOGIN_PATHS.boxKey ? { publicKey: box.publicKey, fingerprint: FP } : { fingerprint: FP, agents: { ...agents, pi: 'written' } });
    expect((await syncAgentLogins('r1', d)).agents.pi).toBe('written');
    fetch.mockImplementation(async (_id: string, path: string): Promise<unknown> =>
      path === AGENT_LOGIN_PATHS.boxKey ? { publicKey: box.publicKey, fingerprint: FP } : { fingerprint: FP, agents });
    expect((await syncAgentLogins('r1', d)).agents.pi).toBeUndefined();
  });
});

describe('syncAgentLogins, connect marker', () => {
  const opened = (sent: unknown[]) => openBundle(sent[0] as SealedBundle, box.privateKey, box.publicKey);

  it('an explicit Connect names its agent inside the sealed bundle', async () => {
    const { d, sent } = deps({ connect: 'pi' });
    await syncAgentLogins('r1', d);
    expect(opened(sent).connect).toBe('pi');
  });

  it('a plain explicit sync (the Sync button) carries no connect', async () => {
    const { d, sent } = deps();
    await syncAgentLogins('r1', d);
    expect('connect' in opened(sent)).toBe(false);
  });

  it('auto-sync never carries connect, even if asked to', async () => {
    const { d, sent } = deps({ connect: 'claude' });
    await syncAgentLogins('r1', d, 'auto');
    expect('connect' in opened(sent)).toBe(false);
  });
});

describe('syncAgentLogins, a changed key confirmed by the person', () => {
  it('asks with the old pin, the new key and the laptop; yes re-pins and sends', async () => {
    const confirmPin = vi.fn(async () => true);
    const replacePin = vi.fn(async () => true);
    const checkPin = vi.fn(async () => 'changed' as const);
    const { d, sent } = deps({ peekPin: vi.fn(async () => 'OLD-FP'), checkPin, confirmPin, replacePin });
    const res = await syncAgentLogins('r1', d);
    expect(confirmPin).toHaveBeenCalledWith(FP, fingerprintOf(sender.publicKey), 'OLD-FP');
    expect(replacePin).toHaveBeenCalledWith('r1', 'OLD-FP', FP);
    expect(checkPin).not.toHaveBeenCalled();
    expect(res.pin).toBe('new');
    expect(sent).toHaveLength(1);
  });

  it('no → the same refusal as a declined first pin, nothing re-pinned or sent', async () => {
    const replacePin = vi.fn(async () => true);
    const { d, sent } = deps({ peekPin: vi.fn(async () => 'OLD-FP'), confirmPin: async () => false, replacePin });
    const err = await syncAgentLogins('r1', d).catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'FORBIDDEN', message: 'runner not trusted yet' });
    expect(replacePin).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('the pin moved while the question was open → a fixed conflict, nothing sent', async () => {
    const { d, sent } = deps({ peekPin: vi.fn(async () => 'OLD-FP'), confirmPin: async () => true, replacePin: async () => false });
    await expect(syncAgentLogins('r1', d)).rejects.toMatchObject({ code: 'CONFLICT', message: 'runner trust changed meanwhile — try again' });
    expect(sent).toHaveLength(0);
  });

  it('auto mode never asks and never re-pins', async () => {
    const confirmPin = vi.fn(async () => true);
    const replacePin = vi.fn(async () => true);
    const { d, sent } = deps({ peekPin: vi.fn(async () => 'OLD-FP'), confirmPin, replacePin });
    await expect(syncAgentLogins('r1', d, 'auto')).rejects.toMatchObject({ code: 'FORBIDDEN', message: KEY_CHANGED });
    expect(confirmPin).not.toHaveBeenCalled();
    expect(replacePin).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
