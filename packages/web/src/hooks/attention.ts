import type { MergeRequest, Worktree } from '../types';
import { chipStatus, sessionChips } from './sessions';
import { isRunning } from './filters';
import { sortByOrder } from './rowOrder';

/**
 * What a row wants from the person looking at the board. Derived, never
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

export type GroupBy = 'state' | 'repo' | 'none';
export type SortBy = 'activity' | 'ticket' | 'manual';
export type Group = { key: string; label: string; rows: Worktree[] };

export function groupRows(
  rows: Worktree[],
  groupBy: GroupBy,
  ctx: { attention: (w: Worktree) => Attention; repoName: (w: Worktree) => string },
): Group[] {
  if (groupBy === 'none') return [{ key: 'all', label: '', rows }];
  if (groupBy === 'state') {
    const by = new Map<Attention, Worktree[]>(ATTENTION_ORDER.map((a) => [a, []]));
    for (const w of rows) by.get(ctx.attention(w))!.push(w);
    // Empty states vanish, except Needs you: the board must still answer
    // "is anything waiting on me?" when the answer is no.
    return ATTENTION_ORDER
      .filter((a) => a === 'needs-you' || by.get(a)!.length > 0)
      .map((a) => ({ key: a, label: ATTENTION_LABEL[a], rows: by.get(a)! }));
  }
  const by = new Map<string, Group>();
  for (const w of rows) {
    const key = `repo:${w.repoId ?? ''}`;
    const g = by.get(key) ?? { key, label: ctx.repoName(w), rows: [] };
    g.rows.push(w);
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortRows(rows: Worktree[], sort: SortBy, ctx: { lru: Record<string, number> }): Worktree[] {
  if (sort === 'manual') return sortByOrder(rows);
  const indexed = rows.map((w, i) => ({ w, i }));
  if (sort === 'ticket') {
    return indexed
      .sort((a, b) => natural.compare(a.w.meta?.ticketId ?? a.w.path, b.w.meta?.ticketId ?? b.w.path) || a.i - b.i)
      .map((x) => x.w);
  }
  // activity: opened most recently first (client LRU), then most time worked,
  // then the order we were given. activitySeconds alone is total effort, not
  // recency, so it only breaks ties.
  return indexed
    .sort((a, b) =>
      (ctx.lru[b.w.path] ?? 0) - (ctx.lru[a.w.path] ?? 0)
      || (b.w.activitySeconds ?? 0) - (a.w.activitySeconds ?? 0)
      || a.i - b.i)
    .map((x) => x.w);
}
