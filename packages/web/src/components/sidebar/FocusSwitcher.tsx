// The Focus pill at the top of the sidebar and the popover behind it. The
// pill names the active Focus ("No focus" when none). The popover is one
// field over the list: type to filter, pick to switch, type a new name and
// press Enter to create a blank one; New focus opens the composer. Rows are
// ordered by last use and the first nine carry ⌘1–⌘9 hints; each shows its
// repos, a status glyph and when it was last used, and Focuses whose PRs are
// all merged sit in a Done group at the bottom. Right-click a row to rename
// or delete it.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Focus } from '../../api';
import { MenuPopover, BrailleSpinner } from './rowBits';
import { RepoAvatar } from './WorktreeCard';
import { shortRelativeTime } from '../../lib/relativeTime';

/** What the switcher says about a Focus beyond its name: computed by SidebarBody from its members. */
export type FocusRowInfo = {
  repos: { id: string; name: string }[];
  /** needs-you: an agent is waiting; working: one is busy; done: every PR merged or closed. */
  status: 'needs-you' | 'working' | 'done' | null;
};

const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
// Lucide: focus.
export const FocusIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...icon} width={size} height={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" />
  </svg>
);
const CheckIcon = () => (<svg {...icon} width={12} height={12}><path d="M20 6 9 17l-5-5" /></svg>);
const PlusIcon = () => (<svg {...icon} width={14} height={14}><path d="M5 12h14" /><path d="M12 5v14" /></svg>);

export const byLastActive = (a: Focus, b: Focus) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0);

export function FocusPill({ focus, open, onClick, pillRef }: {
  focus: Focus | null;
  open: boolean;
  onClick: () => void;
  pillRef: React.RefObject<HTMLButtonElement>;
}) {
  return (
    <button ref={pillRef} type="button" onClick={onClick} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Focus: ${focus?.name ?? 'none'}`} title={focus ? `Focus: ${focus.name}. Click to switch.` : 'No focus. Click to create one.'}
      className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] ${
        focus ? 'text-zinc-200 hover:bg-zinc-900' : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'}`}>
      <span className={`shrink-0 ${focus ? 'text-sky-400' : 'text-zinc-600'}`}><FocusIcon /></span>
      {/* "Focus · name": a group of worktrees, not one that is open. */}
      <span className="min-w-0 flex-1 truncate">
        {focus ? <><span className="text-zinc-500">Focus · </span><span className="font-medium">{focus.name}</span></> : 'No focus'}
      </span>
      <svg {...icon} width={12} height={12} className="shrink-0 text-zinc-600"><path d="m6 9 6 6 6-6" /></svg>
    </button>
  );
}

