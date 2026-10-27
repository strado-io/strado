// The row under the workspace switcher, above the Focuses: ⌕ Search (filters
// the Focus list and the worktrees in it; ⌥⌘F), then Add project and New (a
// Focus or a worktree, one composer). Flat and dim like the Focus rows, at
// their height; opening search keeps it.
import { useEffect, useRef, useState } from 'react';

const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const SearchIcon = () => <svg {...icon} width={13} height={13} className="shrink-0"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
const FolderPlusIcon = () => (
  <svg {...icon} width={14} height={14}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 10v6" /><path d="M9 13h6" />
  </svg>
);
const ComposeIcon = () => (
  <svg {...icon} width={14} height={14}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
  </svg>
);

const ICON_BUTTON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-[rgb(var(--pane-edge)/0.06)] hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-40';
const FIELD = 'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-[12.5px]';

/** ⌥⌘F (⌘⇧F is the Files tab's search): open the sidebar's search. */
export const isSidebarSearchKey = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === 'KeyF';

export function SidebarToolbar({ query, onQuery, onAddProject, onNew, shortcut = true }: {
  query: string;
  onQuery: (q: string) => void;
  /** Add repo, anchored under the button. */
  onAddProject: (anchor: { left: number; right: number; bottom: number }) => void;
  /** The composer: a new Focus or a new worktree. */
  onNew: () => void;
  /** Answer ⌥⌘F: only the active pane of the space carousel does. */
  shortcut?: boolean;
}) {
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const open = searching || query !== '';
  useEffect(() => { if (searching) input.current?.focus(); }, [searching]);
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarSearchKey(e)) return;
      e.preventDefault();
      setSearching(true);
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  return (
    <div data-testid="sidebar-toolbar" className="flex h-8 shrink-0 items-center gap-0.5 px-2">
      {open ? (
        <label className={`${FIELD} bg-[rgb(var(--pane-edge)/0.05)] text-zinc-500`}>
          <SearchIcon />
          <input ref={input} aria-label="Search focuses and worktrees" placeholder="Search" value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              onQuery('');
              setSearching(false);
              e.currentTarget.blur();
            }}
            onBlur={() => setSearching(false)}
            className="h-full min-w-0 flex-1 bg-transparent text-zinc-200 placeholder:text-zinc-600 focus:outline-none" />
        </label>
      ) : (
        <button type="button" onClick={() => setSearching(true)} title="Search (⌥⌘F)"
          className={`${FIELD} text-left text-zinc-500 hover:bg-[rgb(var(--pane-edge)/0.05)] hover:text-zinc-300`}>
          <SearchIcon />Search
        </button>
      )}
      <button type="button" aria-label="Add project" title="Add project" className={ICON_BUTTON}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onAddProject({ left: r.left, right: r.right, bottom: r.bottom }); }}><FolderPlusIcon /></button>
      <button type="button" aria-label="New" title="New (⇧⌘N)" onClick={onNew} className={ICON_BUTTON}><ComposeIcon /></button>
    </div>
  );
}
