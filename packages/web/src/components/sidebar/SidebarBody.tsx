import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FocusGroup, RemoteWorktree, RunnerStatus } from '../../api';
import type { MergeRequest, RepoConfig, Worktree } from '../../types';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { chipStatus, sessionChips } from '../../hooks/sessions';
import { useVscodeTabs } from '../../hooks/vscodeTabs';
import { useBrowserTabs } from '../../hooks/browserTabs';
import type { AddRepoAnchor } from '../Sidebar';
import { PlusIcon } from '../hub/icons';
import { SESSION_COLOR, SessionAvatarIcon, SessionAvatarStack } from './sessionAvatars';
import { MR_STATE_COLOR, PIPELINE_DETAIL, PrStateIcon, prKind } from './prVisuals';
import { worktreeLabel, worktreeTitle } from './labels';
import { WorktreeRowItem, useRowHoverCardDismiss, type OpenWorktree } from './WorktreeRowItem';
import { useFocusGroups } from '../../hooks/useFocusGroups';
import { useFocusPrefs } from '../../hooks/focusPrefs';
import { GroupsView } from './GroupsView';
import { SettledSection } from './SettledSection';
import { relativeTime } from '../../lib/relativeTime';
import { GroupPickerDialog } from './GroupPickerDialog';
import { NewGroupDialog } from './NewGroupDialog';
import { activeGroupOf, isGroupDone, resolveMembers } from './focusGroups';
import { localPinId, remotePinId, type SidebarEntry } from './pinIds';

export type SidebarBodyProps = {
  wsId: string;
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  runnerStatuses: RunnerStatus[];
  onAddRepo: (anchor?: AddRepoAnchor) => void;
  onDeleteRepo: (repo: RepoConfig) => void;
  expandedRepos: Set<string>;
  onToggleRepo: (repoId: string) => void;
  onOpenWorktree: OpenWorktree;
  /** Opens the diff & commit modal for a worktree (hover-card quick action). */
  onOpenDiff?: (w: Worktree) => void;
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  activeWorktreePath: string | null;
  onNewWorktreeForRepo: (repo: RepoConfig) => void;
  /** New worktree with the repo still to pick. */
  onNewWorktree?: () => void;
  onWorktreeSettings: (w: Worktree) => void;
  onDeleteWorktree: (w: Worktree) => void;
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  /** True until the first runner-worktree fetch for this space settles. */
  remoteLoading?: boolean;
  /** Stable local/runner worktree ids pinned in this workspace, in pin order. */
  pinnedWorktreeIds: string[];
  onTogglePinnedWorktree: (pinId: string) => void;
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

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

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

function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden {...stroke} fill={filled ? 'currentColor' : 'none'}>
      <path d="M5.25 2.25h5.5l-.9 3.35 1.9 2.15v1H4.25v-1l1.9-2.15-.9-3.35Z" />
      <path d="M8 8.75v5" />
    </svg>
  );
}