export function FocusPopover({ anchor, focuses, activeId, rowInfo, onActivate, onCreate, onNewFocus, onRename, onDelete, onClose }: {
  /** The pill's rect; the popover hangs under it. */
  anchor: { left: number; bottom: number; width: number };
  focuses: Focus[];
  activeId: string | null;
  rowInfo?: Map<string, FocusRowInfo>;
  onActivate: (id: string) => void;
  /** A blank Focus from the field (Enter on a new name). */
  onCreate: (name: string) => void;
  /** The composer: from a ticket or worktrees. */
  onNewFocus: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; focus: Focus } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const sorted = [...focuses].sort(byLastActive);
  const isDone = (f: Focus) => rowInfo?.get(f.id)?.status === 'done';
  const q = query.trim().toLowerCase();
  const matching = q ? sorted.filter((f) => f.name.toLowerCase().includes(q)) : sorted;
  // Live ones first, then the Done group; ⌘ numbers stay by last use.
  const visible = [...matching.filter((f) => !isDone(f)), ...matching.filter(isDone)];
  const exact = sorted.some((f) => f.name.toLowerCase() === q);
  const canCreate = q.length > 0 && !exact;
  // What ↑/↓/Enter walk: the matching rows, then "Create" when the name is new.
  const options: ({ kind: 'focus'; focus: Focus } | { kind: 'create' })[] = [
    ...visible.map((focus) => ({ kind: 'focus' as const, focus })),
    ...(canCreate ? [{ kind: 'create' as const }] : []),
  ];
  const selIdx = Math.min(sel, Math.max(0, options.length - 1));

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !rowMenu && !renaming) onClose(); };
    const onDown = (e: MouseEvent) => {
      if (rowMenu) return; // the row menu is portalled elsewhere; it closes itself
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [onClose, rowMenu, renaming]);

  const choose = (o: (typeof options)[number]) => {
    if (o.kind === 'focus') onActivate(o.focus.id);
    else onCreate(query.trim());
    onClose();
  };
  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = options[selIdx]; if (o) choose(o); }
  };
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 288));
  const width = Math.max(272, Math.min(anchor.width, 360));

  return createPortal(
    <div ref={root} role="dialog" aria-label="Switch focus"
      className="fixed z-50 flex flex-col rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 shadow-xl"
      style={{ left, top: anchor.bottom + 4, width }}>
      <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 focus-within:border-zinc-600">
        <span className="shrink-0 text-zinc-600"><FocusIcon size={13} /></span>
        <input ref={input} value={query} aria-label="Filter or create"
          placeholder="Filter or create…"
          onChange={(e) => { setQuery(e.target.value); setSel(0); }} onKeyDown={onInputKey}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none" />
      </div>
      <div className="mt-1.5 flex max-h-72 flex-col gap-px overflow-y-auto">
        {options.length === 0 && (
          <p className="px-2 py-2 text-xs text-zinc-600">{focuses.length === 0 ? 'No focuses yet.' : 'No match.'}</p>
        )}
        {options.map((o, i) => {
          const hl = i === selIdx;
          if (o.kind === 'create') {
            return (
              <button key="create" type="button" onClick={() => choose(o)} onMouseEnter={() => setSel(i)}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${hl ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'}`}>
                <span className="flex w-4 shrink-0 justify-center text-zinc-500"><PlusIcon /></span>
                <span className="min-w-0 flex-1 truncate">Create “{query.trim()}”</span>
              </button>
            );
          }
          const f = o.focus;
          const n = sorted.indexOf(f) + 1;
          const active = f.id === activeId;
          const info = rowInfo?.get(f.id);
          const firstDone = isDone(f) && (i === 0 || !isDone((options[i - 1] as { focus?: Focus }).focus ?? f));
          if (renaming?.id === f.id) {
            return (
              <form key={f.id} className="flex items-center gap-2 px-2 py-1"
                onSubmit={(e) => { e.preventDefault(); const name = renaming.name.trim(); if (name && name !== f.name) onRename(f.id, name); setRenaming(null); input.current?.focus(); }}>
                <span className="w-4 shrink-0" />
                <input autoFocus aria-label={`Rename ${f.name}`} value={renaming.name}
                  onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); input.current?.focus(); } }}
                  onBlur={() => setRenaming(null)}
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-sm text-zinc-100 focus:outline-none" />
              </form>
            );
          }
          return (
            <div key={f.id} className="contents">
              {firstDone && <div className="mt-1 px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Done</div>}
              <button type="button" aria-current={active ? 'true' : undefined} onClick={() => choose(o)} onMouseEnter={() => setSel(i)}
                onContextMenu={(e) => { e.preventDefault(); setRowMenu({ x: e.clientX, y: e.clientY, focus: f }); }}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${hl ? 'bg-zinc-800 text-zinc-100' : active ? 'text-zinc-100' : isDone(f) ? 'text-zinc-500' : 'text-zinc-300'}`}>
                <span className={`flex w-4 shrink-0 justify-center ${active ? 'text-sky-400' : 'text-transparent'}`}><CheckIcon /></span>
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {info && info.repos.length > 0 && (
                  <span className="flex shrink-0 -space-x-1" title={info.repos.map((r) => r.name).join(', ')}>
                    {info.repos.slice(0, 3).map((r) => <RepoAvatar key={r.id} id={r.id} name={r.name} />)}
                  </span>
                )}
                {info?.status === 'needs-you' && <span className="shrink-0 text-[11px] text-amber-400" title="An agent is waiting on you">⚑</span>}
                {info?.status === 'working' && <span className="shrink-0" title="An agent is working"><BrailleSpinner small /></span>}
                {info?.status === 'done' && <span className="shrink-0 text-[11px] text-emerald-500" title="Every PR merged">✔</span>}
                {f.members.length > 0 && <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-600">{f.members.length}</span>}
                <span className="w-7 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(f.lastActiveAt)}</span>
                {n <= 9 && <span className="shrink-0 font-mono text-[11px] text-zinc-600">⌘{n}</span>}
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-col gap-px border-t border-zinc-800 pt-1.5">
        <button type="button" onClick={() => { onNewFocus(); onClose(); }}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
          <span className="flex w-4 shrink-0 justify-center text-zinc-500"><PlusIcon /></span>
          <span className="min-w-0 flex-1 truncate">New focus</span>
          <span className="shrink-0 font-mono text-[11px] text-zinc-600">⇧⌘N</span>
        </button>
      </div>
      {rowMenu && (
        <MenuPopover pos={rowMenu} anchor="left" onClose={() => setRowMenu(null)} items={[
          { text: 'Rename', onClick: () => setRenaming({ id: rowMenu.focus.id, name: rowMenu.focus.name }) },
          { text: 'Delete focus', danger: true, onClick: () => {
            const n = rowMenu.focus.members.length;
            if (n === 0 || confirm(`Delete "${rowMenu.focus.name}"? Its ${n} worktree${n === 1 ? '' : 's'} stay where they are.`)) onDelete(rowMenu.focus.id);
          } },
        ]} />
      )}
    </div>,
    document.body,
  );
}
