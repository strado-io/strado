// One space's sidebar pane: the Focus pill (with Search and New worktree
// beside it), then the active Focus's worktrees as cards. Nothing else: a
// Focus is one task's set of worktrees, and everything else is a ⌘K or a
// Focus switch away.
import { useRef, useState } from 'react';
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
import { useFocuses } from '../../hooks/useFocuses';
import { FocusPill, FocusPopover } from './FocusSwitcher';
export { BranchIcon, RepoIcon, type MenuItem } from './rowBits';
import { shortRelativeTime } from '../../lib/relativeTime';
import { SidebarToolbar } from './SidebarToolbar';
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
  onWorktreeSettings: (w: Worktree) => void;
  onDeleteWorktree: (w: Worktree) => void;
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  /** True until the first runner-worktree fetch for this space settles. */
  remoteLoading?: boolean;
  /** Toolbar Search: opens ⌘K. */
  onSearch: () => void;
  /** The Worktrees page, from the Focus popover. Absent until it exists. */
  onAllWorktrees?: () => void;
  /** Surfaces a failed change in the dashboard's error banner. */
  onError?: (message: string) => void;
};

/**
 * A worktree on a runner. Rendered in the same list as local ones because
 * that adjacency is the point — but always badged with the machine, because
 * where it runs decides what it can see.
 */
