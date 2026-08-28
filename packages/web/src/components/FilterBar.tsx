export type StatusFilter = 'all' | 'running' | 'untracked' | 'idle' | 'sessions';
export type Density = 'comfy' | 'compact';

export type Props = {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
};

// The toolbar row: view-specific actions. (Global search is the ⌘K palette;
// there is no on-screen search trigger.)
// Constant height regardless of content — the sidebar toggle adds/removes the
// leading » button, and the table below must not jump (same rule as the hub's
// tab row in TerminalView).
export function FilterBar({ leading, trailing }: Props) {
  return (
    <div data-filter-bar className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-zinc-900 px-4 py-1.5">
      <div className="flex flex-1 items-center gap-3">
        {leading}
      </div>

      {trailing && <div className="flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
