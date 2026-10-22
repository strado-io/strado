// The row under the sidebar's title: the Focus pill on the left, then New
// worktree. Sections below have no buttons of their own.
const icon = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

// Lucide: square-pen.
const PenIcon = () => (
  <svg {...icon}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
  </svg>
);

const iconButton = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200';

export function SidebarToolbar({ leading, onNewWorktree }: {
  /** The Focus pill. */
  leading: React.ReactNode;
  onNewWorktree: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 pl-2 pr-3">
      {leading}
      <button type="button" aria-label="New worktree" title="New worktree" onClick={onNewWorktree} className={iconButton}><PenIcon /></button>
    </div>
  );
}
