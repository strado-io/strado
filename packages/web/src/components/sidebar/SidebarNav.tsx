// The sidebar's page switcher: one row of icons at the bottom (Worktrees,
// Code reviews, Usage, Settings), so the rail above is the Focus. No counts:
// the row is for going somewhere, not for reading numbers. Account things —
// profile, organization, feedback, sign out — live in Settings.
import type { SidebarView } from '../Sidebar';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const reviewsIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="currentColor">
    <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z" />
  </svg>
);
// A gauge: the quota dial the Usage page is mostly about.
const usageIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden {...stroke}>
    <path d="M2.2 11.5a6.5 6.5 0 1 1 11.6 0" />
    <path d="M8 8.5 11 5.8" />
  </svg>
);
// Lucide "settings".
const settingsIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

function NavButton({ label, icon, active = false, onClick }: {
  label: string; icon: React.ReactNode; active?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" aria-label={label} title={label} aria-current={active ? 'page' : undefined} onClick={onClick}
      // The right side's look: quiet 28px buttons; the current page is a tab pill.
      className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
        active ? 'tab-pill text-zinc-100' : 'border-transparent text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'}`}>
      {icon}
    </button>
  );
}

export function SidebarNav({ selected, onSelect, onOpenSettings }: {
  /** The page shown; null on home (no page is current there). */
  selected: SidebarView | null;
  onSelect: (view: SidebarView) => void;
  onOpenSettings: () => void;
}) {
  return (
    // A glass bar like a pane card: 40px, the 28px buttons inside, settings at the right.
    <nav aria-label="Pages" data-testid="sidebar-nav" className="glass pane-card flex h-10 items-center gap-1 px-1.5">
      <NavButton label="Code reviews" icon={reviewsIcon} active={selected?.kind === 'reviews'}
        onClick={() => onSelect({ kind: 'reviews' })} />
      <NavButton label="Usage" icon={usageIcon} active={selected?.kind === 'usage'}
        onClick={() => onSelect({ kind: 'usage' })} />
      <span className="flex-1" />
      <NavButton label="Open settings" icon={settingsIcon} onClick={onOpenSettings} />
    </nav>
  );
}
