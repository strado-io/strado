import type { Worktree } from '../types';

export function sortByOrder(worktrees: Worktree[]): Worktree[] {
  return worktrees
    .map((w, i) => ({ w, i, eff: w.meta?.order ?? i }))
    .sort((a, b) => a.eff - b.eff || a.i - b.i)
    .map((x) => x.w);
}

// A drop rewrites the WHOLE context with explicit 0..n-1 orders (only rows
// whose order actually changes are emitted). Fractional midpoints between
// "effective" orders looked cheaper, but rows without an explicit order fall
// back to their STATE-array index at render time and their DISPLAY index in
// any local math — the two disagree after the first drag, sending later
// drops to the wrong slot. Materializing the sequence removes the ambiguity.
export function computeReorderPatches(
  sorted: Worktree[],
  draggedPath: string,
  targetPath: string,
  place: 'before' | 'after',
): { path: string; order: number }[] {
  if (draggedPath === targetPath) return [];
  if (!sorted.some((w) => w.path === draggedPath)) return [];
  const seq = sorted.map((w) => w.path).filter((p) => p !== draggedPath);
  const ti = seq.indexOf(targetPath);
  if (ti === -1) return [];
  seq.splice(place === 'before' ? ti : ti + 1, 0, draggedPath);

  const byPath = new Map(sorted.map((w) => [w.path, w]));
  const desired = seq.map((path, i) => ({ path, order: i }));
  // If nothing moves, patch nothing (drop on an adjacent edge is a no-op).
  if (desired.every(({ path }, i) => sorted[i]!.path === path)) return [];
  // Untracked rows are included: PATCHing an order auto-adopts them
  // server-side, so a mixed backlog reorders as a whole.
  return desired.filter(({ path, order }) => byPath.get(path)!.meta?.order !== order);
}

export function dropPlace(clientY: number, rect: { top: number; height: number }): 'before' | 'after' {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}
