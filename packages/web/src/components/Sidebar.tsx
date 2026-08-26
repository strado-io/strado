import { useRef } from 'react';
import type { RemoteWorktree, RunnerStatus } from '../api';
import type { RepoConfig, Worktree } from '../types';
import { useResizableWidth } from '../hooks/resizableWidth';
import { useSpaceNeighbors } from '../hooks/spaceNeighbors';
import { useSpaceShortcut } from '../hooks/spaceShortcut';
import { useWorkspace } from '../hooks/useWorkspace';
import { SidebarBody } from './sidebar/SidebarBody';
import { SpaceCarousel, type CarouselPane, type SpaceCarouselHandle } from './sidebar/SpaceCarousel';
import { SpaceDots } from './sidebar/SpaceDots';
import { OrgChip } from './OrgChip';
import { UpdateFooter, type UpdateFooterProps } from './UpdateFooter';

/**
 * One view left. 'active' used to list running dev servers on their own page —
 * dead most of the time, since the signal it carried (a running server, an
 * agent at work) already lives on the worktree rows and the session rail.
 */
export type SidebarView = { kind: 'tasks' };

export type Props = {
  repos: RepoConfig[];
  worktrees: Worktree[];
  selected: SidebarView;
  onSelect: (view: SidebarView) => void;
  onOpenSettings: () => void;
  onOpenOrgSettings: (section: 'organization') => void;
  onOpenFeedback: () => void;
  onOpenWorkspaces: () => void;
  onOpenWorkspaceSettings: () => void;
  taskCount: number;
  onCollapse: () => void;
  onAddRepo: () => void;
  onDeleteRepo: (repo: RepoConfig) => void;
  expandedRepos: Set<string>;
  onToggleRepo: (repoId: string) => void;
  onOpenWorktree: (w: Worktree) => void;
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

// The space name. Deliberately not a control: switching spaces is the swipe
// and the dots at the bottom, so a second affordance here would be a decoy.
function SpaceHeader({ icon, name }: { icon: string; name: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold uppercase text-zinc-300">
        {icon.slice(0, 2)}
      </span>
      <span data-testid="space-name" className="truncate text-sm font-medium text-zinc-100">
        {name}
      </span>
    </div>
  );
}

export function Sidebar({
  repos, worktrees, selected, onSelect, onOpenSettings, onOpenOrgSettings, onOpenFeedback, onOpenWorkspaces, onOpenWorkspaceSettings,
  taskCount, onCollapse, onAddRepo, onDeleteRepo, expandedRepos, onToggleRepo, onOpenWorktree,
  activeWorktreePath, onNewWorktreeForRepo, onWorktreeSettings, onDeleteWorktree, update,
  remoteWorktrees = [], runnerStatuses = [], remoteLoading = false, onOpenRemoteWorktree, onDeleteRemoteWorktree,
  onSwitchError,
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
    selected, onSelect, taskCount, onAddRepo, onDeleteRepo, expandedRepos, onToggleRepo,
    onOpenWorktree, activeWorktreePath, onNewWorktreeForRepo, onWorktreeSettings, onDeleteWorktree,
  };
  // A neighbour's snapshot is local-only, so it shows no runner rows — those
  // appear when you land on that space.
  const snapshotPane = (data: { repos: RepoConfig[]; worktrees: Worktree[] } | null) => (
    <SidebarBody
      {...bodyProps}
      repos={data?.repos ?? []}
      worktrees={data?.worktrees ?? []}
      remoteWorktrees={[]}
      runnerStatuses={[]}
    />
  );

  const panes: CarouselPane[] = [];
  if (prev) panes.push({ id: prev.space.id, content: snapshotPane(prev.data) });
  const centerIndex = panes.length;
  panes.push({
    id: workspace.id,
    content: (
      <SidebarBody
        {...bodyProps}
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
  if (next) panes.push({ id: next.space.id, content: snapshotPane(next.data) });

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
            <SpaceHeader icon={workspace.icon} name={workspace.name} />
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
          onOpenSettings={onOpenWorkspaceSettings}
          onOpenManage={onOpenWorkspaces}
        />
        <UpdateFooter {...update} />
        <OrgChip onOpenSettings={onOpenOrgSettings} />
        <button className="group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          onClick={onOpenFeedback} aria-label="Send feedback">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-zinc-600 group-hover:text-zinc-400"
            fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3.5h12v8H8l-3 2.5v-2.5H2z" />
          </svg>
          Feedback
        </button>
        <button className="group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          onClick={onOpenSettings} aria-label="App settings">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-zinc-600 group-hover:text-zinc-400"
            fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" />
          </svg>
          Settings
        </button>
      </div>
    </aside>
  );
}
