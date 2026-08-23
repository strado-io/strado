import { describe, expect, it } from 'vitest';
import { remoteAsWorktree } from './Dashboard';
import type { RemoteWorktree } from '../api';

function rw(over: Partial<RemoteWorktree> = {}): RemoteWorktree {
  return {
    runnerId: 'run1', runnerName: 'runner-dev', wsBase: 'wss://x', remoteWsId: 'ws1',
    path: '/w/FD-1', name: 'FD-1', branch: 'b', head: 'h',
    remoteRepoId: 'rr', isRepoRoot: false, cloneUrl: null, localRepoId: 'r',
    ...over,
  };
}

describe('remoteAsWorktree', () => {
  it('copies session state onto the worktree so the rail can read it', () => {
    const w = remoteAsWorktree(rw({ hasClaudeSession: true, claudeStatus: 'working', shellSessions: ['1'] }));
    expect(w.hasClaudeSession).toBe(true);
    expect(w.claudeStatus).toBe('working');
    expect(w.shellSessions).toEqual(['1']);
    expect(w.remote?.runnerName).toBe('runner-dev');
  });
});
