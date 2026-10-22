import type { AgentStateName } from './tone';

// The selected agent's shape (from a station) and the box keys that act on it;
// its line in the strip is AgentLine.
export type CardAgent = {
  agentId: string;
  name: string;
  mode: string;
  worktree: string;
  state: AgentStateName;
  word: string;
  /** "3m" in the current state, when known. */
  elapsed: string | null;
  /** The current activity, else the last result (or the open call that needs you). */
  detail: string | null;
  /** Open calls to the human: a needs-you agent can dismiss them. */
  calls: { id: string; title: string }[];
};
export type CardKey = 'send' | 'steer' | 'interrupt' | 'open';

/** The box input's keys while an agent is selected; null = the box's own. */
export function agentCardKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): CardKey | null {
  if (e.key === 'Enter' && !e.shiftKey) return e.metaKey ? 'steer' : e.ctrlKey ? null : 'send';
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c') return 'interrupt';
  if (e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'o') return 'open';
  return null;
}
