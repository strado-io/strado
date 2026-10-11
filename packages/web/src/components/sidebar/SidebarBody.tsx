// One space's sidebar pane: a toolbar (Search, Add repo, New group, New
// worktree), then Working on, which holds loose worktree rows followed by the
// groups in the working state with their members, and Settled at the bottom
// for finished work. Parked groups have no rows here; the header counts them
// and ⌘K finds them.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FocusGroup, RemoteWorktree, RunnerStatus } from '../../api';
import type { MergeRequest, RepoConfig, Worktree } from '../../types';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { chipStatus, sessionChips } from '../../hooks/sessions';
import { useVscodeTabs } from '../../hooks/vscodeTabs';
import { useBrowserTabs } from '../../hooks/browserTabs';
import type { AddRepoAnchor } from '../Sidebar';
import { SESSION_COLOR, SessionAvatarIcon, SessionAvatarStack } from './sessionAvatars';
import { MR_STATE_COLOR, PIPELINE_DETAIL, PrStateIcon, prKind } from './prVisuals';
import { cardLines, worktreeLabel } from './labels';
import { WorktreeCard } from './WorktreeCard';
import { readWorktreeLru } from '../../lib/worktreeLru';
import { WorktreeRowItem, useRowHoverCardDismiss, type OpenWorktree } from './WorktreeRowItem';
import { useFocusGroups } from '../../hooks/useFocusGroups';
import { useFocusPrefs } from '../../hooks/focusPrefs';
import { GroupList, type MenuItem } from './GroupsView';
import { SettledSection } from './SettledSection';
import { shortRelativeTime } from '../../lib/relativeTime';
import { GroupPickerDialog } from './GroupPickerDialog';
import { NewGroupDialog } from './NewGroupDialog';
import { activeGroupOf, groupState, groupsContaining, isGroupDone, resolveMembers } from './focusGroups';
import { SidebarToolbar } from './SidebarToolbar';
import { useLooseWorktrees } from '../../hooks/looseWorktrees';
import { localPinId, remotePinId, type SidebarEntry } from './pinIds';

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
  /** The header's "N more": opens ⌘K showing only groups. */
  onShowParked: () => void;
  /** Surfaces a failed focus-group change in the dashboard's error banner. */
  onError?: (message: string) => void;
};

function isRunning(w: Worktree): boolean {
  const s = w.process.status;
  return s === 'running' || s === 'starting' || s === 'stopping' || !!w.process.external;
}
function agentWorking(w: Worktree): boolean {
  return w.claudeStatus === 'working' || w.codexStatus === 'working'
    || w.opencodeStatus === 'working' || w.piStatus === 'working';
}

// Terminal-style loader shown while an agent is working (frames via CSS).
function BrailleSpinner({ small = false }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="agent working"
      className={`braille-spinner shrink-0 font-mono leading-none text-amber-400 ${small ? 'text-[13px]' : 'text-sm'}`}
    />
  );
}


// branch glyph (hand-tuned SVG, ships pre-flipped upside down) — marks
// each worktree row as a branch hanging off its repo.
export function BranchIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 48 48" aria-hidden data-worktree-icon="branch"
      className={`-scale-y-100 ${className}`}
      fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4"
    >
      <path clipRule="evenodd" d="M36 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8Zm-22 0a4 4 0 1 0 0-8a4 4 0 0 0 0 8Zm0 32a4 4 0 1 0 0-8a4 4 0 0 0 0 8Z" />
      <path d="M14 12v24v-3c0-8 22-9 22-17v-4" />
    </svg>
  );
}

function HoverActions({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`absolute right-1 z-10 flex items-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${
        active ? 'bg-zinc-800' : 'bg-zinc-900'
      }`}
    >
      {children}
    </span>
  );
}

