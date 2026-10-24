// The row under the sidebar's title: the Focus as a caption over the cards
// ("STRADO MCP ▾") with New worktree at the right. A caption, not a box: the
// cards below are the surfaces. Sections below have no buttons of their own.
const icon = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

// Lucide: plus.
const PlusIcon = () => (
  <svg {...icon}><path d="M5 12h14" /><path d="M12 5v14" /></svg>
);

const iconButton = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200';

export function SidebarToolbar({ leading, onNewWorktree }: {
  /** The Focus pill. */
  leading: React.ReactNode;
  onNewWorktree: () => void;
}) {
  return (
    <div data-testid="focus-bar" className="mx-2 flex h-7 shrink-0 items-center gap-1">
      {leading}
      <span className="flex-1" />
      <button type="button" aria-label="New worktree" title="New worktree" onClick={onNewWorktree} className={iconButton}><PlusIcon /></button>
    </div>
  );
}
