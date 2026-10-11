// The row under the sidebar's title: Search on the left (opens ⌘K), and the
// two things you can make on the right. Sections below have no buttons of
// their own, so this is the one place to add a repo or start a worktree.
import type { AddRepoAnchor } from '../Sidebar';

const icon = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

// Lucide: search, folder, square-pen.
const SearchIcon = () => (<svg {...icon} width={14} height={14}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>);
const FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const FolderIcon = () => (<svg {...icon}><path d={FOLDER} /></svg>);
const PenIcon = () => (
  <svg {...icon}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
  </svg>
);

const iconButton = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200';

export function SidebarToolbar({ onSearch, onAddRepo, onNewWorktree }: {
  onSearch: () => void;
  onAddRepo: (anchor: AddRepoAnchor) => void;
  onNewWorktree: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 px-3">
      {/* A button styled as a quiet field: the palette is the real input. */}
      <button type="button" aria-label="Search" title="Search (⌘K)" onClick={onSearch}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-zinc-500 hover:text-zinc-300">
        <SearchIcon />
        <span className="truncate">Search</span>
      </button>
      <button type="button" aria-label="Add repo" title="Add repo" className={iconButton}
        onClick={(e) => { const { left, right, bottom } = e.currentTarget.getBoundingClientRect(); onAddRepo({ left, right, bottom }); }}>
        <FolderIcon />
      </button>
      <button type="button" aria-label="New worktree" title="New worktree" onClick={onNewWorktree} className={iconButton}><PenIcon /></button>
    </div>
  );
}
