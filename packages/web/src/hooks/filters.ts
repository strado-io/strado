import type { Worktree } from '../types';

export function isRunning(w: Worktree): boolean {
  const s = w.process.status;
  // 'stopping' still holds its port — it belongs in the running list until it is gone.
  return s === 'running' || s === 'starting' || s === 'stopping' || !!w.process.external;
}

export function matchesQuery(w: Worktree, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const fields = [w.meta?.ticketId, w.meta?.title, w.branch, w.path].filter(Boolean) as string[];
  return fields.some((f) => f.toLowerCase().includes(needle));
}
