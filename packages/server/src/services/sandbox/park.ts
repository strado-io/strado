import type { SandboxService } from './sandboxes.js';

// A sandbox idle this long gets its container STOPPED — never removed. The
// worktree, its env file, and the container itself are untouched; the next
// terminal attach starts it right back up (Task 7 made `<runtime> start`
// idempotent in the spawn wrapper).
export const IDLE_STOP_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startParkSweep(opts: {
  sandbox: SandboxService;
  /** Last real activity (terminal keystroke/output) recorded for a
   * worktree, or null if none has been recorded at all. */
  lastActivity: (worktreePath: string) => number | null;
  /** A worktree with ANY live terminal session is never parked, no matter
   * how stale `lastActivity` looks — the exec'd process lives inside the
   * container, so stopping it would kill whatever the session is running. */
  hasLiveSession: (worktreePath: string) => boolean;
  now?: () => number;
  intervalMs?: number;
}): () => void {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

  // Fallback timestamps for containers `listRunning()` reports before
  // `lastActivity` has anything recorded for them — a sandbox just created,
  // or one whose activity state didn't survive a server restart. First
  // sight counts as activity, so a brand-new sandbox is never parked before
  // it has had a chance to be used.
  const firstSeenAt = new Map<string, number>();

  async function tick() {
    const running = await opts.sandbox.listRunning();

    const stillRunning = new Set(running.map((r) => r.worktreePath));
    for (const path of firstSeenAt.keys()) {
      if (!stillRunning.has(path)) firstSeenAt.delete(path);
    }

    for (const { slug, worktreePath } of running) {
      if (opts.hasLiveSession(worktreePath)) continue;

      let last = opts.lastActivity(worktreePath);
      if (last == null) {
        const seeded = firstSeenAt.get(worktreePath);
        if (seeded == null) {
          firstSeenAt.set(worktreePath, now());
          continue; // just seen — not idle yet
        }
        last = seeded;
      }

      if (now() - last >= IDLE_STOP_MS) {
        try {
          await opts.sandbox.stop(slug);
        } catch {
          // stop() is already tolerant of runtime failures; this is defense
          // in depth so one bad tick can never take the sweep itself down —
          // the same container is retried next interval.
        }
      }
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Real terminal activity (keystroke/output) per worktree, feeding
// startParkSweep's `lastActivity`. `ActivityTracker` (activityTracker.ts)
// exposes no per-path last-seen accessor of its own — its `get()` returns
// accrued hands-on seconds, gated on 'working' state and throttled — so this
// is the sweep's own clock, touched from the raw pty-data callback for every
// session mode.
export function createLastActivityTracker(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const seenAt = new Map<string, number>();
  return {
    touch(worktreePath: string): void {
      seenAt.set(worktreePath, now());
    },
    get(worktreePath: string): number | null {
      return seenAt.get(worktreePath) ?? null;
    },
    // Called on worktree delete. Worktree paths are deterministic
    // (worktreesDir + buildWorktreeSlug(ticketId, title)), so a delete
    // followed by a recreate for the same ticket/title lands at the
    // IDENTICAL path. Without this, a leaked stale (already-idle) timestamp
    // would make the brand-new sandbox read old activity instead of null,
    // defeating the "just created is never parked on first sight" guarantee
    // above — it could be stopped on the very first sweep tick.
    forget(worktreePath: string): void {
      seenAt.delete(worktreePath);
    },
  };
}

export type LastActivityTracker = ReturnType<typeof createLastActivityTracker>;
