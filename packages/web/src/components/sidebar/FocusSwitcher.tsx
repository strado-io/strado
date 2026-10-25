// Shared bits for the sidebar's Focus list (FocusList): its icon and its
// order, by last use (⌘1–⌘9 follow the same order).
import type { Focus } from '../../api';

const icon = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
// Lucide: focus.
export const FocusIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...icon} width={size} height={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" />
  </svg>
);

export const byLastActive = (a: Focus, b: Focus) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0);
