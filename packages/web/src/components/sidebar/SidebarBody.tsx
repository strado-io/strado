// One space's sidebar pane: every Focus as an accordion (FocusList), the
// active one open with its ✦ Jarvis card and worktree cards. Nothing else: a
// Focus is one task's set of worktrees, and everything else is a ⌘K or a
// Focus switch away.
import { useEffect, useRef, useState } from 'react';
import type { Focus, FocusTicket, RemoteWorktree, RunnerStatus } from '../../api';
import type { MergeRequest, RepoConfig, Worktree } from '../../types';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { sessionChips } from '../../hooks/sessions';
import { useBrowserTabs } from '../../hooks/browserTabs';
import { useCapabilities } from '../../hooks/capabilities';
import { openInEditor, useEditors } from '../../hooks/editors';
import type { AddRepoAnchor } from '../Sidebar';
import { cardLines, worktreeLabel } from './labels';
import { WorktreeCard } from './WorktreeCard';
import { SessionAvatarStack } from './sessionAvatars';
import { readWorktreeLru } from '../../lib/worktreeLru';
import { ticketRef, useTickets } from '../../hooks/tickets';
import { WorktreeRowItem, type OpenWorktree } from './WorktreeRowItem';
import { HoverActions, Menu, MenuPopover, MergeRequestBadge, agentWaiting, agentWorking, diffBadge, isRunning, type MenuItem } from './rowBits';
import { useFocuses } from '../../hooks/useFocuses';
import { NEW_FOCUS_EVENT } from '../../hooks/focusShortcut';
import { FocusIcon } from './FocusSwitcher';
import { FocusList, type FocusBadges, type FocusFilter, type FocusJarvisHeader } from './FocusList';
import { SidebarToolbar } from './SidebarToolbar';
import { PlusIcon } from '../hub/icons';
import { FocusComposer, type AgentMode } from '../focus/FocusComposer';
import { createJarvisServerPort } from '../../lib/jarvis/serverPort';
import { AddWorktreesDialog } from '../focus/AddWorktreesDialog';
export { BranchIcon, RepoIcon, type MenuItem } from './rowBits';
import { shortRelativeTime } from '../../lib/relativeTime';
import { localPinId, remotePinId } from './pinIds';

/** Waiting outranks working: it is the one that needs the person. */
const agentState = (w: Worktree) => (agentWaiting(w) ? 'waiting' : agentWorking(w) ? 'working' : null);

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
  /** New worktree with the repo still to pick (toolbar and blank-space menu); the empty Focus passes its ticket. */
  onNewWorktree: (ticket?: FocusTicket) => void;
  onWorktreeSettings: (w: Worktree) => void;
  /** Settings › Projects › the worktree's project (a repo id). */
  onProjectSettings?: (repoId: string) => void;
  onDeleteWorktree: (w: Worktree) => void;
  onOpenRemoteWorktree?: (w: RemoteWorktree, mode?: 'files') => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  onRebuildSandbox?: (w: RemoteWorktree) => void;
  /** True until the first runner-worktree fetch for this space settles. */
  remoteLoading?: boolean;
  /** Surfaces a failed change in the dashboard's error banner. */
  onError?: (message: string) => void;
  /** False for a neighbour space's pane in the carousel: it shows, but does not answer global events. */
  isActivePane?: boolean;
  /** The open Focus's Jarvis, for its header (Jarvis is the Focus: no card of its own). */
  jarvis?: FocusJarvisHeader;
  /** Each Focus's Jarvis badges for its collapsed row (approvals waiting, an unread reply). */
  jarvisBadges?: Map<string, { pendingApprovals: number; unread: boolean }>;
  /** A collapsed Focus was clicked: called before it is activated (the Dashboard opens its Jarvis chat). */
  onOpenFocus?: (id: string) => void;
};

/**
 * A worktree on a runner. Rendered in the same list as local ones because
 * that adjacency is the point — but always badged with the machine, because
 * where it runs decides what it can see.
 */
