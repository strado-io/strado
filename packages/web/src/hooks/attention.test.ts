import { describe, expect, it } from 'vitest';
import { ATTENTION_ORDER, attentionOf, groupRows, hostOf, sortRows } from './attention';
import type { MergeRequest, Worktree } from '../types';

const wt = (path: string, over: Partial<Worktree> = {}): Worktree => ({
  path, repoId: 'r1', branch: 'b', head: 'h', prunable: false, tracked: true,
  meta: { repoId: 'r1', ticketId: path.slice(1), title: 'T', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  ...over,
} as Worktree);

const openMr = (pipeline: MergeRequest['pipeline']): MergeRequest => ({
  number: 1, title: 'x', state: 'open', webUrl: 'u', pipeline, approvals: null, sourceBranch: 'b', updatedAt: '',
});

describe('attentionOf', () => {
  it('a waiting agent beats everything', () => {
    const w = wt('/a', {
      claudeSessions: ['1'], claudeStatusById: { '1': 'waiting' },
      codexSessions: ['1'], codexStatusById: { '1': 'working' },
      process: { status: 'running', pid: 1, startedAt: null, port: 3000, detectedUrl: null, exitCode: null },
    });
    expect(attentionOf(w, openMr('failed'))).toBe('needs-you');
  });

  it('a red open PR beats a working agent', () => {
    const w = wt('/a', { claudeSessions: ['1'], claudeStatusById: { '1': 'working' } });
    expect(attentionOf(w, openMr('failed'))).toBe('review');
  });

  it('a green or merged PR is not review', () => {
    expect(attentionOf(wt('/a'), openMr('success'))).toBe('idle');
    expect(attentionOf(wt('/a'), { ...openMr('failed'), state: 'merged' })).toBe('idle');
  });

  it('working, then running, then idle', () => {
    expect(attentionOf(wt('/a', { piSessions: ['2'], piStatusById: { '2': 'working' } }), null)).toBe('working');
    expect(attentionOf(wt('/a', { process: { status: 'starting', pid: null, startedAt: null, port: 3000, detectedUrl: null, exitCode: null } }), null)).toBe('running');
    expect(attentionOf(wt('/a', { process: { status: 'idle', pid: 4, startedAt: null, port: 8080, detectedUrl: null, exitCode: null, external: true } }), null)).toBe('running');
    expect(attentionOf(wt('/a', { shellSessions: ['1'] }), null)).toBe('idle');
  });

  it('a shell hosting a waiting agent counts as waiting', () => {
    // shellHostedAgent: a shell whose id matches an agent status entry
    const w = wt('/a', { shellSessions: ['3'], claudeStatusById: { 'shell:3': 'waiting' } });
    expect(attentionOf(w, null)).toBe('needs-you');
  });
});

describe('hostOf', () => {
  it('names the runner, else local', () => {
    expect(hostOf(wt('/a'))).toEqual({ kind: 'local' });
    expect(hostOf(wt('/a', { remote: { runnerId: 'r', runnerName: 'box-1', wsBase: '', wsId: 'w' } }))).toEqual({ kind: 'runner', name: 'box-1' });
  });
});

describe('groupRows', () => {
  const ctx = {
    attention: (w: Worktree): 'needs-you' | 'running' | 'idle' => (w.path === '/wait' ? 'needs-you' : w.path === '/run' ? 'running' : 'idle'),
    repoName: (w: Worktree) => (w.repoId === 'r1' ? 'Alpha' : 'Beta'),
  };

  it('by state: attention order, empty states dropped, Needs you always present', () => {
    const groups = groupRows([wt('/idle'), wt('/run'), wt('/wait')], 'state', ctx);
    expect(groups.map((g) => g.key)).toEqual(['needs-you', 'running', 'idle']);
    expect(groups[0]!.rows.map((r) => r.path)).toEqual(['/wait']);
    const quiet = groupRows([wt('/idle')], 'state', ctx);
    expect(quiet.map((g) => g.key)).toEqual(['needs-you', 'idle']);
    expect(quiet[0]!.rows).toEqual([]);
    expect(quiet[0]!.label).toBe('Needs you');
  });

  it('by repo: alphabetical by repo name', () => {
    const groups = groupRows([wt('/b', { repoId: 'r2' }), wt('/a')], 'repo', ctx);
    expect(groups.map((g) => g.label)).toEqual(['Alpha', 'Beta']);
    expect(groups[1]!.rows[0]!.path).toBe('/b');
  });

  it('none: one unlabeled group', () => {
    expect(groupRows([wt('/a'), wt('/b')], 'none', ctx)).toEqual([{ key: 'all', label: '', rows: [wt('/a'), wt('/b')] }]);
  });

  it('exports the canonical state order', () => {
    expect(ATTENTION_ORDER).toEqual(['needs-you', 'review', 'working', 'running', 'idle']);
  });
});

describe('sortRows', () => {
  it('activity: most recently opened first, then most worked, then given order', () => {
    const rows = [wt('/old'), wt('/never', { activitySeconds: 50 }), wt('/new'), wt('/busy', { activitySeconds: 900 })];
    const lru = { '/old': 100, '/new': 200 };
    expect(sortRows(rows, 'activity', { lru }).map((r) => r.path)).toEqual(['/new', '/old', '/busy', '/never']);
  });

  it('ticket: natural order on the ticket id', () => {
    const rows = [wt('/FD-10'), wt('/FD-9'), wt('/FD-100')];
    expect(sortRows(rows, 'ticket', { lru: {} }).map((r) => r.path)).toEqual(['/FD-9', '/FD-10', '/FD-100']);
  });

  it('manual: honours meta.order like the board always did', () => {
    const a = wt('/a'); a.meta!.order = 2;
    const b = wt('/b'); b.meta!.order = 1;
    expect(sortRows([a, b], 'manual', { lru: {} }).map((r) => r.path)).toEqual(['/b', '/a']);
  });
});
