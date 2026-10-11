import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { addLooseWorktree, readLooseWorktrees, removeLooseWorktree, useLooseWorktrees } from './looseWorktrees';

beforeEach(() => localStorage.clear());

describe('loose worktrees', () => {
  it('reads yesterday’s pins as today’s loose rows', () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: ['local:/a'], w2: ['local:/b'] }));
    expect(readLooseWorktrees('w1')).toEqual(['local:/a']);
    expect(readLooseWorktrees('w9')).toEqual([]);
  });

  it('adds once, removes, and keeps every hook instance in sync', () => {
    const a = renderHook(() => useLooseWorktrees('w1'));
    const b = renderHook(() => useLooseWorktrees('w1'));
    act(() => addLooseWorktree('w1', 'local:/a'));
    act(() => addLooseWorktree('w1', 'local:/a'));
    expect(a.result.current.ids).toEqual(['local:/a']);
    expect(b.result.current.ids).toEqual(['local:/a']);
    act(() => a.result.current.add('local:/b'));
    expect(b.result.current.ids).toEqual(['local:/a', 'local:/b']);
    act(() => removeLooseWorktree('w1', 'local:/a'));
    expect(a.result.current.ids).toEqual(['local:/b']);
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: ['local:/b'] });
  });

  it('ignores garbage in storage', () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', '[1,2');
    expect(readLooseWorktrees('w1')).toEqual([]);
    localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: 'nope' }));
    expect(readLooseWorktrees('w1')).toEqual([]);
  });
});
