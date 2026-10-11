// One space's sidebar pane: a toolbar (Search, Focus, Add repo, New worktree),
// then either Working on — the worktrees you have opened here, as cards — with
// Settled (finished work) underneath, or, with Focus off, the repo tree:
// every repo with all of its worktrees (see RepoTree).
import { useState } from 'react';
import type { RemoteWorktree, RunnerStatus } from '../../api';
import type { MergeRequest, RepoConfig, Worktree } from '../../types';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { sessionChips } from '../../hooks/sessions';
import { useVscodeTabs } from '../../hooks/vscodeTabs';
import { useBrowserTabs } from '../../hooks/browserTabs';
import type { AddRepoAnchor } from '../Sidebar';
import { SessionAvatarStack } from './sessionAvatars';
import { cardLines, worktreeLabel } from './labels';
import { WorktreeCard } from './WorktreeCard';
import { readWorktreeLru } from '../../lib/worktreeLru';
import { ticketRef, useTickets } from '../../hooks/tickets';
import { WorktreeRowItem, type OpenWorktree } from './WorktreeRowItem';
import { BrailleSpinner, HoverActions, Menu, MenuPopover, MergeRequestBadge, agentWorking, diffBadge, isRunning, type MenuItem } from './rowBits';
import { RepoTree } from './RepoTree';
import { SettledSection } from './SettledSection';
import { useSidebarFocus } from '../../hooks/sidebarFocus';
export { BranchIcon, RepoIcon, type MenuItem } from './rowBits';
import { shortRelativeTime } from '../../lib/relativeTime';
import { SidebarToolbar } from './SidebarToolbar';
import { useLooseWorktrees } from '../../hooks/looseWorktrees';
import { localPinId, remotePinId } from './pinIds';

export type SidebarBodyProps = {
  wsId: string;
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  runnerStatuses: RunnerStatus[];
  onAddRepo: (anchor?: AddRepoAnchor) => void;
  onOpenWorktree: OpenWorktree;
  /** Opens the diff & commit modal for a worktree (hover-card quick action). */
  onOpenDiff?: (w: Worktree) => void;
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  activeWorktreePath: string | null;
  /** New worktree with the repo still to pick (toolbar and blank-space menu). */
  onNewWorktree: () => void;
  /** New worktree in a given repo (Focus off: the repo row's +). */
  onNewWorktreeForRepo: (repo: RepoConfig) => void;
  /** Remove a repo from the space (Focus off: the repo row's menu). */
  onDeleteRepo: (repo: RepoConfig) => void;
  onWorktreeSettings: (w: Worktree) => void;
  onDeleteWorktree: (w: Worktree) => void;
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  /** True until the first runner-worktree fetch for this space settles. */
  remoteLoading?: boolean;
  /** Toolbar Search: opens ⌘K. */
  onSearch: () => void;
  /** Surfaces a failed change in the dashboard's error banner. */
  onError?: (message: string) => void;
};

/**
 * A worktree on a runner. Rendered in the same list as local ones because
 * that adjacency is the point — but always badged with the machine, because
 * where it runs decides what it can see.
 */
