import type { AgentStateName } from '../mission/tone';

export type TabAgentState = AgentStateName;

// A tab (or another worktree's agent) wears its agent's state: quiet when idle,
// tinted when it wants a look. "Needs you" is unmistakably amber.
export const TAB_TONE: Partial<Record<TabAgentState, string>> = {
  working: 'border-sky-400/25 bg-sky-400/[0.07]',
  needs_you: 'border-amber-400/50 bg-amber-400/[0.12] text-amber-100',
  failed: 'border-red-400/40 bg-red-400/10 text-red-100',
};
// A slow breathing glow (index.css .pill-breathe-*) while it works or waits on you; still under reduced motion.
export const BREATHE: Partial<Record<TabAgentState, string>> = { working: 'pill-breathe-working', needs_you: 'pill-breathe-needs' };

const RANK: TabAgentState[] = ['needs_you', 'failed', 'working', 'limited', 'idle', 'offline'];
/** The state that most wants a look (a tab group shows its loudest member); null for none. */
export function urgentState(states: (TabAgentState | null | undefined)[]): TabAgentState | null {
  for (const r of RANK) if (states.includes(r)) return r;
  return null;
}

/** How many items fit: `rights` are each item's right edge on one row, `avail`
 * the row's width. When some don't fit, room is kept for "+N" (at least one
 * is shown). Unknown width (not laid out yet): all of them. */
export function fitCount(rights: number[], avail: number, plusW: number): number {
  if (avail <= 0 || rights.length === 0) return rights.length;
  if (rights[rights.length - 1]! <= avail) return rights.length;
  const n = rights.findIndex((r) => r > avail - plusW);
  return Math.max(1, n === -1 ? rights.length : n);
}
