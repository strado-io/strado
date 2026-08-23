import { beforeEach, describe, expect, it } from 'vitest';
import {
  readWorktreeLru,
  bumpWorktreeOpened,
  compareByActivityThenRecency,
  type RankableWorktree,
} from './worktreeLru';

beforeEach(() => localStorage.clear());

describe('worktree LRU store', () => {
  it('returns {} when absent or malformed', () => {
    expect(readWorktreeLru()).toEqual({});
    localStorage.setItem('strado:worktree-lru', 'not json');
    expect(readWorktreeLru()).toEqual({});
    localStorage.setItem('strado:worktree-lru', '[1,2]'); // an array is not a map
    expect(readWorktreeLru()).toEqual({});
  });

  it('bump/read round-trips and overwrites', () => {
    bumpWorktreeOpened('/a', 100);
    bumpWorktreeOpened('/b', 200);
    expect(readWorktreeLru()).toEqual({ '/a': 100, '/b': 200 });
    bumpWorktreeOpened('/a', 300);
    expect(readWorktreeLru()['/a']).toBe(300);
  });
});

describe('compareByActivityThenRecency', () => {
  const sorted = (items: RankableWorktree[], lru: Record<string, number>) =>
    [...items].sort((a, b) => compareByActivityThenRecency(a, b, lru)).map((i) => i.path);

  it('active beats inactive regardless of recency', () => {
    const items: RankableWorktree[] = [
      { path: '/idle-recent', active: false, index: 0 },
      { path: '/active-old', active: true, index: 1 },
    ];
    expect(sorted(items, { '/idle-recent': 999, '/active-old': 1 })).toEqual([
      '/active-old',
      '/idle-recent',
    ]);
  });

  it('among the same activity level, most-recently-opened comes first', () => {
    const items: RankableWorktree[] = [
      { path: '/old', active: true, index: 0 },
      { path: '/new', active: true, index: 1 },
    ];
    expect(sorted(items, { '/old': 100, '/new': 500 })).toEqual(['/new', '/old']);
  });

  it('equal recency falls back to original index (stable)', () => {
    const items: RankableWorktree[] = [
      { path: '/second', active: false, index: 1 },
      { path: '/first', active: false, index: 0 },
    ];
    expect(sorted(items, {})).toEqual(['/first', '/second']);
  });
});
