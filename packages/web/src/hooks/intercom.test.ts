import { describe, expect, it } from 'vitest';
import {
  collectionOf,
  computeIntercomNotifications,
  escalationForTab,
  escalationsByWorktree,
  intercomReducer,
  isRetargetedAsk,
  nextSeenIds,
  openEscalations,
  peerForTab,
  type IntercomAction,
  type IntercomState,
} from './intercom';

const peers = [
  { agentId: 'claude-1@repo', alias: null, mode: 'claude' as const, worktreePath: '/w/repo', sessionId: '1', lifecycle: 'idle', live: true },
  { agentId: 'shell-1@repo', alias: 'bob', mode: 'shell' as const, worktreePath: '/w/repo', sessionId: '1', lifecycle: 'idle', live: true },
];
const esc = (over: Partial<IntercomState['escalations'][number]> = {}) => ({
  id: 'E1', scopeId: 'default', from: { agentId: 'claude-1@repo', executionId: 'x' }, to: 'human', title: 'db?', body: 'pg or sqlite', context: [],
  taskId: null, status: 'open' as const, resolution: null, resolvedBy: null, createdAt: 1, resolvedAt: null, expiresAt: null, ...over,
});
const base: IntercomState = { escalations: [], tasks: [], peers, loaded: true, error: null };

