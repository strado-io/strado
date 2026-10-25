// What a failed Files call says. Never the raw message: for a runner's
// worktree that is whatever its rpc proxy relayed. Only the error code counts.
export function filesError(err: unknown, what: 'file' | 'folder'): string {
  const code = (err as { code?: unknown })?.code;
  if (code === 'NOT_FOUND') return what === 'file' ? 'This file no longer exists.' : 'This folder no longer exists.';
  if (code === 'PATH_FORBIDDEN' || code === 'FORBIDDEN' || code === 'VALIDATION') return 'Outside this worktree.';
  return what === 'file' ? 'Couldn’t read this file.' : 'Couldn’t list this folder.';
}
