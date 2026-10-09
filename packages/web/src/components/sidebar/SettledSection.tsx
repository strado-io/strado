// Finished work, pinned to the bottom of the sidebar: worktrees whose PR is
// merged or closed, and groups whose every PR is. They leave the repo tree and
// the Groups section so those stay about what is still in flight — still here
// to open or delete. SidebarBody decides what is settled and renders the rows.
import { useState } from 'react';
import { GroupList, type GroupListProps } from './GroupsView';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function SettledSection({ worktreeRows, ...groupList }: GroupListProps & {
  /** Settled worktree rows, already rendered. */
  worktreeRows: React.ReactNode[];
}) {
  const [open, setOpen] = useState(true);
  const count = groupList.groups.length + worktreeRows.length;
  if (count === 0) return null;
  return (
    <section aria-label="Settled" className="flex max-h-[40%] shrink-0 flex-col border-t border-zinc-900 px-2 pb-2 pt-2">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Settled (${count})`}
        className="group flex w-full items-center gap-2 rounded-md py-1 pl-2.5 pr-1 text-left text-xs text-zinc-500 hover:text-zinc-300">
        <span>Settled</span>
        <span className="font-mono text-[11px] tabular-nums text-zinc-600">{count}</span>
        <span aria-hidden className="h-px flex-1 bg-zinc-800" />
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden {...stroke}
          className={`shrink-0 transition-transform ${open ? '-rotate-90' : 'rotate-90'}`}><path d="M6 4l4 4-4 4" /></svg>
      </button>
      {open && (
        <div className="min-h-0 overflow-y-auto">
          {groupList.groups.length > 0 && <GroupList {...groupList} />}
          <div className="flex flex-col gap-0.5">{worktreeRows}</div>
        </div>
      )}
    </section>
  );
}