describe('intercom reducer and selectors', () => {
  it('loaded replaces every collection; single-collection actions replace only theirs', () => {
    const s = intercomReducer({ ...base, loaded: false }, { type: 'loaded', escalations: [esc()], tasks: [], peers });
    expect(s.loaded).toBe(true);
    expect(s.escalations).toHaveLength(1);
    const s2 = intercomReducer(s, { type: 'escalations', escalations: [] });
    expect(s2.escalations).toEqual([]);
    expect(s2.peers).toBe(peers);
  });
  it('collectionOf maps event prefixes', () => {
    expect(collectionOf({ type: 'task.claimed', data: { scopeId: 'd', id: 'T' } })).toBe('tasks');
    expect(collectionOf({ type: 'escalation.opened', data: { scopeId: 'd', id: 'E' } })).toBe('escalations');
  });
  it('openEscalations keeps only open human ones, newest first; peer asks are excluded', () => {
    const s = { ...base, escalations: [esc({ id: 'a', createdAt: 1 }), esc({ id: 'b', createdAt: 2 }), esc({ id: 'c', status: 'resolved' }), esc({ id: 'd', to: 'shell-1@repo' })] };
    expect(openEscalations(s).map((e) => e.id)).toEqual(['b', 'a']);
  });
  it('escalationsByWorktree counts through the peer list; unknown agents are dropped', () => {
    const s = { ...base, escalations: [esc({ id: 'a' }), esc({ id: 'b', from: { agentId: 'ghost', executionId: 'x' } })] };
    expect(escalationsByWorktree(s)).toEqual({ '/w/repo': 1 });
  });
  it('escalationForTab matches worktree, mode and session id', () => {
    const s = { ...base, escalations: [esc()] };
    expect(escalationForTab(s, { path: '/w/repo', mode: 'claude', id: '1' })?.id).toBe('E1');
    expect(escalationForTab(s, { path: '/w/repo', mode: 'shell', id: '1' })).toBeUndefined();
    expect(escalationForTab(s, { path: '/w/other', mode: 'claude', id: '1' })).toBeUndefined();
  });
  it('computeIntercomNotifications fires once per newly open human escalation with the exact title', () => {
    const s = { ...base, escalations: [esc({ id: 'new' }), esc({ id: 'old' })] };
    const out = computeIntercomNotifications(new Set(['old']), s, () => 'repo');
    expect(out).toEqual([{ id: 'new', path: '/w/repo', mode: 'claude', sessionId: '1', title: 'repo: claude-1@repo needs a decision — db?', body: 'pg or sqlite' }]);
    expect(computeIntercomNotifications(new Set(['new', 'old']), s, () => 'repo')).toEqual([]);
  });
  it('nextSeenIds fires nothing on the first (null) snapshot but still seeds silently', () => {
    const s = { ...base, escalations: [esc()] };
    const { seen, fire } = nextSeenIds(null, s, () => 'repo');
    expect(fire).toEqual([]);
    expect(seen).toEqual(new Set(['E1']));
  });
  it('nextSeenIds fires once for a newly open escalation, then stops once seeded', () => {
    const s = { ...base, escalations: [esc({ id: 'new' }), esc({ id: 'old' })] };
    const round1 = nextSeenIds(new Set(['old']), s, () => 'repo');
    expect(round1.fire).toEqual([{ id: 'new', path: '/w/repo', mode: 'claude', sessionId: '1', title: 'repo: claude-1@repo needs a decision — db?', body: 'pg or sqlite' }]);
    const round2 = nextSeenIds(round1.seen, s, () => 'repo');
    expect(round2.fire).toEqual([]);
  });
  it('nextSeenIds excludes an escalation with no resolved peer from seen, and fires once the peer appears', () => {
    const noPeerYet: IntercomState = { ...base, peers: [], escalations: [esc({ id: 'a' })] };
    const r1 = nextSeenIds(null, noPeerYet, () => 'repo');
    expect(r1.seen).toEqual(new Set());
    expect(r1.fire).toEqual([]);
    const r2 = nextSeenIds(r1.seen, noPeerYet, () => 'repo'); // still no peer next round
    expect(r2.seen).toEqual(new Set());
    expect(r2.fire).toEqual([]);
    const peerArrived: IntercomState = { ...base, peers, escalations: [esc({ id: 'a' })] };
    const r3 = nextSeenIds(r2.seen, peerArrived, () => 'repo');
    expect(r3.seen).toEqual(new Set(['a']));
    expect(r3.fire).toEqual([{ id: 'a', path: '/w/repo', mode: 'claude', sessionId: '1', title: 'repo: claude-1@repo needs a decision — db?', body: 'pg or sqlite' }]);
  });
  it('a successful single-collection fetch clears a stale error', () => {
    const actions: IntercomAction[] = [
      { type: 'escalations', escalations: [] },
      { type: 'tasks', tasks: [] },
      { type: 'peers', peers: [] },
    ];
    for (const action of actions) {
      expect(intercomReducer({ ...base, error: 'boom' }, action).error).toBeNull();
    }
  });
  it('isRetargetedAsk: a human-bound escalation that began as a peer ask', () => {
    expect(isRetargetedAsk(esc({ askMessageId: 'M1' }))).toBe(true);
    expect(isRetargetedAsk(esc())).toBe(false);
    expect(isRetargetedAsk(esc({ askMessageId: null }))).toBe(false);
    expect(isRetargetedAsk(esc({ to: 'shell-1@repo', askMessageId: 'M1' }))).toBe(false);
  });
  it('nextSeenIds fires for a retargeted ask whose asker has exited, with no tab to open', () => {
    const s: IntercomState = { ...base, peers: [], escalations: [esc({ id: 'r', askMessageId: 'M1' })] };
    const r1 = nextSeenIds(new Set(), s, () => 'repo');
    expect(r1.seen).toEqual(new Set(['r']));
    expect(r1.fire).toEqual([{ id: 'r', path: null, mode: null, sessionId: null, title: 'claude-1@repo timed out waiting on a peer — db?', body: 'pg or sqlite' }]);
    expect(nextSeenIds(r1.seen, s, () => 'repo').fire).toEqual([]);
  });
  it('a retargeted ask whose asker is still live notifies through its tab like any escalation', () => {
    const s = { ...base, escalations: [esc({ id: 'r', askMessageId: 'M1' })] };
    expect(nextSeenIds(new Set(), s, () => 'repo').fire).toEqual([{ id: 'r', path: '/w/repo', mode: 'claude', sessionId: '1', title: 'repo: claude-1@repo needs a decision — db?', body: 'pg or sqlite' }]);
  });
});

describe('routing and tabs', () => {
  it('collectionOf routes task.* to tasks, peer.* to peers, the rest to escalations', () => {
    expect(collectionOf({ type: 'task.done', data: { scopeId: 'default', id: 'T' } })).toBe('tasks');
    expect(collectionOf({ type: 'peer.registered', data: { scopeId: 'default', id: 'x' } })).toBe('peers');
    expect(collectionOf({ type: 'escalation.opened', data: { scopeId: 'default', id: 'E' } })).toBe('escalations');
  });
  it('peerForTab matches path + mode + session id', () => {
    expect(peerForTab(base, { path: '/w/repo', mode: 'shell', id: '1' })?.alias).toBe('bob');
    expect(peerForTab(base, { path: '/w/repo', mode: 'shell', id: '2' })).toBeUndefined();
  });
});
