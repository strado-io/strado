// Client-side LRU of when each worktree was last opened into the hub, plus the
// palette's ranking comparator. Keyed by absolute worktree path (unique across
// workspaces). Purely localStorage — no server involvement.
const KEY = 'strado:worktree-lru';

export function readWorktreeLru(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function bumpWorktreeOpened(path: string, now: number = Date.now()): void {
  try {
    const map = readWorktreeLru();
    map[path] = now;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // storage unavailable/full — ranking just loses this one signal
  }
}

export type RankableWorktree = { path: string; active: boolean; index: number };

// Active first, then most-recently-opened, then original order (stable).
export function compareByActivityThenRecency(
  a: RankableWorktree,
  b: RankableWorktree,
  lru: Record<string, number>,
): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  const la = lru[a.path] ?? 0;
  const lb = lru[b.path] ?? 0;
  if (la !== lb) return lb - la;
  return a.index - b.index;
}
