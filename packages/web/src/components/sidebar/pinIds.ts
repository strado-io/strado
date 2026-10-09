import type { RemoteWorktree } from '../../api';
import type { Worktree } from '../../types';

// Stable ids for a sidebar worktree across local and runner rows. Pins and
// focus-group members are stored as these.
export const localPinId = (w: Worktree) => `local:${w.path}`;
export const remotePinId = (w: RemoteWorktree) => `remote:${w.runnerId}:${w.path}`;

export type SidebarEntry =
  | { kind: 'local'; pinId: string; repoId: string | null; w: Worktree }
  | { kind: 'remote'; pinId: string; repoId: string | null; w: RemoteWorktree };
