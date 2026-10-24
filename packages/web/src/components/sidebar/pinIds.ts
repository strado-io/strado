import type { RemoteWorktree } from '../../api';
import type { Worktree } from '../../types';

// Stable ids for a sidebar worktree across local and runner rows. Pins and
// focus-group members are stored as these.
export const localPinId = (w: Worktree) => `local:${w.path}`;
export const remotePinId = (w: RemoteWorktree) => `remote:${w.runnerId}:${w.path}`;

/** The pin id of a worktree a create job just made, from the job's result
 *  (`{ path }`, plus `runnerId` when it was made on a runner); null when the
 *  result doesn't say. */
export function createdPinId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const { path, runnerId } = result as { path?: unknown; runnerId?: unknown };
  if (typeof path !== 'string' || !path) return null;
  return typeof runnerId === 'string' && runnerId ? `remote:${runnerId}:${path}` : `local:${path}`;
}

export type SidebarEntry =
  | { kind: 'local'; pinId: string; repoId: string | null; w: Worktree }
  | { kind: 'remote'; pinId: string; repoId: string | null; w: RemoteWorktree };
