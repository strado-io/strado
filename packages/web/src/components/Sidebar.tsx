import { SidebarToggleButton, TITLE_BAR_HEIGHT, TrafficLightsSpacer, useInsetTitleBar } from './SidebarToggle';
import { useEffect, useRef, useState } from 'react';
import type { FocusTicket, RemoteWorktree, RunnerStatus } from '../api';
import type { MergeRequest, RepoConfig, Workspace, Worktree } from '../types';
import { useResizableWidth } from '../hooks/resizableWidth';
import { useSpaceNeighbors } from '../hooks/spaceNeighbors';
import { useSpaceShortcut } from '../hooks/spaceShortcut';
import { useWorkspace } from '../hooks/useWorkspace';
import { SidebarBody } from './sidebar/SidebarBody';
import type { OpenWorktree } from './sidebar/WorktreeRowItem';
import { SpaceCarousel, type CarouselPane, type SpaceCarouselHandle } from './sidebar/SpaceCarousel';
import { SpaceDots } from './sidebar/SpaceDots';
import { SidebarNav } from './sidebar/SidebarNav';
import { UpdateFooter, type UpdateFooterProps } from './UpdateFooter';
import type { FocusJarvisHeader } from './sidebar/FocusList';

export type AddRepoAnchor = { left: number; right: number; bottom: number };

/**
 * One view left. 'active' used to list running dev servers on their own page —
 * dead most of the time, since the signal it carried (a running server, an
 * agent at work) already lives directly on the worktree rows.
 */
export type SidebarView = { kind: 'worktrees' } | { kind: 'reviews' } | { kind: 'usage' };

export type Props = {
  repos: RepoConfig[];
  worktrees: Worktree[];
  selected: SidebarView | null;
  onSelect: (view: SidebarView) => void;
  onOpenSettings: () => void;
  /** The running-dev-servers chip, beside Usage in the bottom bar (hidden at zero). */
  running?: React.ReactNode;
  onCollapse: () => void;
  /** Sliding shut: it stays drawn, unclickable, until the slide ends. */
  collapsing?: boolean;
  /** Shown by a toggle: it slides in from the edge (not on the app's first draw). */
  slideIn?: boolean;
  onAddRepo: (anchor?: AddRepoAnchor) => void;
  onOpenWorktree: OpenWorktree;
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  /** Opens diff & commit for a worktree — the hover card's Changes action. */
  onOpenDiff?: (w: Worktree) => void;
  activeWorktreePath: string | null;
  /** New worktree with the repo still to pick (toolbar button); the empty Focus passes its ticket. */
  onNewWorktree: (ticket?: FocusTicket) => void;
  onWorktreeSettings: (w: Worktree) => void;
  /** Settings › Projects › the worktree's project (a repo id). */
  onProjectSettings?: (repoId: string) => void;
  onDeleteWorktree: (w: Worktree) => void;
  update: UpdateFooterProps;
  /** Worktrees living on runners, shown under the repo they belong to. */
  remoteWorktrees?: RemoteWorktree[];
  runnerStatuses?: RunnerStatus[];
  /** True until the first runner-worktree fetch for this space settles. */
  remoteLoading?: boolean;
  onOpenRemoteWorktree?: (w: RemoteWorktree, mode?: 'files') => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  onRebuildSandbox?: (w: RemoteWorktree) => void;
  /** The open Focus's Jarvis, for its header (this space's pane only). */
  jarvis?: FocusJarvisHeader;
  /** Each Focus's Jarvis badges for its collapsed row (this space's pane only). */
  jarvisBadges?: Map<string, { pendingApprovals: number; unread: boolean }>;
  /** A collapsed Focus was clicked, before it is activated. */
  onOpenFocus?: (id: string) => void;
  /** A workspace switch the server refused — shown on the dashboard's banner. */
  onSwitchError?: (message: string) => void;
};

