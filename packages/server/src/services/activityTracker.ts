import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseSessionKey } from './terminalManager.js';

// Tracks hands-on time per worktree from activity heartbeats (terminal
// keystrokes, agent status changes). Consecutive beats closer than the idle
// gap accrue their real elapsed time; a longer silence contributes nothing,
// which is exactly session-based time tracking without explicit sessions.
const IDLE_GAP_MS = 15 * 60 * 1000;
const FLUSH_DELAY_MS = 30_000;

type FileShape = {
  worktrees: Record<string, { seconds: number; lastActiveAt: string }>;
};

export type ActivityTracker = {
  touch(worktreePath: string): void;
  /** Total active seconds accrued for this worktree (whole seconds). */
  get(worktreePath: string): number;
  remove(worktreePath: string): void;
  flush(): Promise<void>;
};

// Pty-output heartbeats keep the clock alive through agent turns longer than
// the idle gap (hooks only beat at turn boundaries). Gated on the agent
// actually being in 'working' state so idle TUI repaints and shell processes
// left streaming (dev servers, tails) can't inflate the total; throttled so a
// streaming turn beats once per interval, not per output chunk.
export function createAgentOutputBeats(opts: {
  touch(worktreePath: string): void;
  agentStatus(mode: 'claude' | 'codex' | 'opencode', worktreePath: string): 'idle' | 'working' | 'waiting' | undefined;
  now?: () => number;
  throttleMs?: number;
}): (sessionKey: string) => void {
  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? 30_000;
  const lastBeat = new Map<string, number>();
  return (sessionKey) => {
    const session = parseSessionKey(sessionKey);
    if (session.mode === 'shell') return;
    if (opts.agentStatus(session.mode, session.path) !== 'working') return;
    const t = now();
    const last = lastBeat.get(session.path);
    if (last !== undefined && t - last < throttleMs) return;
    lastBeat.set(session.path, t);
    opts.touch(session.path);
  };
}

export function createActivityTracker(
  filePath: string,
  opts: { now?: () => number; idleGapMs?: number } = {},
): ActivityTracker {
  const now = opts.now ?? Date.now;
  const idleGapMs = opts.idleGapMs ?? IDLE_GAP_MS;

  const totals = new Map<string, number>(); // seconds, fractional internally
  const lastActive = new Map<string, number>(); // ms epoch of last beat
  let flushTimer: NodeJS.Timeout | null = null;

  // Totals are read once at boot; the tracker is the sole writer of this file.
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as FileShape;
      for (const [p, v] of Object.entries(data.worktrees ?? {})) {
        totals.set(p, v.seconds);
      }
    }
  } catch {
    // unreadable file — start from zero rather than refusing to boot
  }

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const data: FileShape = { worktrees: {} };
    for (const [p, seconds] of totals) {
      data.worktrees[p] = {
        seconds: Math.round(seconds),
        lastActiveAt: new Date(lastActive.get(p) ?? now()).toISOString(),
      };
    }
    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
      await fsp.rename(tmp, filePath);
    } catch {
      // best-effort persistence; losing a beat is better than crashing
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }

  return {
    touch(worktreePath) {
      const t = now();
      const last = lastActive.get(worktreePath);
      if (last !== undefined) {
        const delta = t - last;
        if (delta > 0 && delta <= idleGapMs) {
          totals.set(worktreePath, (totals.get(worktreePath) ?? 0) + delta / 1000);
        }
      }
      lastActive.set(worktreePath, t);
      scheduleFlush();
    },
    get(worktreePath) {
      return Math.round(totals.get(worktreePath) ?? 0);
    },
    remove(worktreePath) {
      totals.delete(worktreePath);
      lastActive.delete(worktreePath);
      scheduleFlush();
    },
    flush,
  };
}
