import type { Worktree } from '../../types';

/** What a worktree is called in the rail: its ticket, else its branch, else its folder. */
export function worktreeLabel(w: Worktree): string {
  return w.meta?.ticketId?.trim() || w.branch || w.path.split('/').pop() || w.path;
}

/** Loose match: the title is a prettified slug, its source often is not. */
const sameWords = (a: string, b: string | undefined | null): boolean =>
  !!b && a.toLowerCase().replace(/[\s._-]+/g, ' ').trim() === b.toLowerCase().replace(/[\s._-]+/g, ' ').trim();

// The human title stored at create time is a slug (e.g.
// "update-role-permissions-for-vt"); show it readably.
export function worktreeTitle(w: Worktree, repoName?: string): string {
  const t = w.meta?.title?.trim();
  if (!t) return '';
  const pretty = t.replace(/[-_]+/g, ' ').trim();
  if (!pretty) return '';
  // A title that only echoes something already on screen — the ticket id in
  // the label, the branch, or the repo heading this row sits under — costs the
  // name its width and says nothing. `main · Strado Website` under a "Strado
  // Website" heading, or `test · test`, are both this.
  if (sameWords(pretty, w.meta?.ticketId?.trim())) return '';
  if (sameWords(pretty, w.branch)) return '';
  if (sameWords(pretty, repoName)) return '';
  return pretty;
}

/**
 * The two lines of a worktree card. The title is the most human thing we have
 * (readable title, else ticket id, else branch, else folder); the subtitle is
 * the branch when the title is not already it, else the folder when that says
 * something new, else nothing. A card never repeats itself.
 */
export function cardLines(w: Worktree, repoName?: string): { title: string; subtitle: string } {
  const folder = w.path.split('/').pop() || w.path;
  const title = worktreeTitle(w, repoName) || worktreeLabel(w);
  if (w.branch && title !== w.branch) return { title, subtitle: w.branch };
  return { title, subtitle: folder !== title ? folder : '' };
}