function PinButton({ label, pinned, onToggle }: {
  label: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${label}`}
      title={pinned ? 'Unpin worktree' : 'Pin worktree'}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={`pointer-events-none inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded p-[3px] opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 ${
        pinned ? 'text-sky-400 hover:bg-zinc-800 hover:text-sky-300' : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200'
      }`}
    >
      <PinIcon filled={pinned} />
    </button>
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
type MenuItem = { text: string; danger?: boolean; onClick: () => void };

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
function RemoteRow({ w, repoName, reachable, activeRow, pinned, placement, groupItems = [], onTogglePinned, onOpenRemoteWorktree, onDeleteRemoteWorktree, onContextMenu }: {
w: RemoteWorktree;
/** Shown as a chip in the Focus section, where rows from many repos sit together. */
repoName?: string;
reachable: boolean;
activeRow: boolean;
pinned: boolean;
placement: 'repo' | 'pinned' | 'focus';
groupItems?: { text: string; onClick: () => void }[];
onTogglePinned: () => void;
onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
/** Right-click: the row's menu at the cursor. */
onContextMenu?: (e: React.MouseEvent, items: MenuItem[]) => void;
}) {
  const chips = sessionChips([w as unknown as Worktree]);
  const hasSessions = chips.length > 0;
  const testIdSuffix = placement === 'repo' ? `${w.runnerId}:${w.path}` : `${placement}-${w.runnerId}:${w.path}`;
  const menuItems: MenuItem[] = [
    ...groupItems,
    ...(!w.isRepoRoot && onDeleteRemoteWorktree
      ? [{ text: 'Delete worktree', danger: true, onClick: () => onDeleteRemoteWorktree(w) }]
      : []),
  ];
  return (
    <WorktreeRowItem
      worktree={w as unknown as Worktree}
      chips={chips}
      mr={null}
      runnerName={w.runnerName}
      onOpen={() => onOpenRemoteWorktree?.(w)}
      onContextMenu={menuItems.length > 0 && onContextMenu ? (e) => onContextMenu(e, menuItems) : undefined}
      className={`group relative flex items-center rounded-md pr-1 ${activeRow ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`}
    >
      {hasSessions && (
        <span
          aria-hidden
          data-testid={`session-mark-${testIdSuffix}`}
          className="absolute bottom-1.5 left-1 top-1.5 w-px rounded-full bg-sky-500"
        />
      )}
      <span className={`${placement === 'repo' || placement === 'focus' ? 'ml-8' : 'ml-2.5'} flex h-3.5 w-3.5 shrink-0 items-center justify-center`}>
        <BranchIcon className={activeRow ? 'text-sky-400' : reachable ? 'text-zinc-600' : 'text-zinc-700'} />
      </span>
      <button
        onClick={() => onOpenRemoteWorktree?.(w)}
        title={`${w.path} on ${w.runnerName}${reachable ? '' : ' (offline — the worktree is safe there)'}`}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left ${
          activeRow ? 'text-zinc-100' : reachable ? 'text-zinc-300' : 'text-zinc-600'
        }`}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {w.branch ?? w.name}
        </span>
      </button>
      <span className="mr-1 flex shrink-0 items-center gap-1.5">
        {placement === 'focus' && repoName && (
          <span className="max-w-[6rem] truncate text-[10px] text-zinc-600">{repoName}</span>
        )}
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
      </span>
      <HoverActions active={activeRow}>
        <PinButton
          label={`${w.branch ?? w.name} on ${w.runnerName}${placement === 'pinned' ? ' from pinned' : ''}`}
          pinned={pinned}
          onToggle={onTogglePinned}
        />
        {/* A repo's main working tree is not removable as a worktree — the
            delete route refuses it — so its menu holds only the group items. */}
        {(!w.isRepoRoot && onDeleteRemoteWorktree) || groupItems.length > 0 ? (
          <Menu
            label={`${w.branch ?? w.name} on ${w.runnerName}${placement === 'pinned' ? ' pinned' : ''} actions`}
            items={menuItems}
          />
        ) : null}
      </HoverActions>
    </WorktreeRowItem>
  );
}

