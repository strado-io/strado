import { describe, expect, it } from 'vitest';
import { ATTENTION_ORDER, attentionOf, hostOf } from './attention';
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

describe('ATTENTION_ORDER', () => {
  it('is the canonical state order', () => {
    expect(ATTENTION_ORDER).toEqual(['needs-you', 'review', 'working', 'running', 'idle']);
  });
});
