import type { ReactNode } from 'react';

/** The Strado Dock: the one row at the bottom of every page.
 * `[⎇ repo / worktree·branch] [ command box ]`. */
export function Dock({ worktree, onBrowse, bare = false, children }: {
  /** `repo`: the project folder it belongs to, when known. */
  worktree: { repo?: string | null; name: string; branch: string | null } | null;
  /** The chip: the worktree list, through the command box. */
  onBrowse: () => void;
  /** Home: no strip (home has its own box). */
  bare?: boolean;
  /** The command box; absent while the home screen holds it (a spacer keeps the row's shape). */
  children?: ReactNode;
}) {
  if (bare) return null;
  const here = worktree ? [worktree.name, worktree.branch !== worktree.name ? worktree.branch : null].filter(Boolean).join(' · ') : null;
  const label = here && worktree?.repo ? `${worktree.repo} / ${here}` : here;
  return (
    <div data-testid="dock" className="relative flex min-h-9 shrink-0 items-center gap-2 border-t border-zinc-900 bg-zinc-950 px-4 py-0.5">
      <button
        type="button"
        aria-label={label ? `Worktree: ${label} — switch` : 'No worktree open — switch'}
        title="Switch worktree"
        onClick={onBrowse}
        className="flex max-w-[30%] shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <span aria-hidden className="text-zinc-600">⎇</span>
        <span className="truncate">
          {worktree?.repo && <span className="text-zinc-500">{worktree.repo} / </span>}
          {here ?? 'no worktree'}
        </span>
        <span aria-hidden className="text-zinc-600">▾</span>
      </button>
      {children ?? <div className="min-w-0 flex-1" />}
    </div>
  );
}