function WorkspaceSwitcher({
  active,
  workspaces,
  onSelect,
}: {
  active: Workspace;
  workspaces: Workspace[];
  /** A pick from the list or the dots: the dots slide the carousel to a neighbour. */
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex min-w-0 items-center">
      <button
        type="button"
        aria-label={`Switch workspace, current: ${active.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`group flex h-8 min-w-0 items-center gap-2 rounded-[10px] pl-1.5 pr-1 text-left transition-colors hover:bg-white/[0.06] ${open ? 'bg-white/[0.06]' : ''}`}
      >
        {/* A tinted tile, like a tab's icon on the right. */}
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-[10px] font-semibold uppercase text-zinc-200 ring-1 ring-inset ring-white/10"
          style={{ backgroundColor: `color-mix(in srgb, ${active.color} 28%, transparent)` }}
        >
          {active.icon.slice(0, 2)}
        </span>
        <span data-testid="space-name" className="truncate text-[14px] font-medium text-zinc-100">
          {active.name}
        </span>
        {/* One dropdown button: the chevron sits inside it, next to the name. */}
        <span aria-hidden data-testid="space-chevron"
          className={`flex h-5 w-4 shrink-0 items-center justify-center text-zinc-500 transition-transform group-hover:text-zinc-300 ${open ? 'rotate-180' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Workspaces"
          className="surface-pop absolute left-0 top-full z-40 mt-1 w-64 rounded-[13px] p-1"
        >
          {workspaces.map((workspace) => {
            const selected = workspace.id === active.id;
            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
                aria-current={selected ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  onSelect(workspace.id);
                }}
                className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-[13px] ${
                  selected ? 'tab-pill text-zinc-100' : 'border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
                }`}
              >
                <span
                  aria-hidden
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-[10px] font-semibold text-zinc-200 ring-1 ring-inset ring-white/10"
                  style={{ backgroundColor: `color-mix(in srgb, ${workspace.color} 28%, transparent)` }}
                >
                  {workspace.icon.slice(0, 2)}
                </span>
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {selected && <span className="text-xs text-emerald-400">✓</span>}
              </button>
            );
          })}
          {/* Where this space sits among the others, and the chord that walks them. */}
          {workspaces.length > 1 && (
            <div data-testid="space-dots-row" className="mt-1 flex items-center gap-2 border-t border-zinc-800 px-2 pb-0.5 pt-1.5">
              <div className="min-w-0 flex-1">
                <SpaceDots spaces={workspaces} activeId={active.id} onSelect={(id) => { setOpen(false); onSelect(id); }} />
              </div>
              <span className="shrink-0 font-mono text-[11px] text-zinc-600">⌘⇧← →</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  repos, worktrees, selected, onSelect, onOpenSettings, running,
  onCollapse, collapsing = false, slideIn = false, onAddRepo, onOpenWorktree,
  activeWorktreePath, onNewWorktree, onWorktreeSettings, onProjectSettings, onDeleteWorktree, update,
  remoteWorktrees = [], runnerStatuses = [], remoteLoading = false, onOpenRemoteWorktree, onDeleteRemoteWorktree, onRebuildSandbox,
  onOpenMr,
  onOpenDiff,
  onSwitchError,
  jarvis,
  jarvisBadges,
  onOpenFocus,
}: Props) {
  const { workspace, allWorkspaces, switchTo } = useWorkspace();
  // Drag the right edge to resize; pointer capture keeps the drag alive over
  // an embed, and the edge follows the cursor so it rarely strays
  // onto a native preview view. 288 = the old fixed w-72.
  const { width, resizing, handleProps } = useResizableWidth({
    storageKey: 'strado.sidebarWidth', min: 220, max: 480, fallback: 288, edge: 'right',
  });

  const { prev, next } = useSpaceNeighbors(allWorkspaces, workspace.id);
  const carousel = useRef<SpaceCarouselHandle>(null);

  // Everything the body needs except the data: the active pane gets the live
  // props, a neighbour pane gets its snapshot.
  const bodyProps = {
    onAddRepo,
    onOpenWorktree, onOpenMr, onOpenDiff, activeWorktreePath, onNewWorktree, onWorktreeSettings, onProjectSettings, onDeleteWorktree,
    // Dashboard's switch-error handler is its generic error banner.
    onError: onSwitchError,
  };
  // A neighbour's snapshot is local-only, so it shows no runner rows — those
  // appear when you land on that space.
  const snapshotPane = (wsId: string, data: { repos: RepoConfig[]; worktrees: Worktree[] } | null) => (
    <SidebarBody
      {...bodyProps}
      wsId={wsId}
      repos={data?.repos ?? []}
      worktrees={data?.worktrees ?? []}
      remoteWorktrees={[]}
      runnerStatuses={[]}
      isActivePane={false}
    />
  );

  const panes: CarouselPane[] = [];
  if (prev) panes.push({ id: prev.space.id, content: snapshotPane(prev.space.id, prev.data) });
  const centerIndex = panes.length;
  panes.push({
    id: workspace.id,
    content: (
      <SidebarBody
        {...bodyProps}
        wsId={workspace.id}
        repos={repos}
        worktrees={worktrees}
        remoteWorktrees={remoteWorktrees}
        runnerStatuses={runnerStatuses}
        remoteLoading={remoteLoading}
        onOpenRemoteWorktree={onOpenRemoteWorktree}
        onDeleteRemoteWorktree={onDeleteRemoteWorktree}
        onRebuildSandbox={onRebuildSandbox}
        jarvis={jarvis}
        jarvisBadges={jarvisBadges}
        onOpenFocus={onOpenFocus}
      />
    ),
  });
  if (next) panes.push({ id: next.space.id, content: snapshotPane(next.space.id, next.data) });

  // The carousel has already moved the track by the time this runs, and the
  // pane it left behind is inert — so a switch that fails has to put the track
  // back and say so, not disappear into a floating promise.
  const commitSpace = async (id: string) => {
    try {
      await switchTo(id);
    } catch (e) {
      carousel.current?.reseat();
      onSwitchError?.(`Could not switch to that workspace: ${(e as Error).message}`);
    }
  };

  // A dot for a neighbour animates the carousel, which commits when it lands.
  // Any space further away has no pane to slide, so it switches straight over.
  const selectSpace = (id: string) => {
    if (id === workspace.id) return;
    if (prev && id === prev.space.id) { carousel.current?.goTo(-1); return; }
    if (next && id === next.space.id) { carousel.current?.goTo(1); return; }
    void commitSpace(id);
  };

  useSpaceShortcut((dir) => carousel.current?.goTo(dir));
  const insetTitleBar = useInsetTitleBar();

  return (
    // On the app canvas, like the panes: no edge of its own, so its cards float
    // on the same ground as the pane cards across the gutter.
    <aside data-testid="sidebar" data-collapsed={collapsing || undefined} data-slide-in={slideIn || undefined} aria-hidden={collapsing || undefined}
      className={`sidebar-slide relative flex h-screen shrink-0 flex-col bg-zinc-950 ${collapsing ? 'pointer-events-none' : ''}`}
      style={{ width, '--sidebar-w': `${width}px` } as React.CSSProperties}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={`absolute inset-y-0 -right-0.5 z-20 w-1.5 cursor-col-resize ${resizing ? 'bg-sky-500/50' : 'hover:bg-sky-500/30'}`}
        {...handleProps}
      />
      {insetTitleBar ? (
        // macOS: one row — the traffic lights (no native title bar), the space
        // switcher, then « at the far right. The row's blank parts drag the window.
        // The switcher is only as wide as its name, so the rest of the row drags too.
        <div className="app-drag flex shrink-0 items-center gap-1 pl-2 pr-3"
          style={{ height: TITLE_BAR_HEIGHT }}>
          <TrafficLightsSpacer />
          <div className="min-w-0 flex-1 [&>div>button]:w-auto [&>div>button]:max-w-full">
            <WorkspaceSwitcher active={workspace} workspaces={allWorkspaces} onSelect={selectSpace} />
          </div>
          <SidebarToggleButton open onClick={onCollapse} />
        </div>
      ) : (
        // One row at the tab bar's height, so the two headers line up.
        <div className="flex shrink-0 items-center gap-1 pl-2 pr-3" style={{ height: TITLE_BAR_HEIGHT }}>
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher active={workspace} workspaces={allWorkspaces} onSelect={selectSpace} />
          </div>
          <SidebarToggleButton open onClick={onCollapse} />
        </div>
      )}

      <SpaceCarousel
        ref={carousel}
        panes={panes}
        centerIndex={centerIndex}
        onCommit={(id) => { void commitSpace(id); }}
      />

      {/* The page icons in one glass bar, its bottom on the Dock's line. */}
      <div className="flex flex-col gap-1.5 px-2 pb-2 pt-1.5">
        <UpdateFooter {...update} />
        <SidebarNav selected={selected} onSelect={onSelect} onOpenSettings={onOpenSettings} running={running} />
      </div>
    </aside>
  );
}
