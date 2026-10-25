// Shared bits for the sidebar's Focus list (FocusList): its icon and its
// order, by last use (⌘1–⌘9 follow the same order).
import type { Focus } from '../../api';

const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
// A viewfinder: four corner brackets round a ring. Bolder than Lucide's
// `focus` so it still reads at 13px.
export const FocusIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...icon} strokeWidth={2.4} strokeLinecap="butt" width={size} height={size}>
    <circle cx="12" cy="12" r="4.25" />
    <path d="M3.5 8.5V5.5a2 2 0 0 1 2-2h3" /><path d="M15.5 3.5h3a2 2 0 0 1 2 2v3" />
    <path d="M20.5 15.5v3a2 2 0 0 1-2 2h-3" /><path d="M8.5 20.5h-3a2 2 0 0 1-2-2v-3" />
  </svg>
);

export const byLastActive = (a: Focus, b: Focus) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0);
