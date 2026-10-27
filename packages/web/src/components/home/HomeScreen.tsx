import type { ReactNode } from 'react';
import type { Worktree } from '../../types';
import type { RecentWorktree } from '../../lib/home/recent';
import { shortRelativeTime } from '../../lib/relativeTime';
import { OpenSidebarButton } from '../SidebarToggle';

const LINK = 'rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200';

/** Home with nothing open: one question, the command box (the Dock's own bar,
 * moved up here), and the few worktrees you were just in. The full list is a
 * click away in ⌘K. */
export function HomeScreen({ bar, strip = null, recent, waiting, onOpenRecent, onAddRepo, onNewWorktree, onWaiting, onExpandSidebar }: {
  /** The command bar, rendered in its home (hero) form. */
  bar: ReactNode;
  /** Mission Control's agent strip, above the box. */
  strip?: ReactNode;
  recent: RecentWorktree[];
  /** Stations calling you. */
  waiting: number;
  onOpenRecent: (w: Worktree) => void;
  onAddRepo: () => void;
  onNewWorktree: () => void;
  /** Opens the Line, where the calls are. */
  onWaiting: () => void;
  onExpandSidebar?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="app-drag flex h-11 shrink-0 items-center gap-2 px-3">
        <OpenSidebarButton onClick={onExpandSidebar} />
        {waiting > 0 && (
          <button type="button" onClick={onWaiting}
            className="ml-auto rounded-md border border-amber-700/60 bg-amber-950/40 px-2 py-1 text-xs text-amber-300 hover:bg-amber-900/40">
            {`⚑ ${waiting} waiting`}
          </button>
        )}
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col px-4 pt-[14vh]">
        <h1 className="mb-5 text-center text-2xl font-medium text-zinc-200">What do you want to do?</h1>
        {strip}
        {bar}
        {recent.length > 0 && (
          <div className="mt-8">
            <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Recent</div>
            <ul aria-label="Recent">
              {recent.map((r) => (
                <li key={r.worktree.path}>
                  <button type="button" onClick={() => onOpenRecent(r.worktree)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-900">
                    <span className="truncate text-zinc-200">{r.name}</span>
                    {r.repo && <span className="truncate text-xs text-zinc-500">· {r.repo}</span>}
                    <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(r.openedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4 flex items-center gap-2 px-1">
          <span className="ml-auto" />
          <button type="button" onClick={onAddRepo} className={LINK}>Add repo</button>
          <button type="button" onClick={onNewWorktree} className={LINK}>New worktree</button>
        </div>
      </div>
    </div>
  );
}
