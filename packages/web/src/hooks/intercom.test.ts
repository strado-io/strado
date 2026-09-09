import { describe, expect, it } from 'vitest';
import type { ForkDto } from '../api';
import { INTERCOM_EVENT_TYPES } from '../eventStream';
import {
  activeForks,
  collectionOf,
  computeIntercomNotifications,
  escalationForTab,
  escalationsByWorktree,
  forkLabel,
  forkTargetLabel,
  intercomReducer,
  nextSeenIds,
  openEscalations,
  peerForTab,
  settledForks,
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
const base: IntercomState = { escalations: [], tasks: [], forks: [], peers, loaded: true, error: null };

describe('intercom reducer and selectors', () => {
  it('loaded replaces every collection; single-collection actions replace only theirs', () => {
    const s = intercomReducer({ ...base, loaded: false }, { type: 'loaded', escalations: [esc()], tasks: [], forks: [], peers });
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
});

const fork = (over: Partial<ForkDto> = {}): ForkDto => ({
  id: 'F1', scopeId: 'default', from: { agentId: 'human', executionId: 'human' },
  source: { agentId: 'claude-1@repo', worktreePath: '/w/repo', mode: 'claude', sessionId: '1' },
  target: { kind: 'peer', agentId: 'shell-1@repo' }, notes: 'migrate DB\nmore', taskId: null,
  summarySource: null, summary: null, status: 'queued', summaryMessageId: null, messageId: null, packageBytes: null,
  error: null, createdAt: 10, summaryDeadline: null, deliveredAt: null, acceptedAt: null, ...over,
});
describe('forks', () => {
  it('reducer: forks action replaces only forks; loaded carries forks', () => {
    const s1 = intercomReducer(base, { type: 'forks', forks: [fork()] });
    expect(s1.forks).toHaveLength(1); expect(s1.tasks).toEqual(base.tasks);
    const s2 = intercomReducer(base, { type: 'loaded', escalations: [], tasks: [], forks: [fork(), fork({ id: 'F2' })], peers });
    expect(s2.forks.map((f) => f.id)).toEqual(['F1', 'F2']); expect(s2.loaded).toBe(true);
  });
  it('collectionOf routes fork.* to forks', () => {
    expect(collectionOf({ type: 'fork.queued', data: { scopeId: 'default', id: 'F1' } })).toBe('forks');
    expect(collectionOf({ type: 'task.done', data: { scopeId: 'default', id: 'T' } })).toBe('tasks');
    expect(collectionOf({ type: 'peer.registered', data: { scopeId: 'default', id: 'x' } })).toBe('peers');
  });
  it('INTERCOM_EVENT_TYPES lists the seven fork events', () => {
    expect(INTERCOM_EVENT_TYPES.filter((t) => t.startsWith('fork.'))).toEqual(['fork.created', 'fork.summarising', 'fork.queued', 'fork.delivered', 'fork.accepted', 'fork.failed', 'fork.cancelled']);
  });
  it('activeForks / settledForks split by status, newest first', () => {
    const s = { ...base, forks: [fork({ id: 'A', status: 'accepted', createdAt: 1 }), fork({ id: 'Q', createdAt: 2 }), fork({ id: 'S', status: 'summarising', createdAt: 3 }), fork({ id: 'X', status: 'failed', createdAt: 4 })] };
    expect(activeForks(s).map((f) => f.id)).toEqual(['S', 'Q']);
    expect(settledForks(s).map((f) => f.id)).toEqual(['X', 'A']);
  });
  it('forkLabel: first line of the notes, hard-cut at 120 chars with no ellipsis; worktree basename only when that first line is blank', () => {
    expect(forkLabel(fork())).toBe('migrate DB');
    expect(forkLabel(fork({ notes: '\n  \n' }))).toBe('repo');
    // A blank first line falls back even though a later line has content.
    expect(forkLabel(fork({ notes: '\nmigrate DB' }))).toBe('repo');
    const long = forkLabel(fork({ notes: 'x'.repeat(200) }));
    expect(long).toBe('x'.repeat(120));
    expect(long).not.toContain('…');
  });
  it('forkTargetLabel: alias for a known peer, agent id otherwise, "new <mode> tab" until spawned', () => {
    expect(forkTargetLabel(base, { kind: 'peer', agentId: 'shell-1@repo' })).toBe('bob');
    expect(forkTargetLabel(base, { kind: 'peer', agentId: 'ghost@repo' })).toBe('ghost@repo');
    expect(forkTargetLabel(base, { kind: 'new', mode: 'codex', worktreePath: '/w/repo', agentId: null })).toBe('new codex tab');
    expect(forkTargetLabel(base, { kind: 'new', mode: 'codex', worktreePath: '/w/repo', agentId: 'codex-2@repo' })).toBe('new codex tab · codex-2@repo');
  });
  it('peerForTab matches path + mode + session id', () => {
    expect(peerForTab(base, { path: '/w/repo', mode: 'shell', id: '1' })?.alias).toBe('bob');
    expect(peerForTab(base, { path: '/w/repo', mode: 'shell', id: '2' })).toBeUndefined();
  });
});
