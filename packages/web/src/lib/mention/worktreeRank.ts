// The `#` picker's order: worktrees you used most recently first, filtered by
// name, branch, ticket or repo (a prefix match before a substring match).

export type WorktreeOption = {
  path: string;
  name: string;
  branch: string | null;
  ticket: string | null;
  repo: string;
  /** ms epoch from the worktree LRU; 0 when never opened here. */
  lastUsedAt: number;
};
export type RankedWorktree = { option: WorktreeOption; label: string };

/** 0 = prefix match, 1 = substring match, null = no match. */
function matchRank(w: WorktreeOption, q: string): 0 | 1 | null {
  if (!q) return 0;
  const fields = [w.name, w.branch ?? '', w.ticket ?? '', w.repo].map((f) => f.toLowerCase()).filter(Boolean);
  if (fields.some((f) => f.startsWith(q))) return 0;
  if (fields.some((f) => f.includes(q))) return 1;
  return null;
}

export function rankWorktrees(options: WorktreeOption[], query: string, limit = 6): RankedWorktree[] {
  const q = query.toLowerCase();
  // A name two worktrees share is labelled repo/name, so the chip says which.
  const count = new Map<string, number>();
  for (const o of options) count.set(o.name, (count.get(o.name) ?? 0) + 1);
  return options
    .map((option, i) => ({ option, i, m: matchRank(option, q) }))
    .filter((x): x is { option: WorktreeOption; i: number; m: 0 | 1 } => x.m !== null)
    .sort((a, b) => a.m - b.m || b.option.lastUsedAt - a.option.lastUsedAt || a.i - b.i)
    .slice(0, limit)
    .map(({ option }) => ({ option, label: (count.get(option.name) ?? 0) > 1 ? `${option.repo}/${option.name}` : option.name }));
}
