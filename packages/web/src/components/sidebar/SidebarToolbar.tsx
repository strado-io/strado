// The row under the workspace switcher, above the Focuses: ⌕ Search (filters
// the Focus list and the worktrees in it; ⌥⌘F), then New focus and New
// worktree here. Flat and dim like the Focus rows, at their height; opening
// search keeps it.
import { useEffect, useRef, useState } from 'react';

const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const SearchIcon = () => <svg {...icon} width={13} height={13} className="shrink-0"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
// The Focus viewfinder's four corners round a +, drawn in the same weight
// and size as the compose icon beside it.
const NewFocusIcon = () => (
  <svg {...icon} width={14} height={14}>
    <path d="M3 8V5a2 2 0 0 1 2-2h3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M21 16v3a2 2 0 0 1-2 2h-3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M12 8v8" /><path d="M8 12h8" />
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

export function SidebarToolbar({ query, onQuery, onNewFocus, onNewWorktree, shortcut = true }: {
  query: string;
  onQuery: (q: string) => void;
  onNewFocus: () => void;
  /** New worktree here, in the active Focus; none without one (the button is disabled). */
  onNewWorktree?: () => void;
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
      <button type="button" aria-label="New focus" title="New focus (⇧⌘N)" onClick={onNewFocus} className={ICON_BUTTON}><NewFocusIcon /></button>
      <button type="button" aria-label="New worktree here" title="New worktree here" onClick={onNewWorktree} disabled={!onNewWorktree} className={ICON_BUTTON}><ComposeIcon /></button>
    </div>
  );
}
