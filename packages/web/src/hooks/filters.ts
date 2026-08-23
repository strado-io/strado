import type { Worktree } from '../types';
import type { StatusFilter } from '../components/FilterBar';
import { hasSession } from './sessions';

export function isRunning(w: Worktree): boolean {
  return w.process.status === 'running' || w.process.status === 'starting' || !!w.process.external;
}

export function matchesStatus(w: Worktree, s: StatusFilter): boolean {
  if (s === 'all') return true;
  if (s === 'running') return isRunning(w);
  if (s === 'idle') return !isRunning(w);
  if (s === 'untracked') return !w.tracked;
  if (s === 'sessions') return hasSession(w);
  return true;
}

export function matchesQuery(w: Worktree, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const fields = [w.meta?.ticketId, w.meta?.title, w.branch, w.path].filter(Boolean) as string[];
  return fields.some((f) => f.toLowerCase().includes(needle));
}