export function SidebarBody({
  wsId, repos, worktrees, remoteWorktrees, runnerStatuses,
  onAddRepo, onDeleteRepo, expandedRepos, onToggleRepo, onOpenWorktree, activeWorktreePath,
  onOpenMr, onOpenDiff, onNewWorktreeForRepo, onNewWorktree, onWorktreeSettings, onDeleteWorktree,
  onOpenRemoteWorktree, onDeleteRemoteWorktree,
  remoteLoading = false, pinnedWorktreeIds, onTogglePinnedWorktree, onError,
}: SidebarBodyProps) {
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));
  const focus = useFocusGroups(wsId);
  const focusPrefs = useFocusPrefs(wsId);
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
  // Fold every repo and every group, e.g. to get back to a short list.
  const collapseAll = () => {
    for (const id of expandedRepos) onToggleRepo(id);
    for (const g of focus.groups) if (!focusPrefs.collapsedGroupIds.includes(g.id)) focusPrefs.toggleGroupCollapsed(g.id);
  };
  // Right-click on blank sidebar space: what you can make from here, and tidying up.
  const openBlankContextMenu = (e: React.MouseEvent) => openContextMenu(e, [
    ...(onNewWorktree ? [{ text: 'New worktree…', onClick: onNewWorktree }] : []),
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
  const vscodeTabs = useVscodeTabs();
  const browserTabs = useBrowserTabs();
  const runnerOnline = (runnerId: string) =>
    runnerStatuses.find((r) => r.runnerId === runnerId)?.online ?? false;
  const pinnedIds = new Set(pinnedWorktreeIds);

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
  const chevron = (open: boolean) => (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden {...stroke} className={`transition-transform ${open ? 'rotate-90' : ''}`}><path d="M6 4l4 4-4 4" /></svg>
  );

  // A row opened from the Groups view makes its group the active one, so
  // ⌥⌘←/→ cycles the group the user is working in.
  const localRow = (w: Worktree, repoName: string, placement: 'repo' | 'pinned' | 'focus' | 'settled', group?: FocusGroup) => {
    const open: OpenWorktree = (...args) => { if (group) focusPrefs.setActiveFocusGroupId(group.id); onOpenWorktree(...args); };
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w], vscodeTabs, browserTabs);
    const hasSessions = chips.length > 0;
    const mr = mrByPath.get(w.path);
    const pinned = pinnedIds.has(localPinId(w));
    // A settled worktree shows only in Settled, so it keeps the plain id like a repo row.
    const testIdSuffix = placement === 'repo' || placement === 'settled' ? w.path : `${placement}-${w.path}`;
    const menuItems: MenuItem[] = [
      { text: 'Settings', onClick: () => onWorktreeSettings(w) },
      ...groupMenuItems(localPinId(w)),
      { text: 'Delete worktree', danger: true, onClick: () => onDeleteWorktree(w) },
    ];
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
        className={`group relative flex items-center rounded-md pr-1 ${
          activeRow ? 'bg-zinc-800/80' : 'hover:bg-zinc-900'}`}
      >
        {hasSessions && (
          <span
            aria-hidden
            data-testid={`session-mark-${testIdSuffix}`}
            className="absolute bottom-1.5 left-1 top-1.5 w-px rounded-full bg-sky-500"
          />
        )}
        <span className={`${placement === 'repo' || placement === 'focus' ? 'ml-8' : 'ml-2.5'} flex h-3.5 w-3.5 shrink-0 items-center justify-center`}>
          {mr ? (
            <MergeRequestBadge worktree={w} mr={mr} onOpen={onOpenMr} testIdSuffix={testIdSuffix} />
          ) : agentWorking(w) ? (
            <BrailleSpinner small />
          ) : (
            <BranchIcon className={activeRow ? 'text-sky-400' : 'text-zinc-600'} />
          )}
        </span>
        <button onClick={() => open(w)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left ${activeRow ? 'text-zinc-100' : 'text-zinc-300'}`}>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {worktreeLabel(w)}
            {worktreeTitle(w, repoName) && (
              // mono spaces around the · are full-width — use margins instead
              <span className={activeRow ? 'text-zinc-400' : 'text-zinc-600'}><span className="mx-[3px]">·</span>{worktreeTitle(w, repoName)}</span>
            )}
          </span>
        </button>
        <span className="mr-1 flex shrink-0 items-center gap-1.5">
          {(placement === 'focus' || placement === 'settled') && repoName && (
            <span className="max-w-[6rem] truncate text-[10px] text-zinc-600">{repoName}</span>
          )}
          {placement === 'settled' && mr && (
            <span title={`PR ${mr.state}`} className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-600">
              {relativeTime(mr.mergedAt ?? mr.updatedAt).replace(/ ago$/, '')}
            </span>
          )}
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
        </span>
        <HoverActions active={activeRow}>
          <PinButton
            label={placement === 'pinned' ? `${worktreeLabel(w)} from pinned` : worktreeLabel(w)}
            pinned={pinned}
            onToggle={() => onTogglePinnedWorktree(localPinId(w))}
          />
          <Menu label={`${worktreeLabel(w)}${placement === 'pinned' ? ' pinned' : ''} actions`} items={menuItems} />
        </HoverActions>
      </WorktreeRowItem>
    );
  };

  const localByPinId = new Map(worktrees.map((w) => [localPinId(w), w]));
  const remoteByPinId = new Map(remoteWorktrees.map((w) => [remotePinId(w), w]));
  const pinnedRows = pinnedWorktreeIds.flatMap((pinId) => {
    const local = localByPinId.get(pinId);
    if (local) {
      const repoName = repos.find((repo) => repo.id === local.repoId)?.name ?? '';
      return [localRow(local, repoName, 'pinned')];
    }
    const remote = remoteByPinId.get(pinId);
    if (!remote) return [];
    return [(
      <RemoteRow
        key={`pinned:${pinId}`}
        w={remote}
        reachable={runnerOnline(remote.runnerId)}
        activeRow={remote.path === activeWorktreePath}
        pinned
        placement="pinned"
        groupItems={groupMenuItems(pinId)}
        onContextMenu={openContextMenu}
        onTogglePinned={() => onTogglePinnedWorktree(pinId)}
        onOpenRemoteWorktree={onOpenRemoteWorktree}
        onDeleteRemoteWorktree={onDeleteRemoteWorktree}
      />
    )];
  });

  // Shared by the Groups section (open groups) and Settled (finished ones).
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
          pinned={pinnedIds.has(e.pinId)}
          placement="focus"
          groupItems={groupMenuItems(e.pinId)}
          onContextMenu={openContextMenu}
          onTogglePinned={() => onTogglePinnedWorktree(e.pinId)}
          onOpenRemoteWorktree={(w) => { focusPrefs.setActiveFocusGroupId(g.id); onOpenRemoteWorktree?.(w); }}
          onDeleteRemoteWorktree={onDeleteRemoteWorktree}
        />
      );
    },
  };
  // A worktree whose PR is merged or closed has settled: it leaves its repo in
  // the tree for the Settled section at the bottom. A repo's own checkout
  // (master/main) never settles, whatever PR its branch once had.
  const repoRoots = new Set(repos.map((r) => r.path));
  const isSettled = (w: Worktree) => {
    const state = mrByPath.get(w.path)?.state;
    return (state === 'merged' || state === 'closed') && !repoRoots.has(w.path);
  };
  const settledWorktreeRows = worktrees.filter(isSettled).map((w) =>
    localRow(w, repos.find((r) => r.id === w.repoId)?.name ?? '', 'settled'));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onContextMenu={openBlankContextMenu}>
      {/* Pinned first: the few worktrees kept within reach. */}
      {pinnedRows.length > 0 && (
        <section aria-label="Pinned worktrees">
          <div className="mb-1 mt-4 flex items-center pl-2.5 pr-1">
            <span className="text-xs text-zinc-500">Pinned</span>
          </div>
          <div className="flex flex-col gap-0.5">{pinnedRows}</div>
        </section>
      )}

      {/* Then the groups: cross-repo bundles for the tasks at hand. */}
      <GroupsView
        {...groupListProps}
        groups={focus.groups}
        onNewGroup={() => setNewGroupWith([])}
      />

      <div className="mb-1 mt-4 flex items-center justify-between pl-2.5 pr-1">
        <span className="text-xs text-zinc-500">Repos</span>
        <button
          onClick={(event) => {
            const { left, right, bottom } = event.currentTarget.getBoundingClientRect();
            onAddRepo({ left, right, bottom });
          }}
          aria-label="Add repo"
          title="Add repo"
          className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300"
        >
          <PlusIcon size={12} />
        </button>
      </div>

      <div className="flex flex-col gap-0.5">
        {repos.map((repo) => {
          const repoWts = worktrees.filter((w) => w.repoId === repo.id && !isSettled(w));
          const repoRemote = remoteWorktrees.filter((w) => w.localRepoId === repo.id);
          const open = expandedRepos.has(repo.id);
          return (
            <div key={repo.id}>
              <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-zinc-900">
                <button onClick={() => onToggleRepo(repo.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-300">
                  {/* avatar by default; the expand chevron takes the slot on
                      row hover. Agent-working shows on the specific worktree
                      row and the session tab, not rolled up to the repo. */}
                  <span className="relative h-5 w-5 shrink-0">
                    <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0">
                      <RepoIcon />
                    </span>
                    <span className="absolute inset-0 flex items-center justify-center text-zinc-400 opacity-0 group-hover:opacity-100">
                      {chevron(open)}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{repo.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`New worktree in ${repo.name}`}
                  title="New worktree"
                  onClick={(e) => { e.stopPropagation(); onNewWorktreeForRepo(repo); }}
                  className="inline-flex shrink-0 cursor-pointer rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <PlusIcon size={14} />
                </button>
                <Menu alwaysVisible label={`${repo.name} actions`} items={[
                  { text: 'New worktree', onClick: () => onNewWorktreeForRepo(repo) },
                  { text: 'Remove repo', danger: true, onClick: () => onDeleteRepo(repo) },
                ]} />
              </div>
              {open && (() => {
                return (
                // rows span the full sidebar width (the hover background has no
                // dead gap); the icon's indent nests them under the repo name
                <div className="flex flex-col gap-0.5">
                  {repoWts.length === 0 && repoRemote.length === 0 && (
                    <div className="py-1.5 pl-12 pr-2 text-xs text-zinc-600">No worktrees</div>
                  )}
                  {repoWts.map((w) => localRow(w, repo.name, 'repo'))}
                  {/* Runner worktrees for this repo, after the local ones. An
                      offline runner's rows stay VISIBLE and grey — vanishing
                      rows read as data loss, and the worktree is fine. */}
                  {repoRemote.map((w) => (
                    <RemoteRow
                      key={`${w.runnerId}:${w.path}`}
                      w={w}
                      reachable={runnerOnline(w.runnerId)}
                      activeRow={w.path === activeWorktreePath}
                      pinned={pinnedIds.has(remotePinId(w))}
                      placement="repo"
                      groupItems={groupMenuItems(remotePinId(w))}
                      onContextMenu={openContextMenu}
                      onTogglePinned={() => onTogglePinnedWorktree(remotePinId(w))}
                      onOpenRemoteWorktree={onOpenRemoteWorktree}
                      onDeleteRemoteWorktree={onDeleteRemoteWorktree}
                    />
                  ))}
                </div>
                );
              })()}
            </div>
          );
        })}
        {/* Runner worktrees we could not tie to a local repo IN ANY SPACE —
            the server already omits ones homed in another space. Rendered as
            repo folders in the same list (named for the remote repo), never a
            separate bottom bucket: rows that move around read as a glitch,
            but hiding work that exists reads as data loss. */}
        {(() => {
          const orphans = remoteWorktrees.filter((w) => !w.localRepoId);
          if (orphans.length === 0) return null;
          const groups = new Map<string, { name: string; rows: RemoteWorktree[] }>();
          for (const w of orphans) {
            const key = `${w.runnerId}:${w.remoteRepoId ?? w.remoteRepoName ?? 'unknown'}`;
            const g = groups.get(key) ?? { name: w.remoteRepoName ?? w.runnerName, rows: [] };
            g.rows.push(w);
            groups.set(key, g);
          }
          return [...groups.entries()].map(([key, g]) => (
            <div key={key}>
              <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-300">
                <RepoIcon />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{g.name}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-600">{g.rows.length}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {g.rows.map((w) => (
                  <RemoteRow
                    key={`${w.runnerId}:${w.path}`}
                    w={w}
                    reachable={runnerOnline(w.runnerId)}
                    activeRow={w.path === activeWorktreePath}
                    pinned={pinnedIds.has(remotePinId(w))}
                    placement="repo"
                    groupItems={groupMenuItems(remotePinId(w))}
                    onContextMenu={openContextMenu}
                    onTogglePinned={() => onTogglePinnedWorktree(remotePinId(w))}
                    onOpenRemoteWorktree={onOpenRemoteWorktree}
                    onDeleteRemoteWorktree={onDeleteRemoteWorktree}
                  />
                ))}
              </div>
            </div>
          ));
        })()}
        {/* First runner fetch still in flight: say so, quietly. Runner rows
            appearing a beat after the local ones otherwise looks like a bug. */}
        {remoteLoading && (
          <div className="flex items-center gap-2 rounded-md px-2 py-2 text-xs text-zinc-600">
            <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border border-zinc-800 border-t-zinc-500" />
            <span className="animate-pulse">Checking runners…</span>
          </div>
        )}
        {runnerStatuses
          .filter((r) => r.error)
          .map((r) => (
            <div key={r.runnerId} className="px-2 py-1.5 text-[11px] text-amber-600/80">
              {r.name}: {r.error}
            </div>
          ))}
      </div>
    </div>

    <SettledSection
      {...groupListProps}
      groups={focus.groups.filter(doneOf)}
      worktreeRows={settledWorktreeRows}
    />

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
            focus.create(name, members).then((g) => focusPrefs.setActiveFocusGroupId(g.id)).catch(report);
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
          onToggle={(id, add) => { focus.setMembership(id, pickerFor, add).catch(report); }}
          onCreate={(name) => {
            focus.create(name, [pickerFor]).then((g) => focusPrefs.setActiveFocusGroupId(g.id)).catch(report);
          }}
        />
      )}
    </div>
  );
}
