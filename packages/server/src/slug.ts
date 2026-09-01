// Title → snake token: everything non-alphanumeric collapses to '_'.
function slugifyTitle(s: string): string {
  return s
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Ticket → branch-safe token, but keep hyphens (Jira keys like FD-12 and
// free-form ids like ONBOARD-fix read better with them, and git allows them).
function slugifyTicket(s: string): string {
  return s
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
}

// Branch / worktree-folder name. The ticket id is optional and free-form: when
// present it prefixes the title (`FD-12_fix_header`), when blank the branch is
// just the slugified title (`fix_header`). Falls back to 'worktree' only if
// both are empty.
export function buildWorktreeSlug(ticketId: string, title: string): string {
  const ticket = slugifyTicket(ticketId);
  const cleaned = slugifyTitle(title);
  const full = ticket && cleaned ? `${ticket}_${cleaned}` : ticket || cleaned || 'worktree';
  if (full.length <= MAX_WORKTREE_SLUG_LENGTH) return full;

  // Two long descriptions can share the same beginning. A suffix derived
  // from the full slug prevents truncation from making them the same branch.
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 8);
  const prefixLength = MAX_WORKTREE_SLUG_LENGTH - hash.length - 1;
  const prefix = full.slice(0, prefixLength).replace(/[_-]+$/g, '');
  return `${prefix}_${hash}`;
}
import { createHash } from 'node:crypto';

// Keeps branch names readable in Git UIs and safely below common filesystem
// component limits even when a whole task description is pasted into Title.
export const MAX_WORKTREE_SLUG_LENGTH = 80;
