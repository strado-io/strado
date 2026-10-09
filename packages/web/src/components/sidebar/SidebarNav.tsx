// The sidebar's page switcher: one row of icons at the bottom (Tasks, Code
// reviews, Usage, and a gear for the settings / account menu), so the rail
// above is all groups and worktrees.
import type { SidebarView } from '../Sidebar';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const tasksIcon = (<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden {...stroke}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.5" /></svg>);
const reviewsIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
    <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z" />
  </svg>
);
// A gauge: the quota dial the Usage page is mostly about.
const usageIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden {...stroke}>
    <path d="M2.2 11.5a6.5 6.5 0 1 1 11.6 0" />
    <path d="M8 8.5 11 5.8" />
  </svg>
);
// Lucide "settings".
export const settingsIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

function NavButton({ label, icon, active = false, count = null, loading = false, onClick }: {
  label: string; icon: React.ReactNode; active?: boolean;
  /** Shown as a small badge; null or 0 shows none. */
  count?: number | null; loading?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" aria-label={label} title={label} aria-current={active ? 'page' : undefined} onClick={onClick}
      className={`relative flex h-8 w-8 items-center justify-center rounded-md transition ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'}`}>
      {icon}
      {loading ? (
        <span role="status" aria-label={`Loading ${label.toLowerCase()}`}
          className="braille-spinner absolute -right-0.5 -top-0.5 text-[10px] leading-none text-zinc-500" />
      ) : count ? (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-zinc-800 px-1 text-center font-mono text-[10px] leading-4 tabular-nums text-zinc-300">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </button>
  );
}

export function SidebarNav({ selected, onSelect, taskCount, reviewCount = 0, reviewLoading = false, account }: {
  selected: SidebarView;
  onSelect: (view: SidebarView) => void;
  taskCount: number;
  reviewCount?: number;
  reviewLoading?: boolean;
  /** The settings / account menu button, at the far right of the row. */
  account?: React.ReactNode;
}) {
  return (
    <nav aria-label="Pages" className="flex items-center gap-1 px-1">
      <NavButton label="Tasks" icon={tasksIcon} active={selected.kind === 'tasks'} count={taskCount}
        onClick={() => onSelect({ kind: 'tasks' })} />
      <NavButton label="Code reviews" icon={reviewsIcon} active={selected.kind === 'reviews'} count={reviewCount}
        loading={reviewLoading} onClick={() => onSelect({ kind: 'reviews' })} />
      {/* No count: it would be either a cost or a percentage, and both need
          the units the page itself carries. */}
      <NavButton label="Usage" icon={usageIcon} active={selected.kind === 'usage'}
        onClick={() => onSelect({ kind: 'usage' })} />
      <span className="flex-1" />
      {account}
    </nav>
  );
}
