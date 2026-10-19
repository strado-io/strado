import type { RepoConfig, Worktree } from '../../types';

export type RecentWorktree = { worktree: Worktree; name: string; repo: string; openedAt: number };

/** The home screen's Recent: worktrees you have opened here, newest first
 * (the same LRU the sidebar and the Worktrees page date their rows by). */
export function recentWorktrees(worktrees: Worktree[], repos: RepoConfig[], lru: Record<string, number>, limit = 5): RecentWorktree[] {
  const byPath = new Map(worktrees.map((w) => [w.path, w]));
  return Object.entries(lru)
    .filter(([path]) => byPath.has(path))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, openedAt]) => {
      const w = byPath.get(path)!;
      return {
        worktree: w,
        name: w.meta?.ticketId || w.branch || path.split('/').pop() || path,
        repo: repos.find((r) => r.id === w.repoId)?.name ?? '',
        openedAt,
      };
    });
}