function RemoteRow({ w, repoName, reachable, activeRow, onRemove, onOpenRemoteWorktree, onDeleteRemoteWorktree, onContextMenu }: {
w: RemoteWorktree;
/** The repo it belongs to, for the card's first line. */
repoName?: string;
reachable: boolean;
activeRow: boolean;
/** Takes the row out of Working on; the worktree itself is untouched. Absent outside Working on. */
onRemove?: () => void;
onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
/** Right-click: the row's menu at the cursor. */
onContextMenu?: (e: React.MouseEvent, items: MenuItem[]) => void;
}) {
  const chips = sessionChips([w as unknown as Worktree]);
  // A worktree appears once, so a loose row keeps the plain id; a member is prefixed.
  const testIdSuffix = `${w.runnerId}:${w.path}`;
  const label = w.branch ?? w.name;
  const menuItems: MenuItem[] = [
    ...(onRemove ? [{ text: 'Remove from Working on', onClick: onRemove }] : []),
    ...(!w.isRepoRoot && onDeleteRemoteWorktree
      ? [{ text: 'Delete worktree', danger: true, onClick: () => onDeleteRemoteWorktree(w) }]
      : []),
  ];
  const open = () => onOpenRemoteWorktree?.(w);
  return (
    <WorktreeRowItem
      worktree={w as unknown as Worktree}
      chips={chips}
      mr={null}
      runnerName={w.runnerName}
      onOpen={open}
      onContextMenu={onContextMenu && menuItems.length > 0 ? (e) => onContextMenu(e, menuItems) : undefined}
      className={`group relative flex items-stretch rounded-lg ${activeRow ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`}
    >
      <WorktreeCard
        repo={repoName ? { id: w.localRepoId ?? repoName, name: repoName } : null}
        title={label}
        subtitle={w.name !== label ? w.name : ''}
        time={shortRelativeTime(readWorktreeLru()[w.path])}
        active={activeRow}
        muted={!reachable}
        onOpen={open}
        label={`${label} on ${w.runnerName}${reachable ? '' : ' (offline — the worktree is safe there)'}`}
        trailing={(
          <>
            <SessionAvatarStack chips={chips} testId={`session-stack-${testIdSuffix}`} />
            <span
              data-testid={`runner-icon-${testIdSuffix}`}
              role="img"
              aria-label={`${w.runnerName}${reachable ? ' runner' : ' runner, offline'}`}
              title={`${w.runnerName}${reachable ? '' : ' · offline'}`}
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${
                reachable ? 'text-zinc-500' : 'text-red-400/70'
              }`}
            >
              <svg aria-hidden width="14" height="14" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19,2H5A3,3,0,0,0,2,5V15a3,3,0,0,0,3,3H7.64l-.58,1a2,2,0,0,0,0,2,2,2,0,0,0,1.75,1h6.46A2,2,0,0,0,17,21a2,2,0,0,0,0-2l-.59-1H19a3,3,0,0,0,3-3V5A3,3,0,0,0,19,2ZM8.77,20,10,18H14l1.2,2ZM20,15a1,1,0,0,1-1,1H5a1,1,0,0,1-1-1V14H20Zm0-3H4V5A1,1,0,0,1,5,4H19a1,1,0,0,1,1,1Z" />
              </svg>
            </span>
          </>
        )}
      />
      <HoverActions active={activeRow}>
        {/* A repo's main working tree is not removable as a worktree — the
            delete route refuses it — so its menu only offers Remove, if that. */}
        {menuItems.length > 0 && (
          <Menu
            label={`${label} on ${w.runnerName} actions`}
            items={menuItems}
          />
        )}
      </HoverActions>
    </WorktreeRowItem>
  );
}

export function SidebarBody({
  wsId, repos, worktrees, remoteWorktrees, runnerStatuses,
  onAddRepo, onOpenWorktree, activeWorktreePath,
  onOpenMr, onOpenDiff, onNewWorktree, onNewWorktreeForRepo, onDeleteRepo, onWorktreeSettings, onDeleteWorktree,
  onOpenRemoteWorktree, onDeleteRemoteWorktree,
  remoteLoading = false, onSearch,
}: SidebarBodyProps) {
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));
  const loose = useLooseWorktrees(wsId);
  const [focus, toggleFocus] = useSidebarFocus();
  // Right-click on a worktree row: its ⋯ menu, at the cursor.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const openContextMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation(); // a row's menu, not the blank-space one below
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };
  // Right-click on blank sidebar space: what you can make from here.
  const openBlankContextMenu = (e: React.MouseEvent) => openContextMenu(e, [
    { text: 'New worktree…', onClick: onNewWorktree },
    { text: 'Add repo…', onClick: () => onAddRepo({ left: e.clientX, right: e.clientX, bottom: e.clientY }) },
  ]);
  const vscodeTabs = useVscodeTabs();
  // Last-opened times for the cards; the same map ⌘K ranks by.
  const lru = readWorktreeLru();
  // Ticket summaries the Dashboard polls for every row: a card with no name of its own borrows its ticket's.
  const tickets = useTickets();
  const browserTabs = useBrowserTabs();
  const runnerOnline = (runnerId: string) =>
    runnerStatuses.find((r) => r.runnerId === runnerId)?.online ?? false;
  // A worktree whose PR is merged or closed has settled: it leaves Working on
  // for the Settled section at the bottom. A repo's own checkout (master/main)
  // never settles, whatever PR its branch once had.
  const repoRoots = new Set(repos.map((r) => r.path));
  const isSettled = (w: Worktree) => {
    const state = mrByPath.get(w.path)?.state;
    return (state === 'merged' || state === 'closed') && !repoRoots.has(w.path);
  };

  const localRow = (w: Worktree, repoName: string, placement: 'loose' | 'settled') => {
    const open: OpenWorktree = onOpenWorktree;
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w], vscodeTabs, browserTabs);
    const mr = mrByPath.get(w.path);
    const testIdSuffix = w.path;
    const pinId = localPinId(w);
    const menuItems: MenuItem[] = [
      { text: 'Settings', onClick: () => onWorktreeSettings(w) },
      ...(placement === 'loose' ? [{ text: 'Remove from Working on', onClick: () => loose.remove(pinId) }] : []),
      { text: 'Delete worktree', danger: true, onClick: () => onDeleteWorktree(w) },
    ];
    const ticketId = w.meta?.ticketId?.trim();
    const issue = ticketId ? tickets.issues[ticketRef(w.meta?.ticketProvider, ticketId)] : undefined;
    const { title, subtitle } = cardLines(w, repoName, { ticketSummary: issue?.summary, prTitle: mr?.title });
    const repo = repos.find((r) => r.id === w.repoId);
    // A settled card dates its PR; a live one dates the last time it was opened here.
    const time = placement === 'settled' && mr
      ? shortRelativeTime(mr.mergedAt ?? mr.updatedAt)
      : shortRelativeTime(lru[w.path]);
    return (
      <WorktreeRowItem
        key={`${placement}:${w.path}`}
        worktree={w}
        chips={chips}
        mr={mr}
        onOpen={open}
        onOpenMr={onOpenMr}
        onOpenDiff={onOpenDiff}
        onSettings={onWorktreeSettings}
        onContextMenu={(e) => openContextMenu(e, menuItems)}
        className={`group relative flex items-stretch rounded-lg ${
          activeRow ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`}
      >
        <WorktreeCard
          repo={repo ? { id: repo.id, name: repo.name } : null}
          title={title}
          subtitle={subtitle}
          time={time}
          active={activeRow}
          onOpen={() => open(w)}
          label={worktreeLabel(w)}
          leading={mr ? (
            <MergeRequestBadge worktree={w} mr={mr} onOpen={onOpenMr} testIdSuffix={testIdSuffix} />
          ) : agentWorking(w) ? (
            <BrailleSpinner small />
          ) : null}
          trailing={(
            <>
              {diffBadge(w, testIdSuffix)}
              <SessionAvatarStack chips={chips} testId={`session-stack-${testIdSuffix}`} />
              {isRunning(w) && (
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  <span
                    data-testid={`run-dot-${testIdSuffix}`}
                    className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                  />
                </span>
              )}
            </>
          )}
        />
        <HoverActions active={activeRow}>
          <Menu label={`${worktreeLabel(w)} actions`} items={menuItems} />
        </HoverActions>
      </WorktreeRowItem>
    );
  };

  const localByPinId = new Map(worktrees.map((w) => [localPinId(w), w]));
  const remoteByPinId = new Map(remoteWorktrees.map((w) => [remotePinId(w), w]));
  // Ids that resolve to nothing (deleted worktree, runner offline) render nothing;
  // they are not pruned here so a runner coming back brings its row back.
  const looseRows = loose.ids.flatMap((pinId) => {
    const local = localByPinId.get(pinId);
    if (local) return isSettled(local) ? [] : [localRow(local, repos.find((r) => r.id === local.repoId)?.name ?? '', 'loose')];
    const remote = remoteByPinId.get(pinId);
    if (!remote) return [];
    return [(
      <RemoteRow key={`loose:${pinId}`} w={remote} repoName={repos.find((r) => r.id === remote.localRepoId)?.name ?? remote.remoteRepoName ?? ''}
        reachable={runnerOnline(remote.runnerId)} activeRow={remote.path === activeWorktreePath}
        onRemove={() => loose.remove(pinId)}
        onContextMenu={openContextMenu} onOpenRemoteWorktree={onOpenRemoteWorktree} onDeleteRemoteWorktree={onDeleteRemoteWorktree} />
    )];
  });

  const settledWorktreeRows = worktrees.filter(isSettled).map((w) =>
    localRow(w, repos.find((r) => r.id === w.repoId)?.name ?? '', 'settled'));

  // First runner fetch still in flight: say so, quietly. Runner rows appearing
  // a beat after the local ones otherwise looks like a bug. Then any runner errors.
  const runnerNotes = (
    <>
      {remoteLoading && (
        <div className="flex items-center gap-2 rounded-md px-2 py-2 text-xs text-zinc-600">
          <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border border-zinc-800 border-t-zinc-500" />
          <span className="animate-pulse">Checking runners…</span>
        </div>
      )}
      {runnerStatuses.filter((r) => r.error).map((r) => (
        <div key={r.runnerId} className="px-2 py-1.5 text-[11px] text-amber-600/80">{r.name}: {r.error}</div>
      ))}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarToolbar onSearch={onSearch} focus={focus} onToggleFocus={toggleFocus} onAddRepo={onAddRepo} onNewWorktree={onNewWorktree} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onContextMenu={openBlankContextMenu}>
        {focus ? (
          <section aria-label="Working on" className="mt-2">
            {looseRows.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-zinc-600">Nothing yet. Search to open a worktree, or ✎ to start one.</p>
            ) : (
              <div className="mb-1.5 flex flex-col gap-1.5">{looseRows}</div>
            )}
            {runnerNotes}
          </section>
        ) : (
          <RepoTree
            repos={repos} worktrees={worktrees} remoteWorktrees={remoteWorktrees} runnerStatuses={runnerStatuses}
            activeWorktreePath={activeWorktreePath} mrByPath={mrByPath} vscodeTabs={vscodeTabs} browserTabs={browserTabs}
            onAddRepo={onAddRepo} onNewWorktreeForRepo={onNewWorktreeForRepo} onDeleteRepo={onDeleteRepo}
            onOpenWorktree={onOpenWorktree} onOpenMr={onOpenMr} onOpenDiff={onOpenDiff}
            onWorktreeSettings={onWorktreeSettings} onDeleteWorktree={onDeleteWorktree}
            onOpenRemoteWorktree={onOpenRemoteWorktree} onDeleteRemoteWorktree={onDeleteRemoteWorktree}
            onContextMenu={openContextMenu}
          >
            {runnerNotes}
          </RepoTree>
        )}
      </div>

      {focus && <SettledSection worktreeRows={settledWorktreeRows} />}

      {contextMenu && (
        <MenuPopover pos={contextMenu} items={contextMenu.items} anchor="left" onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