function RemoteRow({ w, repoName, reachable, activeRow, onRemove, removeLabel = 'Remove from focus', onOpenRemoteWorktree, onDeleteRemoteWorktree, onContextMenu }: {
w: RemoteWorktree;
/** The repo it belongs to, for the card's first line. */
repoName?: string;
reachable: boolean;
activeRow: boolean;
/** Takes the row out of the Focus; the worktree itself is untouched. */
onRemove?: () => void;
removeLabel?: string;
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
    ...(onRemove ? [{ text: removeLabel, onClick: onRemove }] : []),
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
  onOpenMr, onOpenDiff, onNewWorktree, onWorktreeSettings, onDeleteWorktree,
  onOpenRemoteWorktree, onDeleteRemoteWorktree,
  remoteLoading = false, onSearch, onAllWorktrees, onError,
}: SidebarBodyProps) {
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));
  const { focuses, active, activeId, activate, create, rename, remove, setMembership } = useFocuses(wsId);
  const report = (what: string) => (err: unknown) => onError?.(`${what}: ${(err as Error).message}`);
  // The Focus popover: open in browse mode from the pill, in create mode from
  // the empty state and the blank-space menu.
  const [switcher, setSwitcher] = useState<null | 'browse' | 'create'>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const openSwitcher = (mode: 'browse' | 'create') => setSwitcher(mode);
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
    { text: 'New focus…', onClick: () => openSwitcher('create') },
  ]);
  const vscodeTabs = useVscodeTabs();
  // Last-opened times for the cards; the same map ⌘K ranks by.
  const lru = readWorktreeLru();
  // Ticket summaries the Dashboard polls for every row: a card with no name of its own borrows its ticket's.
  const tickets = useTickets();
  const browserTabs = useBrowserTabs();
  const runnerOnline = (runnerId: string) =>
    runnerStatuses.find((r) => r.runnerId === runnerId)?.online ?? false;
  const removeFromFocus = (pinId: string) => {
    if (active) void setMembership(active.id, pinId, false).catch(report('Could not remove from focus'));
  };

  const localRow = (w: Worktree, repoName: string) => {
    const open: OpenWorktree = onOpenWorktree;
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w], vscodeTabs, browserTabs);
    const mr = mrByPath.get(w.path);
    const testIdSuffix = w.path;
    const pinId = localPinId(w);
    const menuItems: MenuItem[] = [
      { text: 'Settings', onClick: () => onWorktreeSettings(w) },
      { text: `Remove from ${active?.name ?? 'focus'}`, onClick: () => removeFromFocus(pinId) },
      { text: 'Delete worktree', danger: true, onClick: () => onDeleteWorktree(w) },
    ];
    const ticketId = w.meta?.ticketId?.trim();
    const issue = ticketId ? tickets.issues[ticketRef(w.meta?.ticketProvider, ticketId)] : undefined;
    const { title, subtitle } = cardLines(w, repoName, { ticketSummary: issue?.summary, prTitle: mr?.title });
    const repo = repos.find((r) => r.id === w.repoId);
    return (
      <WorktreeRowItem
        key={w.path}
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
          time={shortRelativeTime(lru[w.path])}
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
  // Members that resolve to nothing (deleted worktree, runner offline) render
  // nothing; they are not pruned here so a runner coming back brings its row back.
  const rows = (active?.members ?? []).flatMap((pinId) => {
    const local = localByPinId.get(pinId);
    if (local) return [localRow(local, repos.find((r) => r.id === local.repoId)?.name ?? '')];
    const remote = remoteByPinId.get(pinId);
    if (!remote) return [];
    return [(
      <RemoteRow key={pinId} w={remote} repoName={repos.find((r) => r.id === remote.localRepoId)?.name ?? remote.remoteRepoName ?? ''}
        reachable={runnerOnline(remote.runnerId)} activeRow={remote.path === activeWorktreePath}
        onRemove={() => removeFromFocus(pinId)} removeLabel={`Remove from ${active?.name ?? 'focus'}`}
        onContextMenu={openContextMenu} onOpenRemoteWorktree={onOpenRemoteWorktree} onDeleteRemoteWorktree={onDeleteRemoteWorktree} />
    )];
  });

  const pillRect = () => {
    const r = pillRef.current?.getBoundingClientRect();
    return r ? { left: r.left, bottom: r.bottom, width: r.width } : { left: 8, bottom: 40, width: 272 };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarToolbar onSearch={onSearch} onNewWorktree={onNewWorktree}
        leading={<FocusPill focus={active} open={switcher !== null} pillRef={pillRef} onClick={() => setSwitcher((s) => (s ? null : 'browse'))} />} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onContextMenu={openBlankContextMenu}>
        <section aria-label="Focus" className="mt-2">
          {!active ? (
            <div className="px-2.5 py-2 text-xs text-zinc-600">
              <p>No focus. A focus is one task's worktrees, across repos; the sidebar shows only the active one.</p>
              <button type="button" onClick={() => openSwitcher('create')}
                className="mt-2 rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100">
                New focus
              </button>
            </div>
          ) : rows.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-zinc-600">Nothing in {active.name} yet. Search to open a worktree into it, or ✎ to start one.</p>
          ) : (
            <div className="mb-1.5 flex flex-col gap-1.5">{rows}</div>
          )}
          {/* First runner fetch still in flight: say so, quietly. Runner rows
              appearing a beat after the local ones otherwise looks like a bug. */}
          {remoteLoading && (
            <div className="flex items-center gap-2 rounded-md px-2 py-2 text-xs text-zinc-600">
              <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border border-zinc-800 border-t-zinc-500" />
              <span className="animate-pulse">Checking runners…</span>
            </div>
          )}
          {runnerStatuses.filter((r) => r.error).map((r) => (
            <div key={r.runnerId} className="px-2 py-1.5 text-[11px] text-amber-600/80">{r.name}: {r.error}</div>
          ))}
        </section>
      </div>

      {switcher && (
        <FocusPopover anchor={pillRect()} focuses={focuses} activeId={activeId} mode={switcher}
          onActivate={activate}
          onCreate={(name) => void create(name).catch(report('Could not create focus'))}
          onRename={(id, name) => void rename(id, name).catch(report('Could not rename focus'))}
          onDelete={(id) => void remove(id).catch(report('Could not delete focus'))}
          onAllWorktrees={onAllWorktrees}
          onClose={() => setSwitcher(null)} />
      )}

      {contextMenu && (
        <MenuPopover pos={contextMenu} items={contextMenu.items} anchor="left" onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
