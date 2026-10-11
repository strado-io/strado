// Every worktree in the space, grouped by repo (and by runner for remote
// ones), collapsed under Working on. Working on only lists what you have
// opened, so this is where the rest can be found without ⌘K. Opening a card
// here puts it in Working on like any other open. SidebarBody renders the rows.
import { BottomSection } from './BottomSection';

export type WorktreeGroup = {
  key: string;
  /** Repo or runner name. */
  name: string;
  rows: React.ReactNode[];
};

export function AllWorktreesSection({ groups }: { groups: WorktreeGroup[] }) {
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  if (count === 0) return null;
  return (
    <BottomSection label="All worktrees" count={count} defaultOpen={false}>
      <div className="flex flex-col gap-2">
        {groups.filter((g) => g.rows.length > 0).map((g) => (
          <div key={g.key} role="group" aria-label={g.name}>
            <div className="truncate px-2.5 pb-1 pt-0.5 text-[11px] text-zinc-600">{g.name}</div>
            <div className="flex flex-col gap-1.5">{g.rows}</div>
          </div>
        ))}
      </div>
    </BottomSection>
  );
}
