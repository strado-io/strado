// Finished work, pinned to the bottom of the sidebar: worktrees whose PR is
// merged or closed. They leave Working on so it stays about what is still in
// flight, and are still here to open or delete. SidebarBody decides what is
// settled and renders the rows.
import { BottomSection } from './BottomSection';

export function SettledSection({ worktreeRows }: {
  /** Settled worktree rows, already rendered. */
  worktreeRows: React.ReactNode[];
}) {
  if (worktreeRows.length === 0) return null;
  return (
    <BottomSection label="Settled" count={worktreeRows.length} defaultOpen>
      <div className="flex flex-col gap-1.5">{worktreeRows}</div>
    </BottomSection>
  );
}
