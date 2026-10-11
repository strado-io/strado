import { beforeEach, describe, expect, it } from 'vitest';
import { clearLooseWorktrees, readLooseWorktrees } from './looseWorktrees';

beforeEach(() => localStorage.clear());

describe('loose worktrees (pre-Focus list, read for migration)', () => {
  it('reads one workspace\'s ids and clears only that workspace', () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: ['local:/a', 'local:/b'], w2: ['local:/z'] }));
    expect(readLooseWorktrees('w1')).toEqual(['local:/a', 'local:/b']);
    clearLooseWorktrees('w1');
    expect(readLooseWorktrees('w1')).toEqual([]);
    expect(readLooseWorktrees('w2')).toEqual(['local:/z']);
  });

  it('ignores garbage in storage', () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', '[1,2');
    expect(readLooseWorktrees('w1')).toEqual([]);
    localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: 'nope', w2: [1, 'local:/ok'] }));
    expect(readLooseWorktrees('w1')).toEqual([]);
    expect(readLooseWorktrees('w2')).toEqual(['local:/ok']);
  });
});
