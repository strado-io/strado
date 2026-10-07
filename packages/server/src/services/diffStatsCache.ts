import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DiffStats } from './gitChanges.js';

// The dashboard re-lists worktrees every 15s, and each listing used to run
// `git diff --shortstat HEAD` in every worktree: ~0.1s of CPU per call (git
// stats the whole tree), so 18 worktrees cost ~12% of a core with the app
// sitting idle. The answer only changes when a working-tree file changes or
// git moves HEAD/the index, so cache it on exactly that:
//
// - working tree: the activity watcher's change counter (unthrottled, ignores
//   .git/node_modules/build output). Null = not watched yet → never cache.
// - git state: stat of the worktree's own HEAD, index and logs/HEAD (the
//   reflog is appended by every commit, checkout, reset and rebase step).
//   Read through the `.git` file, so linked worktrees resolve to their own
//   gitdir. Plain fs stats — no process spawn.
//
// MAX_AGE_MS is the backstop for anything both miss (a tracked file under an
// ignored dir like build/, a raw update-ref).
const MAX_AGE_MS = 5 * 60_000;

export type DiffStatsCache = {
  get(worktreePath: string): Promise<DiffStats | null>;
  forget(worktreePath: string): void;
};

export function createDiffStatsCache(deps: {
  shortStat(worktreePath: string): Promise<DiffStats | null>;
  version(worktreePath: string): number | null;
  now?: () => number;
  maxAgeMs?: number;
}): DiffStatsCache {
  const now = deps.now ?? Date.now;
  const maxAgeMs = deps.maxAgeMs ?? MAX_AGE_MS;
  const entries = new Map<string, { key: string; at: number; value: DiffStats | null }>();
  const inflight = new Map<string, { key: string; promise: Promise<DiffStats | null> }>();

  return {
    async get(worktreePath) {
      const version = deps.version(worktreePath);
      const stamp = version === null ? null : await gitStamp(worktreePath);
      if (version === null || stamp === null) {
        entries.delete(worktreePath);
        return deps.shortStat(worktreePath);
      }
      // Read the counter BEFORE running git: a change that lands mid-diff
      // bumps it, so the next listing misses and recomputes.
      const key = `${version}|${stamp}`;
      const hit = entries.get(worktreePath);
      if (hit && hit.key === key && now() - hit.at < maxAgeMs) return hit.value;
      const running = inflight.get(worktreePath);
      if (running && running.key === key) return running.promise;
      const promise = deps.shortStat(worktreePath).then((value) => {
        entries.set(worktreePath, { key, at: now(), value });
        return value;
      }).finally(() => {
        if (inflight.get(worktreePath)?.promise === promise) inflight.delete(worktreePath);
      });
      inflight.set(worktreePath, { key, promise });
      return promise;
    },
    forget(worktreePath) {
      entries.delete(worktreePath);
      inflight.delete(worktreePath);
    },
  };
}

async function gitDir(worktreePath: string): Promise<string | null> {
  const dotGit = path.join(worktreePath, '.git');
  try {
    const st = await fsp.stat(dotGit);
    if (st.isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(dotGit, 'utf8'));
    return m ? path.resolve(worktreePath, m[1]!.trim()) : null;
  } catch {
    return null;
  }
}

async function gitStamp(worktreePath: string): Promise<string | null> {
  const dir = await gitDir(worktreePath);
  if (!dir) return null;
  const parts = await Promise.all(
    ['HEAD', 'index', path.join('logs', 'HEAD')].map(async (f) => {
      try {
        const st = await fsp.stat(path.join(dir, f));
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    }),
  );
  return parts.join('|');
}
