import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import type { StationDto } from '../../api';
import { DevServerButton } from './DevServerButton';
import { StationLights } from './StationLights';

/** The Strado Dock: the one row at the bottom of every page.
 * `[⎇ worktree·branch] [ command box ] [station lights +N] [▶ dev]`.
 * `panel` (a station card, the Line view) sits above it, opened only by the user. */
export function Dock({ worktree, worktreePath, onBrowse, stations, onOpenStation, onOpenLine, dev, panel, onClosePanel, bare = false, children }: {
  worktree: { name: string; branch: string | null } | null;
  worktreePath: string | null;
  /** The chip: the worktree list, through the command box. */
  onBrowse: () => void;
  stations: StationDto[];
  onOpenStation: (agentId: string) => void;
  onOpenLine: () => void;
  /** ▶ dev for the worktree on screen; absent on the board. */
  dev?: Omit<ComponentProps<typeof DevServerButton>, 'remote'> & { remote?: boolean } | null;
  panel?: ReactNode;
  /** A click outside the Dock (and its panel) closes the panel. */
  onClosePanel?: () => void;
  /** Home: no strip (home has its own box and waiting count); only the panel's anchor, so the Line still opens. */
  bare?: boolean;
  /** The command box; absent while the home screen holds it (a spacer keeps the row's shape). */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClosePanel);
  closeRef.current = onClosePanel;
  const hasPanel = !!panel;
  useEffect(() => {
    if (!hasPanel) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current?.(); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [hasPanel]);
  if (bare) return <div ref={ref} data-testid="dock-panel-anchor" className="relative h-0 shrink-0">{panel}</div>;
  const label = worktree ? [worktree.name, worktree.branch !== worktree.name ? worktree.branch : null].filter(Boolean).join(' · ') : null;
  return (
    <div ref={ref} data-testid="dock" className="relative flex min-h-9 shrink-0 items-center gap-2 border-t border-zinc-900 bg-zinc-950 px-4 py-0.5">
      {panel}
      <button
        type="button"
        aria-label={label ? `Worktree: ${label} — switch` : 'No worktree open — switch'}
        title="Switch worktree"
        onClick={onBrowse}
        className="flex max-w-[30%] shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <span aria-hidden className="text-zinc-600">⎇</span>
        <span className="truncate">{label ?? 'no worktree'}</span>
        <span aria-hidden className="text-zinc-600">▾</span>
      </button>
      {children ?? <div className="min-w-0 flex-1" />}
      <StationLights stations={stations} worktreePath={worktreePath} onOpenStation={onOpenStation} onOpenLine={onOpenLine} />
      {dev && <DevServerButton {...dev} />}
    </div>
  );
}
