import type { Worktree } from '../../types';

/** What a worktree is called in the rail: its ticket, else its branch, else its folder. */
export function worktreeLabel(w: Worktree): string {
  return w.meta?.ticketId?.trim() || w.branch || w.path.split('/').pop() || w.path;
}

// The human title stored at create time is a slug (e.g.
// "update-role-permissions-for-vt"); show it readably.
export function worktreeTitle(w: Worktree): string {
  const t = w.meta?.title?.trim();
  if (!t) return '';
  const pretty = t.replace(/[-_]+/g, ' ').trim();
  // Don't echo the ticket id back as the title (some worktrees store it there).
  return pretty && pretty !== w.meta?.ticketId?.trim() ? pretty : '';
}
