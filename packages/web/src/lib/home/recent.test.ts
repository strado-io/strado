import { describe, expect, it } from 'vitest';
import type { RepoConfig, Worktree } from '../../types';
import { recentWorktrees } from './recent';

const wt = (path: string, over: Partial<Worktree> = {}) => ({ path, repoId: 'r1', branch: path.split('/').pop(), meta: {}, ...over }) as unknown as Worktree;
const repos = [{ id: 'r1', name: 'Strado' }, { id: 'r2', name: 'Fleetx' }] as RepoConfig[];

describe('recentWorktrees', () => {
  it('the most recently opened first, at most five, only ones you have opened', () => {
    const ws = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => wt(`/wt/${n}`));
    const lru = { '/wt/a': 1, '/wt/b': 7, '/wt/c': 3, '/wt/d': 4, '/wt/e': 5, '/wt/f': 6 };
    expect(recentWorktrees(ws, repos, lru).map((r) => r.worktree.path)).toEqual(['/wt/b', '/wt/f', '/wt/e', '/wt/d', '/wt/c']);
  });

  it('name · repo · when: the ticket, else the branch; the repo name', () => {
    const [r] = recentWorktrees([wt('/wt/x', { repoId: 'r2', branch: 'fd-9', meta: { ticketId: 'FD-9' } } as Partial<Worktree>)], repos, { '/wt/x': 42 });
    expect(r).toMatchObject({ name: 'FD-9', repo: 'Fleetx', openedAt: 42 });
  });

  it('a path that is no longer a worktree here is skipped', () => {
    expect(recentWorktrees([wt('/wt/a')], repos, { '/wt/gone': 9, '/wt/a': 1 }).map((r) => r.worktree.path)).toEqual(['/wt/a']);
  });
});
