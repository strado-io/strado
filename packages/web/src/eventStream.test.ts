import { describe, expect, it } from 'vitest';
import { worktreesReducer } from './eventStream';

describe('worktreesReducer', () => {
  it('applies worktree.updated by merging fields by path', () => {
    const state = [{ path: '/a', branch: 'x', process: { status: 'idle' } } as any];
    const next = worktreesReducer(state, {
      type: 'worktree.updated',
      data: { path: '/a', process: { status: 'running' } as any },
    });
    expect(next[0]!.process.status).toBe('running');
  });

  it('drops worktrees marked removed', () => {
    const state = [{ path: '/a' } as any, { path: '/b' } as any];
    const next = worktreesReducer(state, { type: 'worktree.updated', data: { path: '/a', removed: true } });
    expect(next.map((w) => w.path)).toEqual(['/b']);
  });

  it('ignores events with no matching path', () => {
    const state = [{ path: '/a' } as any];
    const next = worktreesReducer(state, { type: 'worktree.updated', data: { path: '/missing' } });
    expect(next).toBe(state);
  });
});
