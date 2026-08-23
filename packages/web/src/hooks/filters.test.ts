import { describe, expect, it } from 'vitest';
import { isRunning, matchesStatus, matchesQuery } from './filters';
import type { Worktree } from '../types';

function wt(over: Partial<Worktree> & { path: string }): Worktree {
  return {
    repoId: 'r', branch: 'b', head: 'h', prunable: false, tracked: true,
    meta: { repoId: 'r', ticketId: 'FD-1', title: 'T', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
    ...over,
  } as Worktree;
}

describe('filters', () => {
  it('isRunning true for running/starting/external', () => {
    expect(isRunning(wt({ path: '/a', process: { status: 'running' } as any }))).toBe(true);
    expect(isRunning(wt({ path: '/b', process: { status: 'idle' } as any }))).toBe(false);
  });
  it('matchesStatus all/running/idle/untracked', () => {
    const r = wt({ path: '/a', process: { status: 'running' } as any });
    expect(matchesStatus(r, 'all')).toBe(true);
    expect(matchesStatus(r, 'running')).toBe(true);
    expect(matchesStatus(r, 'idle')).toBe(false);
    expect(matchesStatus(wt({ path: '/u', tracked: false }), 'untracked')).toBe(true);
    expect(matchesStatus(wt({ path: '/s', hasClaudeSession: true }), 'sessions')).toBe(true);
    expect(matchesStatus(wt({ path: '/no-session' }), 'sessions')).toBe(false);
  });
  it('matchesQuery checks ticket/title/branch/path', () => {
    const w = wt({ path: '/repo/FD-9', branch: 'feat/x' });
    expect(matchesQuery(w, 'fd-1')).toBe(true);  // ticketId FD-1
    expect(matchesQuery(w, 'feat')).toBe(true);
    expect(matchesQuery(w, 'zzz')).toBe(false);
    expect(matchesQuery(w, '')).toBe(true);
  });
});
