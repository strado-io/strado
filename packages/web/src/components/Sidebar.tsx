import { useEffect, useRef, useState } from 'react';
import type { RemoteWorktree, RunnerStatus } from '../api';
import type { MergeRequest, RepoConfig, Workspace, Worktree } from '../types';
import { useResizableWidth } from '../hooks/resizableWidth';
import { useSpaceNeighbors } from '../hooks/spaceNeighbors';
import { useSpaceShortcut } from '../hooks/spaceShortcut';
import { useWorkspace } from '../hooks/useWorkspace';
import { SidebarBody } from './sidebar/SidebarBody';
import type { OpenWorktree } from './sidebar/WorktreeRowItem';
import { SpaceCarousel, type CarouselPane, type SpaceCarouselHandle } from './sidebar/SpaceCarousel';
import { SpaceDots } from './sidebar/SpaceDots';
import { AccountMenu } from './AccountMenu';
import { UpdateFooter, type UpdateFooterProps } from './UpdateFooter';

/**
 * One view left. 'active' used to list running dev servers on their own page —
 * dead most of the time, since the signal it carried (a running server, an
 * agent at work) already lives directly on the worktree rows.
 */
export type SidebarView = { kind: 'tasks' } | { kind: 'reviews' } | { kind: 'usage' };

export type Props = {
  repos: RepoConfig[];
  worktrees: Worktree[];
  selected: SidebarView;
  onSelect: (view: SidebarView) => void;
  onOpenSettings: () => void;
  onOpenOrgSettings: (section: 'organization') => void;
  onOpenFeedback: () => void;
  taskCount: number;
  reviewCount?: number;
  /** True until the first workspace-wide code-review fetch settles. */
  reviewLoading?: boolean;
  onCollapse: () => void;
  onAddRepo: () => void;
  onDeleteRepo: (repo: RepoConfig) => void;
  expandedRepos: Set<string>;
  onToggleRepo: (repoId: string) => void;
  onOpenWorktree: OpenWorktree;
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  /** Opens diff & commit for a worktree — the hover card's Changes action. */
  onOpenDiff?: (w: Worktree) => void;
  activeWorktreePath: string | null;
  onNewWorktreeForRepo: (repo: RepoConfig) => void;
  onWorktreeSettings: (w: Worktree) => void;
  onDeleteWorktree: (w: Worktree) => void;
  update: UpdateFooterProps;
  /** Worktrees living on runners, shown under the repo they belong to. */
  remoteWorktrees?: RemoteWorktree[];
  runnerStatuses?: RunnerStatus[];
  /** True until the first runner-worktree fetch for this space settles. */
  remoteLoading?: boolean;
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
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
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        aria-label={`Switch workspace, current: ${active.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-900"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold uppercase text-zinc-300">
          {active.icon.slice(0, 2)}
        </span>
        <span data-testid="space-name" className="truncate text-sm font-medium text-zinc-100">
          {active.name}
        </span>
        <svg className="ml-auto shrink-0 text-zinc-600" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Workspaces"
          className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
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
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${
                  selected ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                <span
                  aria-hidden
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
                  style={{ backgroundColor: workspace.color }}
                >
                  {workspace.icon.slice(0, 2)}
                </span>
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {selected && <span className="text-xs text-emerald-400">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  repos, worktrees, selected, onSelect, onOpenSettings, onOpenOrgSettings, onOpenFeedback,
  taskCount, onCollapse, onAddRepo, onDeleteRepo, expandedRepos, onToggleRepo, onOpenWorktree,
  activeWorktreePath, onNewWorktreeForRepo, onWorktreeSettings, onDeleteWorktree, update,
  remoteWorktrees = [], runnerStatuses = [], remoteLoading = false, onOpenRemoteWorktree, onDeleteRemoteWorktree,
  onOpenMr,
  onOpenDiff,
  onSwitchError,
  reviewCount = 0,
  reviewLoading = false,
}: Props) {
  const { workspace, allWorkspaces, switchTo } = useWorkspace();

  // Drag the right edge to resize; pointer capture keeps the drag alive over
  // the VS Code iframe, and the edge follows the cursor so it rarely strays
  // onto a native preview view. 288 = the old fixed w-72.
  const { width, resizing, handleProps } = useResizableWidth({
    storageKey: 'strado.sidebarWidth', min: 220, max: 480, fallback: 288, edge: 'right',
  });

  const { prev, next } = useSpaceNeighbors(allWorkspaces, workspace.id);
  const carousel = useRef<SpaceCarouselHandle>(null);

  // Everything the body needs except the data: the active pane gets the live
  // props, a neighbour pane gets its snapshot.
  const bodyProps = {
    selected, onSelect, taskCount, reviewCount, reviewLoading, onAddRepo, onDeleteRepo, expandedRepos, onToggleRepo,
    onOpenWorktree, onOpenMr, onOpenDiff, activeWorktreePath, onNewWorktreeForRepo, onWorktreeSettings, onDeleteWorktree,
  };
  // A neighbour's snapshot is local-only, so it shows no runner rows — those
  // appear when you land on that space.
  const snapshotPane = (wsId: string, data: { repos: RepoConfig[]; worktrees: Worktree[] } | null) => (
    <SidebarBody
      {...bodyProps}
      wsId={wsId}
      repos={data?.repos ?? []}
      worktrees={data?.worktrees ?? []}
      taskCount={data?.worktrees.length ?? 0}
      reviewCount={0}
      reviewLoading={false}
      remoteWorktrees={[]}
      runnerStatuses={[]}
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

  return (
    <aside className="relative flex h-screen shrink-0 flex-col border-r border-zinc-900 bg-zinc-950" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={`absolute inset-y-0 -right-0.5 z-20 w-1.5 cursor-col-resize ${resizing ? 'bg-sky-500/50' : 'hover:bg-sky-500/30'}`}
        {...handleProps}
      />
      <div className="border-b border-zinc-900 px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher active={workspace} workspaces={allWorkspaces} onSelect={selectSpace} />
          </div>
          <button aria-label="Collapse sidebar" title="Collapse sidebar (⌘B)" onClick={onCollapse}
            className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">«</button>
        </div>
      </div>

      <SpaceCarousel
        ref={carousel}
        panes={panes}
        centerIndex={centerIndex}
        onCommit={(id) => { void commitSpace(id); }}
      />

      <div className="flex flex-col gap-1 border-t border-zinc-900 p-2">
        <SpaceDots
          spaces={allWorkspaces}
          activeId={workspace.id}
          onSelect={selectSpace}
        />
        <UpdateFooter {...update} />
        <AccountMenu
          onOpenSettings={(section) => section === 'organization' ? onOpenOrgSettings(section) : onOpenSettings()}
          onOpenFeedback={onOpenFeedback}
        />
      </div>
    </aside>
  );
}
