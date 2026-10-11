import type { MergeRequest, Worktree } from '../types';
import { chipStatus, sessionChips } from './sessions';
import { isRunning } from './filters';

/**
 * What a row wants from the person looking at it. Derived, never
 * stored; the first matching rule wins. A waiting agent blocks everything
 * else; a red PR is the next thing only a human can unblock; a working agent
 * needs nothing; a running server is context, not a task.
 */
export type Attention = 'needs-you' | 'review' | 'working' | 'running' | 'idle';

export const ATTENTION_ORDER: readonly Attention[] = ['needs-you', 'review', 'working', 'running', 'idle'];

export const ATTENTION_LABEL: Record<Attention, string> = {
  'needs-you': 'Needs you',
  review: 'Review',
  working: 'Working',
  running: 'Running',
  idle: 'Idle',
};

export function attentionOf(w: Worktree, mr: MergeRequest | null | undefined): Attention {
  const statuses = sessionChips([w]).map(chipStatus);
  if (statuses.includes('waiting')) return 'needs-you';
  // The MR summary carries CI state but no review verdict; a failed pipeline
  // is the one signal here that only the author can clear.
  if (mr && mr.state === 'open' && mr.pipeline === 'failed') return 'review';
  if (statuses.includes('working')) return 'working';
  if (isRunning(w)) return 'running';
  return 'idle';
}

/** Where the worktree lives — the grouping key a team view will use later. */
export type Host = { kind: 'local' } | { kind: 'runner'; name: string };

export function hostOf(w: Worktree): Host {
  return w.remote ? { kind: 'runner', name: w.remote.runnerName } : { kind: 'local' };
}
