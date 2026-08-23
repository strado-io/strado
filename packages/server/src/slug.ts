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
  if (ticket && cleaned) return `${ticket}_${cleaned}`;
  return ticket || cleaned || 'worktree';
}
