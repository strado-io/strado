import { describe, expect, it } from 'vitest';
import { rankWorktrees, type WorktreeOption } from './worktreeRank';

const w = (path: string, over: Partial<WorktreeOption> = {}): WorktreeOption => ({
  path, name: path.split('/').pop()!, branch: null, ticket: null, repo: 'App', lastUsedAt: 0, ...over,
});

describe('rankWorktrees (the # picker)', () => {
  it('empty query: most recently used first, at most six', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => w(`/wt/${n}`, { lastUsedAt: i }));
    expect(rankWorktrees(rows, '').map((r) => r.option.path)).toEqual(['/wt/g', '/wt/f', '/wt/e', '/wt/d', '/wt/c', '/wt/b']);
  });

  it('filters by name, branch, ticket or repo; a prefix match beats a substring match, then recency', () => {
    const rows = [
      w('/wt/master', { repo: 'Fleetx Dashboard', lastUsedAt: 9 }),
      w('/wt/fd-29', { ticket: 'FD-29', branch: 'fd-29-hotfix', repo: 'Fleetx Napp', lastUsedAt: 5 }),
      w('/wt/ops', { branch: 'hotfix-2', repo: 'Ops', lastUsedAt: 7 }),
    ];
    expect(rankWorktrees(rows, 'hot').map((r) => r.option.path)).toEqual(['/wt/ops', '/wt/fd-29']);
    expect(rankWorktrees(rows, 'fleetx').map((r) => r.option.path)).toEqual(['/wt/master', '/wt/fd-29']);
    expect(rankWorktrees(rows, 'FD-2').map((r) => r.option.path)).toEqual(['/wt/fd-29']);
  });

  it('the chip label is the name, or repo/name when two worktrees share it', () => {
    const rows = [w('/a/main', { repo: 'Strado' }), w('/b/main', { repo: 'Website' }), w('/c/ops')];
    expect(rankWorktrees(rows, '').map((r) => r.label)).toEqual(['Strado/main', 'Website/main', 'ops']);
  });
});
