// The active focus group, pinned above the rest of the rail: the 2-3
// worktrees (any repo) of the task at hand. Presentational — SidebarBody owns
// the data and renders each member row.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FocusGroup } from '../../api';
import type { SidebarEntry } from './pinIds';

export type FocusSectionProps = {
  groups: FocusGroup[];
  activeGroup: FocusGroup | null;
  members: SidebarEntry[];
  isDone: (g: FocusGroup) => boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onActivate: (id: string | null) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  renderMember: (e: SidebarEntry) => React.ReactNode;
};

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function NameInput({ label, initial, onSubmit, onCancel }: {
  label: string; initial: string; onSubmit: (v: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) onSubmit(value.trim());
        else if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      }}
      className="mx-1 my-1 block w-[calc(100%-0.5rem)] rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-sky-500"
    />
  );
}

function Picker({ anchor, groups, activeGroup, isDone, onClose, onActivate, onCreate, onRename, onDelete }: {
  anchor: { x: number; y: number };
  onClose: () => void;
} & Pick<FocusSectionProps, 'groups' | 'activeGroup' | 'isDone' | 'onActivate' | 'onCreate' | 'onRename' | 'onDelete'>) {
  const [editing, setEditing] = useState<'new' | 'rename' | null>(null);
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const open = groups.filter((g) => !isDone(g));
  const done = groups.filter((g) => isDone(g));
  const item = 'block w-full rounded px-2 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-900';
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="menu"
        aria-label="Focus groups"
        className="fixed z-50 w-60 rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
        style={{ left: anchor.x, top: anchor.y }}
      >
        {open.map((g) => (
          <button key={g.id} role="menuitemradio" aria-checked={activeGroup?.id === g.id}
            onClick={() => { onActivate(g.id); onClose(); }}
            className={`${item} flex items-center gap-2`}>
            <span className="w-3 shrink-0 text-sky-400">{activeGroup?.id === g.id ? '✓' : ''}</span>
            <span className="min-w-0 flex-1 truncate">{g.name}</span>
          </button>
        ))}
        {done.length > 0 && (
          <>
            <button role="menuitem" onClick={() => setShowDone((v) => !v)} className={`${item} text-zinc-500`}>
              {`Done (${done.length})`}
            </button>
            {showDone && done.map((g) => (
              <div key={g.id} className="flex items-center gap-1 pl-5 pr-1">
                <button role="menuitemradio" aria-checked={activeGroup?.id === g.id}
                  onClick={() => { onActivate(g.id); onClose(); }}
                  className={`${item} min-w-0 flex-1 truncate text-zinc-500`}>{g.name}</button>
                <button type="button" aria-label={`Delete ${g.name}`} onClick={() => onDelete(g.id)}
                  className="shrink-0 rounded px-1.5 py-1 text-xs text-red-300 hover:bg-zinc-900">Delete</button>
              </div>
            ))}
          </>
        )}
        <div className="my-1 border-t border-zinc-900" />
        {editing === 'new' ? (
          <NameInput label="New group name" initial="" onCancel={() => setEditing(null)}
            onSubmit={(v) => { onCreate(v); onClose(); }} />
        ) : (
          <button role="menuitem" onClick={() => setEditing('new')} className={item}>New group…</button>
        )}
        {activeGroup && (editing === 'rename' ? (
          <NameInput label="Group name" initial={activeGroup.name} onCancel={() => setEditing(null)}
            onSubmit={(v) => { onRename(activeGroup.id, v); onClose(); }} />
        ) : (
          <>
            <button role="menuitem" onClick={() => setEditing('rename')} className={item}>Rename…</button>
            <button role="menuitem" className={`${item} text-red-300`}
              onClick={() => { if (confirm(`Delete focus group "${activeGroup.name}"? Worktrees are not touched.`)) { onDelete(activeGroup.id); onClose(); } }}>
              Delete group
            </button>
            <button role="menuitem" onClick={() => { onActivate(null); onClose(); }} className={item}>Clear focus</button>
          </>
        ))}
      </div>
    </>,
    document.body,
  );
}

export function FocusSection(props: FocusSectionProps) {
  const { groups, activeGroup, members, isDone, collapsed, onToggleCollapsed, onDelete, renderMember } = props;
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  useEffect(() => setKept(null), [activeGroup?.id]);
  if (groups.length === 0) return null;

  const openPicker = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom });
  };
  const picker = anchor && <Picker {...props} anchor={anchor} onClose={() => setAnchor(null)} />;

  if (!activeGroup) {
    return (
      <div className="mt-4 pl-1 pr-1">
        <button type="button" onClick={openPicker}
          className="h-6 rounded px-1.5 font-mono text-[12px] text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300">
          Focus: none ▾
        </button>
        {picker}
      </div>
    );
  }

  const done = isDone(activeGroup) && kept !== activeGroup.id;
  return (
    <section aria-label="Focus group" className="mt-4">
      <div className="mb-1 flex items-center gap-1 pl-1 pr-1">
        <button type="button" aria-label={collapsed ? 'Expand focus group' : 'Collapse focus group'}
          onClick={onToggleCollapsed} className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden {...stroke}
            className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}><path d="M6 4l4 4-4 4" /></svg>
        </button>
        <button type="button" aria-label={`Focus group ${activeGroup.name}`} onClick={openPicker}
          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded px-1.5 text-left font-mono text-[12px] text-zinc-300 hover:bg-zinc-900">
          <span className="min-w-0 truncate">{activeGroup.name}</span>
          <span className="shrink-0 text-zinc-600">▾</span>
        </button>
        <span className="shrink-0 pr-1 font-mono text-[11px] tabular-nums text-zinc-600">{members.length}</span>
      </div>
      {done && (
        <div className="mb-1 flex items-center gap-2 rounded-md bg-zinc-900/60 px-2.5 py-1.5 text-xs text-emerald-400">
          <span className="min-w-0 flex-1">All merged ✓</span>
          <button type="button" onClick={() => onDelete(activeGroup.id)} className="text-red-300 hover:underline">Delete group</button>
          <button type="button" onClick={() => setKept(activeGroup.id)} className="text-zinc-400 hover:underline">Keep</button>
        </div>
      )}
      {!collapsed && <div className="flex flex-col gap-0.5">{members.map((m) => renderMember(m))}</div>}
      {picker}
    </section>
  );
}
