import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLastActivityTracker, IDLE_STOP_MS, startParkSweep } from './park.js';

type Running = { slug: string; worktreePath: string };

function fakeSandbox(running: Running[], opts: { stopImpl?: (slug: string) => Promise<void> } = {}) {
  const stop = vi.fn(opts.stopImpl ?? (async () => {}));
  return {
    listRunning: vi.fn(async () => running),
    stop,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startParkSweep', () => {
  it('stops a running sandbox once activity has been idle past 2h with no live session', async () => {
    const running: Running[] = [{ slug: 'feat-x-abcd1234', worktreePath: '/wt/feat-x' }];
    const sandbox = fakeSandbox(running);
    let now = 0;
    const lastSeen = new Map<string, number>([['/wt/feat-x', 0]]);
    const stop = startParkSweep({
      sandbox: sandbox as any,
      lastActivity: (p) => lastSeen.get(p) ?? null,
      hasLiveSession: () => false,
      now: () => now,
      intervalMs: 5 * 60 * 1000,
    });

    now = IDLE_STOP_MS + 1;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.stop).toHaveBeenCalledWith('feat-x-abcd1234');
    stop();
  });

  it('does not stop a sandbox whose worktree has recent activity', async () => {
    const running: Running[] = [{ slug: 'feat-x-abcd1234', worktreePath: '/wt/feat-x' }];
    const sandbox = fakeSandbox(running);
    let now = 0;
    const lastSeen = new Map<string, number>([['/wt/feat-x', 0]]);
    const stopSweep = startParkSweep({
      sandbox: sandbox as any,
      lastActivity: (p) => lastSeen.get(p) ?? null,
      hasLiveSession: () => false,
      now: () => now,
      intervalMs: 5 * 60 * 1000,
    });

    now = 60 * 60 * 1000; // 1h idle — under the 2h threshold
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sandbox.stop).not.toHaveBeenCalled();
    stopSweep();
  });

  it('never stops a worktree with a live session, no matter how stale its recorded activity is', async () => {
    const running: Running[] = [{ slug: 'feat-x-abcd1234', worktreePath: '/wt/feat-x' }];
    const sandbox = fakeSandbox(running);
    let now = 0;
    const lastSeen = new Map<string, number>([['/wt/feat-x', 0]]);
    const stopSweep = startParkSweep({
      sandbox: sandbox as any,
      lastActivity: (p) => lastSeen.get(p) ?? null,
      hasLiveSession: () => true, // an attached terminal — must never be parked
      now: () => now,
      intervalMs: 5 * 60 * 1000,
    });

    now = IDLE_STOP_MS * 10;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sandbox.stop).not.toHaveBeenCalled();
    stopSweep();
  });

  it('does not stop a just-created worktree the first time it is swept (creation counts as activity)', async () => {
    const running: Running[] = [{ slug: 'feat-x-abcd1234', worktreePath: '/wt/feat-x' }];
    const sandbox = fakeSandbox(running);
    let now = 0;
    const stopSweep = startParkSweep({
      sandbox: sandbox as any,
      lastActivity: () => null, // never recorded — e.g. a brand-new sandbox
      hasLiveSession: () => false,
      now: () => now,
      intervalMs: 5 * 60 * 1000,
    });

    // First sight seeds an internal "first seen" timestamp; a container
    // seen for the first time is never parked on that same tick.
    now = 5 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(sandbox.stop).not.toHaveBeenCalled();

    // ...but it isn't protected forever: if nothing ever records real
    // activity for it, the clock runs from first sight and it does
    // eventually park once genuinely idle past the threshold.
    now = IDLE_STOP_MS + 10 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(sandbox.stop).toHaveBeenCalledTimes(1);

    stopSweep();
  });

  it('swallows a stop() failure and keeps sweeping on the next tick', async () => {
    const running: Running[] = [{ slug: 'feat-x-abcd1234', worktreePath: '/wt/feat-x' }];
    let callCount = 0;
    const sandbox = fakeSandbox(running, {
      stopImpl: async () => {
        callCount++;
        if (callCount === 1) throw new Error('runtime unavailable');
      },
    });
    let now = 0;
    const lastSeen = new Map<string, number>([['/wt/feat-x', 0]]);
    const stopSweep = startParkSweep({
      sandbox: sandbox as any,
      lastActivity: (p) => lastSeen.get(p) ?? null,
      hasLiveSession: () => false,
      now: () => now,
      intervalMs: 5 * 60 * 1000,
    });

    now = IDLE_STOP_MS + 1;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // first attempt throws
    expect(sandbox.stop).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // sweep is still alive
    expect(sandbox.stop).toHaveBeenCalledTimes(2);

    stopSweep();
  });

  it('the returned stop function clears the interval so no further ticks run', async () => {
    const running: Running[] = [{ slug: 'feat-x-abcd1234', worktreePath: '/wt/feat-x' }];
    const sandbox = fakeSandbox(running);
    let now = 0;
    const lastSeen = new Map<string, number>([['/wt/feat-x', 0]]);
    const stopSweep = startParkSweep({
      sandbox: sandbox as any,
      lastActivity: (p) => lastSeen.get(p) ?? null,
      hasLiveSession: () => false,
      now: () => now,
      intervalMs: 5 * 60 * 1000,
    });

    stopSweep();
    now = IDLE_STOP_MS + 1;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(sandbox.stop).not.toHaveBeenCalled();
  });
});

describe('createLastActivityTracker', () => {
  it('returns null for a path that was never touched', () => {
    const tracker = createLastActivityTracker();
    expect(tracker.get('/wt/never')).toBeNull();
  });

  it('touch records the current time, forget clears it back to null', () => {
    let now = 0;
    const tracker = createLastActivityTracker({ now: () => now });
    now = 12_345;
    tracker.touch('/wt/a');
    expect(tracker.get('/wt/a')).toBe(12_345);

    tracker.forget('/wt/a');
    expect(tracker.get('/wt/a')).toBeNull();
  });
});

describe('startParkSweep + delete/recreate at the same worktree path', () => {
  // Worktree paths are deterministic (canonicalWorktreesDir + buildWorktreeSlug), so
  // deleting a worktree and recreating one for the same ticket/title lands
  // at the IDENTICAL path. If a stale timestamp from the deleted worktree
  // survived, the brand-new sandbox would read old (already-idle) activity
  // instead of null — defeating the "just created is never parked on first
  // sight" guarantee. The delete route must call `forget()` so the tracker
  // reports null again for the new occupant.
  it('a worktree recreated at a path whose prior occupant was stale is not parked on the first tick', async () => {
    const worktreePath = '/wt/feat-x';
    const running: Running[] = [{ slug: 'feat-x-abcd1234', worktreePath }];
    const sandbox = fakeSandbox(running);
    let now = 0;
    const tracker = createLastActivityTracker({ now: () => now });

    tracker.touch(worktreePath); // the OLD occupant's activity, at now=0

    const stopSweep = startParkSweep({
      sandbox: sandbox as any,
      lastActivity: (p) => tracker.get(p),
      hasLiveSession: () => false,
      now: () => now,
      intervalMs: 5 * 60 * 1000,
    });

    // Advance well past the idle threshold — were the stale timestamp still
    // in effect, this tick would park the (new) sandbox.
    now = IDLE_STOP_MS + 60 * 60 * 1000;

    // The delete route forgets the old occupant's activity before the sweep
    // ever observes the new container at this path.
    tracker.forget(worktreePath);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sandbox.stop).not.toHaveBeenCalled();
    stopSweep();
  });
});