// The row's leading glyph when a branch has an open/merged/closed PR. The
// detail (title, checks, branches) belongs to the row's hover card — the icon
// is the state at a glance and a click into the review.
function MergeRequestBadge({ worktree, mr, onOpen, testIdSuffix = worktree.path }: {
  worktree: Worktree;
  mr: MergeRequest;
  onOpen?: (w: Worktree, mr: MergeRequest) => void;
  testIdSuffix?: string;
}) {
  const pipeline = mr.pipeline ? PIPELINE_DETAIL[mr.pipeline] : null;
  const { kind } = prKind(mr);
  return (
    <button
      type="button"
      data-testid={`pr-status-${testIdSuffix}`}
      aria-label={`Open ${kind} ${mr.number}, ${mr.state}${pipeline ? `, ${pipeline.label.toLowerCase()}` : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.(worktree, mr);
      }}
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm outline-none ring-offset-zinc-950 focus-visible:ring-1 focus-visible:ring-sky-400"
      style={{ color: MR_STATE_COLOR[mr.state] }}
    >
      <PrStateIcon state={mr.state} />
    </button>
  );
}

export function RepoIcon() {
  // book-with-bookmark repo glyph (hand-tuned SVG), always in the app's
  // primary orange (sky-* is remapped to Strado orange) — one color for every repo
  return (
    <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center text-sky-400">
      {/* GitHub's repo Octicon — drawn on a 16px grid, stays crisp at icon sizes */}
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
        <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
      </svg>
    </span>
  );
}

// small kebab (⋯) button + popover; closes on outside-click via a fixed backdrop

/**
 * A menu's floating list. `anchor: 'right'` hangs it left of the point (under
 * a ⋯ button); 'left' opens it rightwards from the point (a right-click).
 */
function MenuPopover({ pos, items, anchor, onClose }: {
  pos: { x: number; y: number };
  items: MenuItem[];
  anchor: 'left' | 'right';
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // portal: the space carousel's transformed track would otherwise become
  // the containing block for these fixed elements, shoving the popover a
  // pane-width off-screen on every space but the first
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); onClose(); }}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        role="menu"
        className={`fixed z-50 min-w-44 ${anchor === 'right' ? '-translate-x-full' : ''} rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-2xl`}
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.text}
            onClick={() => { onClose(); it.onClick(); }}
            className={`block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-900 ${it.danger ? 'text-red-300' : 'text-zinc-200'}`}
          >
            {it.text}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

function Menu({ label, items, alwaysVisible = false }: {
  label: string;
  items: MenuItem[];
  alwaysVisible?: boolean;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Inside a worktree row this dismisses the row's hover card (a no-op for
  // repo and space menus): the menu, and whatever it opens, take over.
  const dismissHoverCard = useRowHoverCardDismiss();
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          dismissHoverCard();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.right, y: r.bottom });
        }}
        className={`${alwaysVisible ? 'inline-flex' : 'pointer-events-none inline-flex opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'} h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded p-[3px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="currentColor">
          <circle cx="8" cy="3.5" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="8" cy="12.5" r="1.25" />
        </svg>
      </button>
      {pos && (
        <MenuPopover pos={pos} items={items} anchor="right"
          onClose={() => { setPos(null); dismissHoverCard(); }} />
      )}
    </>
  );
}

/**
 * A worktree on a runner. Rendered in the same list as local ones because
 * that adjacency is the point — but always badged with the machine, because
 * where it runs decides what it can see.
 */
function RemoteRow({ w, repoName, reachable, activeRow, placement, groupItems = [], onOpenRemoteWorktree, onDeleteRemoteWorktree, onContextMenu }: {
w: RemoteWorktree;
/** The repo it belongs to, for the card's first line. */
repoName?: string;
reachable: boolean;
activeRow: boolean;
placement: 'loose' | 'focus';
/** Group and Working on items, shown before Delete. */
groupItems?: { text: string; onClick: () => void }[];
onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
/** Right-click: the row's menu at the cursor. */
onContextMenu?: (e: React.MouseEvent, items: MenuItem[]) => void;
}) {
  const chips = sessionChips([w as unknown as Worktree]);
  // A worktree appears once, so a loose row keeps the plain id; a member is prefixed.
  const testIdSuffix = placement === 'focus' ? `focus-${w.runnerId}:${w.path}` : `${w.runnerId}:${w.path}`;
  const label = w.branch ?? w.name;
  const menuItems: MenuItem[] = [
    ...groupItems,
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
      onContextMenu={menuItems.length > 0 && onContextMenu ? (e) => onContextMenu(e, menuItems) : undefined}
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
            delete route refuses it — so its menu holds only the group items. */}
        {(!w.isRepoRoot && onDeleteRemoteWorktree) || groupItems.length > 0 ? (
          <Menu
            label={`${label} on ${w.runnerName} actions`}
            items={menuItems}
          />
        ) : null}
      </HoverActions>
    </WorktreeRowItem>
  );
}

export function SidebarBody({
  wsId, repos, worktrees, remoteWorktrees, runnerStatuses,
  onAddRepo, onOpenWorktree, activeWorktreePath,
  onOpenMr, onOpenDiff, onNewWorktree, onWorktreeSettings, onDeleteWorktree,
  onOpenRemoteWorktree, onDeleteRemoteWorktree,
  remoteLoading = false, onSearch, onShowParked, onError,
}: SidebarBodyProps) {
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));
  const focus = useFocusGroups(wsId);
  const focusPrefs = useFocusPrefs(wsId);
  const loose = useLooseWorktrees(wsId);
  const report = (err: unknown) => onError?.((err as Error).message);
  const doneOf = (g: FocusGroup) =>
    isGroupDone(resolveMembers(g, worktrees, remoteWorktrees), (p) => mrByPath.get(p)?.state ?? null);
  const activeGroup = activeGroupOf(focus.groups, focusPrefs.activeFocusGroupId);
  // The worktree whose "Add to group…" picker is open.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  // The New group dialog, with the worktrees it starts ticked (none from the + button).
  const [newGroupWith, setNewGroupWith] = useState<string[] | null>(null);
  // Right-click on a worktree row: its ⋯ menu, at the cursor.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const openContextMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation(); // a row's menu, not the blank-space one below
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };
  // Fold every group, e.g. to get back to a short list.
  const collapseAll = () => {
    for (const g of focus.groups) if (!focusPrefs.collapsedGroupIds.includes(g.id)) focusPrefs.toggleGroupCollapsed(g.id);
  };
  // Right-click on blank sidebar space: what you can make from here, and tidying up.
  const openBlankContextMenu = (e: React.MouseEvent) => openContextMenu(e, [
    { text: 'New worktree…', onClick: onNewWorktree },
    { text: 'New group…', onClick: () => setNewGroupWith([]) },
    { text: 'Add repo…', onClick: () => onAddRepo({ left: e.clientX, right: e.clientX, bottom: e.clientY }) },
    { text: 'Collapse all', onClick: collapseAll },
  ]);
  // Row-menu entry: a single "Add to group…" that opens the picker, so the
  // menu stays short however many groups exist.
  const groupMenuItems = (memberId: string) => [
    { text: 'Add to group…', onClick: () => setPickerFor(memberId) },
    { text: 'New group…', onClick: () => setNewGroupWith([memberId]) },
  ];
  // Leaving its only open group must not make a worktree vanish: unless it
  // has settled, it stays in Working on as a loose row.
  const removeFromGroup = (group: FocusGroup, pinId: string, settled = false) => {
    const elsewhere = groupsContaining(focus.groups.filter((g) => g.id !== group.id && !doneOf(g)), pinId).length > 0;
    focus.setMembership(group.id, pinId, false)
      .then(() => { if (!elsewhere && !settled) loose.add(pinId); })
      .catch(report);
  };
  const vscodeTabs = useVscodeTabs();
  // Last-opened times for the cards; the same map ⌘K ranks by.
  const lru = readWorktreeLru();
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

  // Uncommitted work on a worktree row: +adds −dels, the same numbers the task
  // table shows. Silent when the tree is clean, so a quiet row stays quiet.
  const diffBadge = (w: Worktree, testIdSuffix = w.path) => {
    const d = w.diffStats;
    if (!d || (d.additions === 0 && d.deletions === 0)) return null;
    return (
      <span
        data-testid={`diff-${testIdSuffix}`}
        title={`${d.files} file${d.files === 1 ? '' : 's'} changed · +${d.additions} -${d.deletions}`}
        className="shrink-0 font-mono text-[10px] tabular-nums"
      >
        <span className="text-emerald-500/80">+{d.additions}</span>
        <span className="ml-1 text-red-400/80">-{d.deletions}</span>
      </span>
    );
  };
  // A member opened from its group makes that group the active one, so
  // ⌥⌘←/→ cycles the group the user is working in.
  const localRow = (w: Worktree, repoName: string, placement: 'loose' | 'focus' | 'settled', group?: FocusGroup) => {
    const open: OpenWorktree = (...args) => { if (group) focusPrefs.setActiveFocusGroupId(group.id); onOpenWorktree(...args); };
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w], vscodeTabs, browserTabs);
    const mr = mrByPath.get(w.path);
    // Members and loose cards share one column: the group header above says where a card belongs.
    // A worktree appears once, so loose and settled rows keep the plain path id; a member is prefixed.
    const testIdSuffix = placement === 'focus' ? `focus-${w.path}` : w.path;
    const pinId = localPinId(w);
    const menuItems: MenuItem[] = [
      { text: 'Settings', onClick: () => onWorktreeSettings(w) },
      ...groupMenuItems(pinId),
      ...(group ? [{ text: 'Remove from group', onClick: () => removeFromGroup(group, pinId, isSettled(w)) }] : []),
      ...(placement === 'loose' ? [{ text: 'Remove from Working on', onClick: () => loose.remove(pinId) }] : []),
      { text: 'Delete worktree', danger: true, onClick: () => onDeleteWorktree(w) },
    ];
    const { title, subtitle } = cardLines(w, repoName);
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
  // A worktree pinned and grouped before loose rows existed would show twice; its group wins.
  const heldByOpenGroup = new Set(focus.groups.filter((g) => !doneOf(g)).flatMap((g) => g.members));
  const looseRows = loose.ids.filter((pinId) => !heldByOpenGroup.has(pinId)).flatMap((pinId) => {
    const local = localByPinId.get(pinId);
    if (local) return isSettled(local) ? [] : [localRow(local, repos.find((r) => r.id === local.repoId)?.name ?? '', 'loose')];
    const remote = remoteByPinId.get(pinId);
    if (!remote) return [];
    return [(
      <RemoteRow key={`loose:${pinId}`} w={remote} repoName={repos.find((r) => r.id === remote.localRepoId)?.name ?? remote.remoteRepoName ?? ''}
        reachable={runnerOnline(remote.runnerId)} activeRow={remote.path === activeWorktreePath} placement="loose"
        groupItems={[...groupMenuItems(pinId), { text: 'Remove from Working on', onClick: () => loose.remove(pinId) }]}
        onContextMenu={openContextMenu} onOpenRemoteWorktree={onOpenRemoteWorktree} onDeleteRemoteWorktree={onDeleteRemoteWorktree} />
    )];
  });

  // Shared by Working on (open groups) and Settled (finished ones).
  const groupListProps = {
    activeGroupId: activeGroup?.id ?? null,
    isDone: doneOf,
    membersOf: (g: FocusGroup) => resolveMembers(g, worktrees, remoteWorktrees),
    collapsedIds: focusPrefs.collapsedGroupIds,
    onToggleCollapsed: focusPrefs.toggleGroupCollapsed,
    onRename: (id: string, name: string) => { focus.rename(id, name).catch(report); },
    onDelete: (id: string) => {
      focus.remove(id)
        .then(() => { if (focusPrefs.activeFocusGroupId === id) focusPrefs.setActiveFocusGroupId(null); })
        .catch(report);
    },
    renderMenu: (label: string, items: MenuItem[]) => <Menu alwaysVisible label={label} items={items} />,
    renderMember: (e: SidebarEntry, g: FocusGroup) => {
      const repoName = repos.find((r) => r.id === e.repoId)?.name ?? '';
      if (e.kind === 'local') return localRow(e.w, repoName, 'focus', g);
      return (
        <RemoteRow
          key={`focus:${e.pinId}`}
          w={e.w}
          repoName={repoName || e.w.remoteRepoName || ''}
          reachable={runnerOnline(e.w.runnerId)}
          activeRow={e.w.path === activeWorktreePath}
          placement="focus"
          groupItems={[...groupMenuItems(e.pinId), { text: 'Remove from group', onClick: () => removeFromGroup(g, e.pinId) }]}
          onContextMenu={openContextMenu}
          onOpenRemoteWorktree={(w) => { focusPrefs.setActiveFocusGroupId(g.id); onOpenRemoteWorktree?.(w); }}
          onDeleteRemoteWorktree={onDeleteRemoteWorktree}
        />
      );
    },
  };
  const openGroups = focus.groups.filter((g) => !doneOf(g));
  const workingGroups = openGroups.filter((g) => groupState(g) === 'working');
  const parkedCount = openGroups.length - workingGroups.length;
  const park = (id: string) => {
    focus.setState(id, 'parked')
      .then(() => { if (focusPrefs.activeFocusGroupId === id) focusPrefs.setActiveFocusGroupId(null); })
      .catch(report);
  };
  const settledWorktreeRows = worktrees.filter(isSettled).map((w) =>
    localRow(w, repos.find((r) => r.id === w.repoId)?.name ?? '', 'settled'));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarToolbar onSearch={onSearch} onAddRepo={onAddRepo}
        onNewGroup={() => setNewGroupWith([])} onNewWorktree={onNewWorktree} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onContextMenu={openBlankContextMenu}>
        <section aria-label="Working on">
          <div className="mb-1 mt-3 flex items-center pl-2.5 pr-1">
            <span className="text-xs text-zinc-500">Working on</span>
            {parkedCount > 0 && (
              // Parked groups have no rows; the count says they exist and ⌘K finds them.
              <button type="button" onClick={onShowParked} title="Parked groups — open one from search"
                className="ml-auto rounded px-1 font-mono text-[11px] tabular-nums text-zinc-600 hover:text-zinc-300">
                {parkedCount} more
              </button>
            )}
          </div>
          {looseRows.length === 0 && workingGroups.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-zinc-600">Nothing yet. Search to open a worktree, or ✎ to start one.</p>
          ) : (
            <>
              {looseRows.length > 0 && <div className="mb-1 flex flex-col gap-0.5">{looseRows}</div>}
              {workingGroups.length > 0 && <GroupList {...groupListProps} groups={workingGroups} onPark={park} />}
            </>
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

      <SettledSection {...groupListProps} groups={focus.groups.filter(doneOf)} worktreeRows={settledWorktreeRows} />

      {newGroupWith && (
        <NewGroupDialog
          initialMembers={newGroupWith}
          candidates={[
            ...worktrees.map((w) => ({
              pinId: localPinId(w), label: worktreeLabel(w),
              repoName: repos.find((r) => r.id === w.repoId)?.name ?? '',
            })),
            ...remoteWorktrees.map((w) => ({
              pinId: remotePinId(w), label: w.branch ?? w.name,
              repoName: `${repos.find((r) => r.id === w.localRepoId)?.name ?? w.remoteRepoName ?? ''} · ${w.runnerName}`,
            })),
          ]}
          onCancel={() => setNewGroupWith(null)}
          onCreate={(name, members) => {
            setNewGroupWith(null);
            focus.create(name, members).then((g) => {
              // A worktree in a group is no longer loose; only once the group exists.
              members.forEach(loose.remove);
              focusPrefs.setActiveFocusGroupId(g.id);
            }).catch(report);
          }}
        />
      )}

      {contextMenu && (
        <MenuPopover pos={contextMenu} items={contextMenu.items} anchor="left" onClose={() => setContextMenu(null)} />
      )}

      {pickerFor && (
        <GroupPickerDialog
          groups={focus.groups.filter((g) => !doneOf(g))}
          memberId={pickerFor}
          onClose={() => setPickerFor(null)}
          onToggle={(id, add) => {
            const member = pickerFor;
            // A worktree in a group is no longer loose.
            const g = focus.groups.find((x) => x.id === id);
            // Adding to a parked group means you are working on it again, once the add has saved.
            const promote = add && g && groupState(g) === 'parked';
            focus.setMembership(id, member, add)
              .then(() => {
                if (!add) return;
                // A worktree in a group is no longer loose.
                loose.remove(member);
                if (promote) return focus.setState(id, 'working');
              })
              .catch(report);
          }}
          onCreate={(name) => {
            // The dialog closes right after this, clearing pickerFor.
            const member = pickerFor;
            focus.create(name, [member]).then((g) => {
              loose.remove(member);
              focusPrefs.setActiveFocusGroupId(g.id);
            }).catch(report);
          }}
        />
      )}
    </div>
  );
}
