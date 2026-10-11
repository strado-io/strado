// The rows of a list of groups: a foldable header with a menu, and the members.
// Working on and Settled both render through GroupList.
// Presentational — SidebarBody owns the data, member rows and ⋯ menus.
import { useState } from 'react';
import type { FocusGroup } from '../../api';
import type { SidebarEntry } from './pinIds';

export type MenuItem = { text: string; danger?: boolean; onClick: () => void };

export type GroupListBaseProps = {
  groups: FocusGroup[];
  activeGroupId: string | null;
  isDone: (g: FocusGroup) => boolean;
  membersOf: (g: FocusGroup) => SidebarEntry[];
  collapsedIds: string[];
  onToggleCollapsed: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  renderMember: (e: SidebarEntry, g: FocusGroup) => React.ReactNode;
  renderMenu: (label: string, items: MenuItem[]) => React.ReactNode;
};

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function RenameInput({ initial, onSubmit, onCancel }: {
  initial: string; onSubmit: (v: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      aria-label="Group name"
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) onSubmit(value.trim());
        else if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      }}
      className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-sky-500"
    />
  );
}

/** The rows of some groups: a foldable header (rename/park/delete menu) and the members. */
export type GroupListProps = Pick<GroupListBaseProps,
  'activeGroupId' | 'isDone' | 'membersOf' | 'collapsedIds' | 'onToggleCollapsed'
  | 'onRename' | 'onDelete' | 'renderMember' | 'renderMenu'> & {
  groups: FocusGroup[];
  /** Working on only: parks the group (it leaves the sidebar until opened again). */
  onPark?: (id: string) => void;
};

export function GroupList({
  groups, activeGroupId, isDone, membersOf, collapsedIds, onToggleCollapsed,
  onRename, onDelete, onPark, renderMember, renderMenu,
}: GroupListProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const group = (g: FocusGroup) => {
    const members = membersOf(g);
    const open = !collapsedIds.includes(g.id);
    const done = isDone(g);
    const active = g.id === activeGroupId;
    return (
      <div key={g.id} role="group" aria-label={g.name}>
        <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-zinc-900">
          {renaming === g.id ? (
            <div className="flex min-w-0 flex-1 items-center px-1 py-1">
              <RenameInput initial={g.name} onCancel={() => setRenaming(null)}
                onSubmit={(v) => { setRenaming(null); onRename(g.id, v); }} />
            </div>
          ) : (
            <button onClick={() => onToggleCollapsed(g.id)} aria-expanded={open}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${done ? 'text-zinc-500' : 'text-zinc-300'}`}>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center text-zinc-500">
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden {...stroke}
                  className={`transition-transform ${open ? 'rotate-90' : ''}`}><path d="M6 4l4 4-4 4" /></svg>
              </span>
              <span className="min-w-0 flex-1 truncate font-mono">{g.name}</span>
              {active && <span title="⌥⌘← / → cycles this group" className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />}
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-600">{members.length}</span>
            </button>
          )}
          {renderMenu(`${g.name} group actions`, [
            { text: 'Rename…', onClick: () => setRenaming(g.id) },
            ...(onPark ? [{ text: 'Park', onClick: () => onPark(g.id) }] : []),
            {
              text: 'Delete group', danger: true,
              onClick: () => { if (confirm(`Delete focus group "${g.name}"? Worktrees are not touched.`)) onDelete(g.id); },
            },
          ])}
        </div>
        {open && (
          <div className="flex flex-col gap-1.5 pb-1">
            {members.length === 0
              ? <div className="py-1 pl-9 pr-2 text-xs text-zinc-600">Empty — add worktrees from their ⋯ menu.</div>
              : members.map((m) => renderMember(m, g))}
          </div>
        )}
      </div>
    );
  };
  return <div className="flex flex-col gap-0.5">{groups.map(group)}</div>;
}
