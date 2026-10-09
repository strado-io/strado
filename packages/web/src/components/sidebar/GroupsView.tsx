// The sidebar's Groups view: every focus group with its worktrees (any repo)
// under it, the way the Repos view lists a repo's worktrees. Presentational —
// SidebarBody owns the data, renders each member row and the ⋯ menus.
import { useState } from 'react';
import type { FocusGroup } from '../../api';
import { PlusIcon } from '../hub/icons';
import { NewGroupDialog, type GroupCandidate } from './NewGroupDialog';
import type { SidebarEntry } from './pinIds';

export type MenuItem = { text: string; danger?: boolean; onClick: () => void };

export type GroupsViewProps = {
  groups: FocusGroup[];
  activeGroupId: string | null;
  isDone: (g: FocusGroup) => boolean;
  membersOf: (g: FocusGroup) => SidebarEntry[];
  collapsedIds: string[];
  onToggleCollapsed: (id: string) => void;
  /** Worktrees the New group dialog offers to start a group with. */
  candidates: GroupCandidate[];
  onCreate: (name: string, members: string[]) => void;
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

export function GroupsView({
  groups, activeGroupId, isDone, membersOf, collapsedIds, onToggleCollapsed,
  candidates, onCreate, onRename, onDelete, renderMember, renderMenu,
}: GroupsViewProps) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Open groups first; finished ones sink to the bottom, still deletable.
  const ordered = [...groups.filter((g) => !isDone(g)), ...groups.filter((g) => isDone(g))];

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
              {done
                ? <span className="shrink-0 text-[11px] text-emerald-500/80">merged ✓</span>
                : <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-600">{members.length}</span>}
            </button>
          )}
          {renderMenu(`${g.name} group actions`, [
            { text: 'Rename…', onClick: () => setRenaming(g.id) },
            {
              text: 'Delete group', danger: true,
              onClick: () => { if (confirm(`Delete focus group "${g.name}"? Worktrees are not touched.`)) onDelete(g.id); },
            },
          ])}
        </div>
        {open && (
          <div className="flex flex-col gap-0.5">
            {members.length === 0
              ? <div className="py-1 pl-9 pr-2 text-xs text-zinc-600">Empty — add worktrees from their ⋯ menu.</div>
              : members.map((m) => renderMember(m, g))}
          </div>
        )}
      </div>
    );
  };

  return (
    <section aria-label="Focus groups">
      <div className="mb-1 mt-4 flex items-center justify-between pl-2.5 pr-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Groups</span>
        <button onClick={() => setCreating(true)} aria-label="New group" title="New group"
          className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300">
          <PlusIcon size={12} />
        </button>
      </div>
      {ordered.length === 0 ? (
        <div className="px-2.5 py-2 text-xs leading-relaxed text-zinc-600">
          No groups yet. Bundle worktrees from different repos for one task: press + or use a worktree's ⋯ menu → Add to new group.
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">{ordered.map(group)}</div>
      )}
      {creating && (
        <NewGroupDialog candidates={candidates} onCancel={() => setCreating(false)}
          onCreate={(name, members) => { setCreating(false); onCreate(name, members); }} />
      )}
    </section>
  );
}
