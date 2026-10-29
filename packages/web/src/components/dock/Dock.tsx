import { useState, type ReactNode } from 'react';
import { FocusIcon } from '../sidebar/FocusSwitcher';
import { BranchIcon } from '../sidebar/rowBits';
import { FolderIcon } from '../hub/icons';

/** The Strado Dock: the one row at the bottom of every page.
 * `◎ Focus › 📁 repo › ⑂ worktree·branch  [ command box ]`. The location is a label
 * only: switching is the box's job (type a name, or pick from its list). */
export function Dock({ worktree, focus = null, bare = false, collapsed = false, children }: {
  /** `repo`: the project folder it belongs to, when known. */
  worktree: { repo?: string | null; name: string; branch: string | null } | null;
  /** The open Focus's name, shown first. */
  focus?: string | null;
  /** Home: no strip (home has its own box). */
  bare?: boolean;
  /** Settings hid the bar: it stays mounted (so ⌘K still works) and opens only
   *  while the command box has the keyboard. */
  collapsed?: boolean;
  /** The command box; absent while the home screen holds it (a spacer keeps the row's shape). */
  children?: ReactNode;
}) {
  // Hidden bar: while the box has the keyboard (⌘K) it shows as a dialog in
  // the middle of the window, over a dimmed backdrop. The same element either
  // way, so the box keeps its focus as the look changes.
  const [active, setActive] = useState(false);
  if (bare) return null;
  const here = worktree ? [worktree.name, worktree.branch !== worktree.name ? worktree.branch : null].filter(Boolean).join(' · ') : null;
  const label = here && worktree?.repo ? `${worktree.repo} / ${here}` : here;
  const dialog = collapsed && active;
  return (
    <>
    {dialog && (
      // A press outside gives the keyboard back (the box closes on blur).
      <div data-testid="dock-backdrop" aria-hidden onMouseDown={(e) => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); }}
        className="fixed inset-0 z-[69] bg-black/50 backdrop-blur-[2px]" />
    )}
    {/* The control panel's bottom row: the same lifted surface as the agent strip above it (no rule between them). */}
    <div data-testid="dock" data-collapsed={collapsed || undefined} data-dialog={dialog || undefined}
      onFocus={() => setActive(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(false); }}
      className={dialog
        // Just the box: no location line, no card around it.
        ? 'fixed left-1/2 top-[14vh] z-[70] flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 flex-col items-stretch rounded-lg bg-zinc-950 shadow-2xl'
        : `dock-panel relative flex shrink-0 items-center gap-3 px-4 ${collapsed
          ? 'h-0 overflow-hidden focus-within:h-auto focus-within:min-h-11 focus-within:overflow-visible focus-within:pb-2 focus-within:pt-1'
          : 'min-h-11 pb-2 pt-1'}`}>
      {/* Each part carries its kind's icon (the sidebar's own) and says what it is on hover. */}
      {!dialog && <span data-testid="dock-location" aria-label={label ? `Worktree: ${label}` : 'No worktree open'}
        className="flex max-w-[42%] shrink-0 items-center gap-1.5 pl-1 text-[12px] text-zinc-300">
        {focus && (
          <span data-testid="dock-focus" title={`Focus: ${focus}`} className="flex min-w-0 shrink items-center gap-1 text-zinc-500">
            <span className="shrink-0 text-sky-400/80"><FocusIcon size={12} /></span>
            <span className="max-w-[9rem] truncate">{focus}</span>
            <span aria-hidden className="ml-0.5 text-zinc-700">›</span>
          </span>
        )}
        {worktree?.repo && (
          <span data-testid="dock-repo" title={`Repository: ${worktree.repo}`} className="flex min-w-0 shrink items-center gap-1 text-zinc-400">
            <FolderIcon className="shrink-0 text-zinc-500" />
            <span className="max-w-[10rem] truncate">{worktree.repo}</span>
            <span aria-hidden className="ml-0.5 text-zinc-700">›</span>
          </span>
        )}
        <span data-testid="dock-worktree" title={here ? `Worktree: ${here}` : 'No worktree open'} className="flex min-w-0 items-center gap-1">
          <BranchIcon className="shrink-0 text-emerald-400/80" />
          <span className="truncate font-medium text-zinc-200">{here ?? 'no worktree'}</span>
        </span>
      </span>}
      {children ?? <div className="min-w-0 flex-1" />}
    </div>
    </>
  );
}