function RemoteRow({ w, repoName, reachable, activeRow, onRemove, removeLabel = 'Remove from focus', onOpenRemoteWorktree, onDeleteRemoteWorktree, onRebuildSandbox, onContextMenu }: {
w: RemoteWorktree;
/** The repo it belongs to, for the card's first line. */
repoName?: string;
reachable: boolean;
activeRow: boolean;
/** Takes the row out of the Focus; the worktree itself is untouched. */
onRemove?: () => void;
removeLabel?: string;
onOpenRemoteWorktree?: (w: RemoteWorktree, mode?: 'files') => void;
onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
/** Retry a failed sandbox build; offered only when the row runs unsandboxed on a sandboxing runner. */
onRebuildSandbox?: (w: RemoteWorktree) => void;
/** Right-click: the row's menu at the cursor. */
onContextMenu?: (e: React.MouseEvent, items: MenuItem[]) => void;
}) {
  const chips = sessionChips([w as unknown as Worktree]);
  // A worktree appears once, so a loose row keeps the plain id; a member is prefixed.
  const testIdSuffix = `${w.runnerId}:${w.path}`;
  const label = w.branch ?? w.name;
  // The one state worth flagging: this runner isolates worktrees, this one
  // isn't — its agents run straight on the box. Silent fallback was the bug.
  const unsandboxed = w.sandbox === 'fallback';
  const menuItems: MenuItem[] = [
    ...(onRemove ? [{ text: removeLabel, onClick: onRemove }] : []),
    ...(unsandboxed && onRebuildSandbox ? [{ text: 'Rebuild sandbox', onClick: () => onRebuildSandbox(w) }] : []),
    ...(!w.isRepoRoot && onDeleteRemoteWorktree
      ? [{ text: 'Delete worktree', danger: true, onClick: () => onDeleteRemoteWorktree(w) }]
      : []),
  ];
  // The hover card's Files button is the one tab a runner row opens by name.
  const open = (_w?: Worktree, mode?: string) => (mode === 'files' ? onOpenRemoteWorktree?.(w, 'files') : onOpenRemoteWorktree?.(w));
  return (
    <WorktreeRowItem
      worktree={w as unknown as Worktree}
      chips={chips}
      mr={null}
      runnerName={w.runnerName}
      onOpen={open}
      onContextMenu={onContextMenu && menuItems.length > 0 ? (e) => onContextMenu(e, menuItems) : undefined}
      active={activeRow}
      waiting={agentWaiting(w as unknown as Worktree)}
      className="group relative flex items-stretch"
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
        agents={<SessionAvatarStack chips={chips} testId={`card-sessions-${testIdSuffix}`} tinted />}
        agentState={agentState(w as unknown as Worktree)}
        meta={(
          <>
            {unsandboxed && (
              <span
                data-testid={`no-sandbox-${testIdSuffix}`}
                title="Sandbox build failed — agents in this worktree run directly on the runner. Rebuild sandbox from the row menu."
                className="shrink-0 rounded bg-amber-500/15 px-1 text-[11px] font-medium text-amber-300"
              >
                no sandbox
              </span>
            )}
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
  onOpenMr, onOpenDiff, onNewWorktree, onWorktreeSettings, onProjectSettings, onDeleteWorktree,
  onOpenRemoteWorktree, onDeleteRemoteWorktree, onRebuildSandbox,
  remoteLoading = false, onError, isActivePane = true, jarvis, jarvisBadges, onOpenFocus,
}: SidebarBodyProps) {
  const mrByPath = useMrSummaries(wsId, worktrees.map((w) => w.path));
  const { focuses, active, activeId, activate, create, rename, remove, setMembership, addMembers } = useFocuses(wsId);
  const report = (what: string) => (err: unknown) => onError?.(`${what}: ${(err as Error).message}`);
  // The composer (New focus, from the list's +, the empty state, the
  // blank-space menu, ⇧⌘N and the hub gate, which seeds it with the worktree
  // being opened) and Add worktrees.
  const [composer, setComposer] = useState<{ seedPinId: string | null } | null>(null);
  const [addingMembers, setAddingMembers] = useState(false);
  const openComposer = (seedPinId: string | null = null) => { setComposer({ seedPinId }); };
  // The composer's agent: started with the task as its first prompt (as Jarvis
  // does), then its tab opened — a new worktree may take a moment to be listed.
  const worktreesRef = useRef(worktrees);
  worktreesRef.current = worktrees;
  const startAgent = (worktreePath: string, mode: AgentMode, prompt: string) => {
    void createJarvisServerPort(wsId).spawn({ mode, worktreePath, ...(prompt ? { prompt } : {}) })
      .then(async ({ tab }) => {
        for (let i = 0; i < 20; i++) {
          const w = worktreesRef.current.find((x) => x.path === worktreePath);
          if (w) { onOpenWorktree(w, mode, tab.sessionId); return; }
          await new Promise((r) => setTimeout(r, 250));
        }
      })
      .catch(report(`Could not start ${mode}`));
  };
  // Only the active pane answers the event: the carousel's neighbour panes
  // would each open one too.
  useEffect(() => {
    if (!isActivePane) return;
    const onNew = (e: Event) => openComposer((e as CustomEvent<{ seedPinId?: string }>).detail?.seedPinId ?? null);
    window.addEventListener(NEW_FOCUS_EVENT, onNew);
    return () => window.removeEventListener(NEW_FOCUS_EVENT, onNew);
  }, [isActivePane]);
  // Right-click on a worktree row: its ⋯ menu, at the cursor.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const openContextMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation(); // a row's menu, not the blank-space one below
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };
  // Last-opened times for the cards; the same map ⌘K ranks by.
  const lru = readWorktreeLru();
  // Ticket summaries the Dashboard polls for every row: a card with no name of its own borrows its ticket's.
  const tickets = useTickets();
  const browserTabs = useBrowserTabs();
  const runnerOnline = (runnerId: string) =>
    runnerStatuses.find((r) => r.runnerId === runnerId)?.online ?? false;
  const removeFromFocus = (f: Focus, pinId: string) => {
    void setMembership(f.id, pinId, false).catch(report('Could not remove from focus'));
  };
  // A card in a Focus that is not the active one: that Focus becomes active
  // first, then the card opens in it. The open waits a tick, until the
  // Dashboard has restored the newly active Focus's view, or that restore
  // would replace it.
  const inFocus = <A extends unknown[]>(f: Focus, open: (...args: A) => void) => (...args: A) => {
    if (f.id === activeId) { open(...args); return; }
    activate(f.id);
    setTimeout(() => open(...args), 0);
  };

  // "Open in <editor>": a local worktree, in the person's own editor. A UI a
  // runner box serves has no desktop editor; runner worktrees never get one.
  const { chosen: editor } = useEditors();
  const caps = useCapabilities();
  const openWorktreeInEditor = editor && !caps.runner
    ? (w: Worktree) => {
        openInEditor(wsId, { worktreePath: w.path, editor: editor.id }).catch((err: unknown) => onError?.((err as Error).message));
      }
    : undefined;

  const localRow = (f: Focus, w: Worktree, repoName: string) => {
    const open: OpenWorktree = inFocus(f, onOpenWorktree);
    const activeRow = w.path === activeWorktreePath;
    const chips = sessionChips([w], browserTabs);
    const mr = mrByPath.get(w.path);
    const testIdSuffix = w.path;
    const pinId = localPinId(w);
    const menuItems: MenuItem[] = [
      { text: 'Settings', onClick: () => onWorktreeSettings(w) },
      ...(onProjectSettings && w.repoId ? [{ text: 'Project settings', onClick: () => onProjectSettings(w.repoId!) }] : []),
      { text: `Remove from ${f.name}`, onClick: () => removeFromFocus(f, pinId) },
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
        onOpenInEditor={openWorktreeInEditor}
        editorLabel={editor?.label}
        onContextMenu={(e) => openContextMenu(e, menuItems)}
        active={activeRow}
        waiting={agentWaiting(w)}
        className="group relative flex items-stretch"
      >
        <WorktreeCard
          repo={repo ? { id: repo.id, name: repo.name } : null}
          title={title}
          subtitle={subtitle}
          time={shortRelativeTime(lru[w.path])}
          active={activeRow}
          onOpen={() => open(w)}
          label={worktreeLabel(w)}
          agents={<SessionAvatarStack chips={chips} testId={`card-sessions-${testIdSuffix}`} tinted />}
          agentState={agentState(w)}
          meta={(
            <>
              {mr && <MergeRequestBadge worktree={w} mr={mr} onOpen={onOpenMr} testIdSuffix={testIdSuffix} showNumber />}
              {diffBadge(w, testIdSuffix)}
              {isRunning(w) && (
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" title="running">
                  <span
                    data-testid={`run-dot-${testIdSuffix}`}
                    role="img"
                    aria-label="running"
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
  // The toolbar's search: a Focus shows if its name matches, or any of its
  // worktrees' (then it is expanded, with only the ones that match).
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const hit = (...names: Array<string | null | undefined>) => names.some((n) => !!n && n.toLowerCase().includes(q));
  const memberHit = (pinId: string) => {
    const local = localByPinId.get(pinId);
    if (local) return hit(worktreeLabel(local), local.branch);
    const remote = remoteByPinId.get(pinId);
    return !!remote && hit(remote.branch, remote.name);
  };
  const filter: FocusFilter | null = q ? (() => {
    const ids = new Set<string>();
    const expand = new Set<string>();
    for (const f of focuses) {
      if (f.members.some(memberHit)) { ids.add(f.id); expand.add(f.id); } else if (hit(f.name)) ids.add(f.id);
    }
    return { ids, expand };
  })() : null;
  const membersShown = (f: Focus) => (q && !hit(f.name) ? f.members.filter(memberHit) : f.members);
  const rowsOf = (f: Focus) => membersShown(f).flatMap((pinId) => {
    const local = localByPinId.get(pinId);
    if (local) return [localRow(f, local, repos.find((r) => r.id === local.repoId)?.name ?? '')];
    const remote = remoteByPinId.get(pinId);
    if (!remote) return [];
    return [(
      <RemoteRow key={pinId} w={remote} repoName={repos.find((r) => r.id === remote.localRepoId)?.name ?? remote.remoteRepoName ?? ''}
        reachable={runnerOnline(remote.runnerId)} activeRow={remote.path === activeWorktreePath}
        onRemove={() => removeFromFocus(f, pinId)} removeLabel={`Remove from ${f.name}`}
        onContextMenu={openContextMenu} onOpenRemoteWorktree={onOpenRemoteWorktree && inFocus(f, onOpenRemoteWorktree)} onDeleteRemoteWorktree={onDeleteRemoteWorktree} onRebuildSandbox={onRebuildSandbox} />
    )];
  });

  // A Focus's row: only its Jarvis's own badges. Agent faces belong to the
  // worktree cards, not the Focus.
  const badges = new Map<string, FocusBadges>(focuses.map((f) => {
    const j = jarvisBadges?.get(f.id);
    return [f.id, {
      pendingApprovals: j?.pendingApprovals ?? 0,
      unread: j?.unread ?? false,
    }];
  }));
  const deleteActive = () => {
    if (!active) return;
    const n = active.members.length;
    if (n === 0 || confirm(`Delete "${active.name}"? Its ${n} worktree${n === 1 ? '' : 's'} stay where they are.`)) void remove(active.id).catch(report('Could not delete focus'));
  };
  const activeMenu: MenuItem[] = active ? [
    { text: 'Add worktrees…', onClick: () => setAddingMembers(true) },
    { text: 'New worktree here…', onClick: () => onNewWorktree(active.ticket) },
    { text: 'Delete focus', danger: true, onClick: deleteActive },
  ] : [];

  // The empty states' actions: full-width rows, drawn like a place a card will go.
  const emptyAction = 'flex w-full items-center gap-2.5 rounded-lg border border-dashed border-zinc-800 px-3 py-2.5 text-left text-xs text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200';
  const PenIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
    </svg>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarToolbar query={query} onQuery={setQuery} onAddProject={onAddRepo} onNew={() => openComposer()} shortcut={isActivePane} />
      {/* No menu on blank space: the Focus's ⋯ has New worktree and Add worktrees. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onContextMenu={(e) => e.preventDefault()}>
        <FocusList focuses={focuses} activeId={active?.id ?? null} badges={badges} activeMenu={activeMenu}
          onOpen={(id) => { onOpenFocus?.(id); activate(id); }}
          onRename={(id, name) => void rename(id, name).catch(report('Could not rename focus'))}
          jarvis={jarvis} filter={filter}>
          {(f) => {
            const rows = rowsOf(f);
            return (
              <section aria-label={f.id === activeId ? 'Focus' : f.name}>
                {rows.length === 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <button type="button" onClick={() => { if (f.id !== activeId) activate(f.id); setAddingMembers(true); }} className={emptyAction}>
                      <span className="text-zinc-500"><PlusIcon size={14} /></span>Add worktrees
                    </button>
                    <button type="button" onClick={() => { if (f.id !== activeId) activate(f.id); onNewWorktree(f.ticket); }} className={emptyAction}>
                      <span className="text-zinc-500"><PenIcon /></span>New worktree here
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">{rows}</div>
                )}
              </section>
            );
          }}
        </FocusList>
        {/* No active Focus: as before, below the list. */}
        {!active && (
          <div className="mt-2 px-1 py-1">
            <button type="button" onClick={() => openComposer()} className={emptyAction}>
              <span className="text-zinc-500"><FocusIcon size={14} /></span>New focus
            </button>
          </div>
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
      </div>

      {composer && (
        <FocusComposer workspaceId={wsId} repos={repos} worktrees={worktrees} remoteWorktrees={remoteWorktrees} seedPinId={composer.seedPinId}
          onCreate={(name, members, ticket) => create(name, members, ticket).catch(report('Could not create focus'))}
          onStartAgent={startAgent}
          onClose={() => setComposer(null)} />
      )}
      {addingMembers && active && (
        <AddWorktreesDialog focus={active} repos={repos} worktrees={worktrees} remoteWorktrees={remoteWorktrees}
          onAdd={(ids) => void addMembers(active.id, ids).catch(report(`Could not add to ${active.name}`))}
          onClose={() => setAddingMembers(false)} />
      )}

      {contextMenu && (
        <MenuPopover pos={contextMenu} items={contextMenu.items} anchor="left" onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
