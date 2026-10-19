import { OpenSidebarButton } from '../components/SidebarToggle';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, type FocusTicket, type RemoteWorktree, type RunnerStatus, type TicketProviderId } from '../api';
import { subscribeWorktrees, worktreesReducer } from '../eventStream';
import { computeClaudeNotifications, snapshotStatuses, type ClaudeStatusMap } from '../hooks/claudeNotifications';
import { useIntercom } from '../contexts/IntercomContext';
import { UiControlProvider } from '../contexts/UiControlContext';
import { JarvisPaletteHost, JarvisToast, type JarvisRun } from '../components/jarvis/JarvisPaletteHost';
import type { CommandBarHandle } from '../components/CommandPalette';
import { Dock } from '../components/dock/Dock';
import { StationCard } from '../components/dock/StationCard';
import { HomeScreen } from '../components/home/HomeScreen';
import { recentWorktrees } from '../lib/home/recent';
import { lightOf } from '../lib/dock/stations';
import type { DevState } from '../components/dock/DevServerButton';
import { LineView } from '../components/dock/LineView';
import { useStations } from '../hooks/stations';
import { useFeed } from '../hooks/feed';
import { jarvisServerPort } from '../lib/jarvis/serverPort';
import type { StationDto } from '../api';
import type { TabRef as JarvisTabRef } from '../lib/jarvis/types';
import { escalationsByWorktree, nextSeenIds, openEscalations } from '../hooks/intercom';
import { playDoneBeep } from '../lib/beep';
import type { MergeRequest, RepoConfig, Worktree, WorkflowStatus } from '../types';
import { OnboardingCard } from '../components/OnboardingCard';
import { AddRepoDialog, type AddRepoAnchor } from '../components/AddRepoDialog';
import { Sidebar, type SidebarView } from '../components/Sidebar';
import type { UpdateFooterProps } from '../components/UpdateFooter';
import { publishTickets, providerLabel, useTickets } from '../hooks/tickets';
import { isRunning } from '../hooks/filters';
import { RunningServers } from '../components/RunningServers';
import { OnboardingWelcome } from '../components/OnboardingWelcome';
import { SettingsPage, type SettingsSection } from '../components/settings/SettingsPage';
import { setAppearance } from '../hooks/useAppearance';
import type { JarvisAppPort } from '../lib/jarvis/execute';
import { FeedbackDialog } from '../components/FeedbackDialog';
import { IntercomPanel } from '../components/IntercomPanel';
import { useWorkspace } from '../hooks/useWorkspace';
import { useSpaceShortcut } from '../hooks/spaceShortcut';
import { activeFocusOf, ensureFocusesLoaded, useFocuses } from '../hooks/useFocuses';
import { NEW_FOCUS_EVENT, useFocusShortcut } from '../hooks/focusShortcut';
import { localPinId, remotePinId } from '../components/sidebar/pinIds';
import { bumpWorktreeOpened, readWorktreeLru } from '../lib/worktreeLru';
import { rememberClosedAgent } from '../hooks/agentTabs';
import { track } from '../telemetry';
import { TerminalView } from './TerminalView';
import { CodeReviewsPage } from '../components/CodeReviewsPage';
import { RendererOverlayContext, useRendererOverlayRegistry } from '../contexts/RendererOverlay';
import { UsagePage } from '../components/usage/UsagePage';
import { WorktreesPage } from '../components/worktrees/WorktreesPage';
import { useCodeReviews } from '../hooks/codeReviews';

type State = {
  repos: RepoConfig[];
  worktrees: Worktree[];
  loading: boolean;
  error: string | null;
};

type Action =
  | { type: 'loaded'; repos: RepoConfig[]; worktrees: Worktree[] }
  // Workspace switch: paint the cached snapshot for the new workspace at once
  // (loading:false), or fall back to the loading state when it's never been
  // visited. A background revalidation always follows and dispatches 'loaded'.
  | { type: 'switch'; snap: TreeSnap | null }
  | { type: 'event'; data: Parameters<typeof worktreesReducer>[1] }
  | { type: 'patchMeta'; path: string; patch: Partial<NonNullable<Worktree['meta']>> }
  | { type: 'error'; message: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded':
      return { ...state, repos: action.repos, worktrees: action.worktrees, loading: false };
    case 'switch':
      return action.snap
        ? { repos: action.snap.repos, worktrees: action.snap.worktrees, loading: false, error: null }
        : { repos: [], worktrees: [], loading: true, error: null };
    case 'event':
      return { ...state, worktrees: worktreesReducer(state.worktrees, action.data) };
    case 'patchMeta':
      return {
        ...state,
        worktrees: state.worktrees.map((w) =>
          w.path === action.path
            ? // meta may be null for untracked rows — patching one (e.g. a
              // backlog reorder) auto-adopts it server-side, so mirror that
              // optimistically instead of dropping the update.
              { ...w, meta: { ...(w.meta ?? ({} as NonNullable<Worktree['meta']>)), ...action.patch } }
            : w,
        ),
      };
    case 'error':
      return { ...state, error: action.message };
  }
}

// v2: the Dock build starts with the sidebar hidden, whatever an older build stored.
const STORE_SIDEBAR = 'strado:sidebar-collapsed:v2';

// Tasks remains the initial destination; code reviews is the second
// workspace-level view. We intentionally do not restore the old retired view
// values from `strado:view`.
// No hub open: the Worktrees page, every repo and worktree in the space.
const INITIAL_VIEW: SidebarView = { kind: 'worktrees' };
// Hidden until asked for (⌘B): the Dock at the bottom is all a day needs.
function readSidebarCollapsed(): boolean {
  const stored = localStorage.getItem(STORE_SIDEBAR);
  return stored === null ? true : stored === '1';
}

// Per-Focus memory of the open worktree, so switching Focus (or space) brings
// back what each Focus had open instead of the Worktrees page (the tab WITHIN
// a worktree is already remembered per-worktree by TerminalView). Keyed by
// Focus id, which is unique across spaces. Remote hubs aren't persisted yet.
const STORE_SELECTED = 'strado:selected-by-focus';
function readSelMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(STORE_SELECTED) || '{}') as Record<string, string>; }
  catch { return {}; }
}
function writeSelPath(focusId: string, path: string | null): void {
  try {
    const map = readSelMap();
    if (path) map[focusId] = path; else delete map[focusId];
    localStorage.setItem(STORE_SELECTED, JSON.stringify(map));
  } catch { /* quota / disabled storage — ignore */ }
}

// Per-workspace tree snapshot (repos + worktrees) for stale-while-revalidate.
// Switching workspaces used to re-run `git worktree list` per repo before the
// sidebar could paint the right rows, so every swipe flashed the old
// workspace's tree, then swapped when the fetch landed (and the preselect
// highlight couldn't resolve until then). Now a switch paints this cached
// snapshot instantly and a background refetch reconciles it. The in-memory
// `treeCache` makes repeat switches within a session free; the localStorage
// seed makes the first switch after a reload instant too. A cached snapshot's
// process/session status can be briefly stale — SSE and the revalidation both
// correct it — so it's only ever a seed, never the source of truth.
type TreeSnap = { repos: RepoConfig[]; worktrees: Worktree[] };
const STORE_TREE = 'strado:tree-by-ws';
const treeCache = new Map<string, TreeSnap>();
let treeCacheSeeded = false;
function readTreeStore(): Record<string, TreeSnap> {
  try { return JSON.parse(localStorage.getItem(STORE_TREE) || '{}') as Record<string, TreeSnap>; }
  catch { return {}; }
}
function cachedTree(wsId: string): TreeSnap | null {
  if (!treeCacheSeeded) {
    treeCacheSeeded = true;
    const store = readTreeStore();
    for (const [id, snap] of Object.entries(store)) {
      if (snap && Array.isArray(snap.repos) && Array.isArray(snap.worktrees)) treeCache.set(id, snap);
    }
  }
  return treeCache.get(wsId) ?? null;
}
function writeTree(wsId: string, snap: TreeSnap): void {
  treeCache.set(wsId, snap);
  try {
    const store = readTreeStore();
    store[wsId] = snap;
    localStorage.setItem(STORE_TREE, JSON.stringify(store));
  } catch { /* quota / disabled — the in-memory cache still serves this session */ }
}

/**
 * A runner's worktree in the shape the hub expects.
 *
 * Only `remote` is load-bearing; the rest are the neutral defaults a row would
 * have before any local scan, because none of it exists on this machine. The
 * hub replaces them from the runner's own worktree list on mount.
 */
export function remoteAsWorktree(w: RemoteWorktree): Worktree {
  return {
    path: w.path,
    repoId: w.localRepoId,
    branch: w.branch,
    head: w.head,
    prunable: false,
    tracked: true,
    meta: null,
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
    remote: {
      runnerId: w.runnerId,
      runnerName: w.runnerName,
      wsBase: w.wsBase,
      wsId: w.remoteWsId,
    },
    hasClaudeSession: w.hasClaudeSession, claudeStatus: w.claudeStatus,
    claudeStatusById: w.claudeStatusById, claudeSessions: w.claudeSessions,
    hasCodexSession: w.hasCodexSession, codexStatus: w.codexStatus,
    codexStatusById: w.codexStatusById, codexSessions: w.codexSessions,
    hasOpencodeSession: w.hasOpencodeSession, opencodeStatus: w.opencodeStatus,
    opencodeStatusById: w.opencodeStatusById, opencodeSessions: w.opencodeSessions,
    hasPiSession: w.hasPiSession, piStatus: w.piStatus,
    piStatusById: w.piStatusById, piSessions: w.piSessions,
    hasShellSession: w.hasShellSession, shellSessions: w.shellSessions,
  } as Worktree;
}

export function Dashboard(props: {
  /** Changes after a remote create/delete completes, forcing an immediate
   * revalidation instead of waiting for the 20-second recovery poll. */
  remoteRefreshKey?: number;
  /** A renderer modal owned by App is open. Native browser/DevTools views
   *  must be detached because CSS z-index cannot paint above them. */
  modalOpen?: boolean;
  /** New worktree, optionally in a repo and/or for a ticket (an empty Focus passes its own). */
  onNewWorktree: (repoId?: string, ticket?: FocusTicket) => void;
  onShowLogs: (w: Worktree) => void;
  onMenu: (w: Worktree) => void;
  onOpenNote: (w: Worktree) => void;
  onOpenDiff: (w: Worktree) => void;
  // in-app MR review modal for task-board chip clicks; optional so plain
  // renders (tests) fall back to the chip's external link
  onOpenMr?: (w: Worktree, mr: MergeRequest) => void;
  // closes whatever dialog/hub is open (used before a workspace switch — the
  // hub must not stay mounted across it with the old workspace's sessions)
  onCloseOverlays: () => void;
  onDeleteWorktree: (w: Worktree) => void;
  /** A runner's worktree was clicked — open its hub. */
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  onDeleteRemoteWorktree?: (w: RemoteWorktree) => void;
  onRebuildSandbox?: (w: RemoteWorktree) => void;
  update: UpdateFooterProps;
}) {
  const { workspace, allWorkspaces, switchTo } = useWorkspace();
  const wsId = workspace.id;
  // The workspace the CURRENT render belongs to, for async work that resolves
  // after a switch: a fetch started under the old workspace checks this before
  // writing, so stale responses are dropped instead of clobbering the new tree.
  const wsRef = useRef(wsId);
  wsRef.current = wsId;
  const [state, dispatch] = useReducer(reducer, wsId, (id): State => {
    const snap = cachedTree(id);
    return snap
      ? { repos: snap.repos, worktrees: snap.worktrees, loading: false, error: null }
      : { repos: [], worktrees: [], loading: true, error: null };
  });
  // Dispatch 'loaded' AND refresh the SWR cache together, so the next switch to
  // this workspace paints from a current snapshot.
  const commitTree = useCallback((repos: RepoConfig[], worktrees: Worktree[]) => {
    writeTree(wsId, { repos, worktrees });
    dispatch({ type: 'loaded', repos, worktrees });
  }, [wsId]);
  // Adjust state during render the instant wsId changes (Dashboard never
  // remounts across a switch), so the sidebar paints the new workspace's cached
  // tree with no stale-then-swap flash. This bails and re-renders before
  // committing, per React's "derive state from props" escape hatch. The [wsId]
  // load effect below revalidates right after.
  const treeWsRef = useRef(wsId);
  if (treeWsRef.current !== wsId) {
    treeWsRef.current = wsId;
    dispatch({ type: 'switch', snap: cachedTree(wsId) });
  }
  // Restored per workspace once its Focuses have loaded (see below): a hub
  // only ever shows a worktree in the active Focus.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // A worktree on a runner, when that is what's open. Mutually exclusive with
  // selectedPath: one hub at a time.
  const [selectedRemote, setSelectedRemote] = useState<RemoteWorktree | null>(null);
  // undefined = a generic open — TerminalView restores the worktree's
  // last-active tab instead of being forced onto one.
  const [selectedMode, setSelectedMode] = useState<'claude' | 'shell' | 'codex' | 'opencode' | 'pi' | 'vscode' | 'browser' | undefined>(undefined);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  // Bumped on every explicit open (for example, a notification) so the
  // hub switches to the requested tab even when it's already showing this
  // worktree — its mode/sessionId are only read at mount.
  const [openSeq, setOpenSeq] = useState(0);
  // The Focus whose stored selection has been restored; until then the store
  // is read-only for it, so a not-yet-restored null never wipes it, and the
  // selection on screen is never written under a Focus it did not come from.
  const restoredForRef = useRef<string | null>(null);
  // A workspace change (swipe, ⌘K) closes the hub; the Focus effect below
  // brings its active Focus's worktree back once its Focuses are known. A
  // ⌘K deep-link to another workspace overrides this via pendingOpenRef.
  useEffect(() => {
    restoredForRef.current = null;
    setSelectedMode(undefined);
    setSelectedSessionId(undefined);
    setSelectedRemote(null);
    setSelectedPath(null);
  }, [wsId]);
  // Every open path (sidebar row, ⌘K, notification, review link) funnels
  // through openInlineHub / openRemoteWorktree. A hub needs an active Focus:
  // the worktree joins it on open. With none, the open waits in
  // pendingFocusOpenRef while the sidebar asks for a Focus; once one is
  // active the open goes through. Refs, because these callbacks are created
  // before the Focus state they need exists.
  const noteOpenedRef = useRef<(pinId: string) => void>(() => {});
  // 'open' when a Focus is active, 'wait' until the list has loaded, 'ask' when there is none.
  const focusGateRef = useRef<() => 'open' | 'wait' | 'ask'>(() => 'wait');
  type PendingFocusOpen = { kind: 'local'; w: Worktree; mode?: typeof selectedMode; sessionId?: string } | { kind: 'remote'; w: RemoteWorktree };
  const pendingFocusOpenRef = useRef<PendingFocusOpen | null>(null);
  // Pin ids whose join is still in flight: the gate effect must not close
  // the hub in the beat between the open and the server's answer.
  const joiningRef = useRef(new Set<string>());
  const openInlineHub = useCallback((w: Worktree, mode?: typeof selectedMode, sessionId?: string) => {
    const gate = focusGateRef.current();
    if (gate !== 'open') {
      pendingFocusOpenRef.current = { kind: 'local', w, mode, sessionId };
      if (gate === 'ask') window.dispatchEvent(new CustomEvent(NEW_FOCUS_EVENT, { detail: { seedPinId: `local:${w.path}` } }));
      return;
    }
    track('hub_opened', { tab: mode ?? 'restored' });
    // Record the open so the ⌘K palette can rank recently-used worktrees on top.
    bumpWorktreeOpened(w.path);
    noteOpenedRef.current(`local:${w.path}`);
    // Explicitly opening an agent lifts any persisted "closed" flag so the hub
    // shows the tab even after a prior close (reload restores mode='claude').
    if (mode === 'claude' || mode === 'codex' || mode === 'opencode' || mode === 'pi') rememberClosedAgent(mode, w.path, false);
    setSelectedMode(mode);
    setSelectedSessionId(sessionId);
    // Bump the open sequence so an already-open hub applies this request (its
    // mode/sessionId are read only at mount).
    setOpenSeq((n) => n + 1);
    // A remote hub takes render priority, so leaving it set made clicking a
    // local worktree look like nothing happened — you had to close the remote
    // hub first. Switching worktrees must never require closing one.
    setSelectedRemote(null);
    setSelectedPath(w.path);
    // A worktree hub replaces whatever page was open, so the page icon row
    // must stop marking Usage or Code reviews as current.
    setActiveView(INITIAL_VIEW);
  }, []);
  // Palette pick of a worktree in ANOTHER workspace: switch first, and open
  // the hub only once the workspace context has actually landed — opening
  // immediately would spawn its sessions against the old workspace.
  const pendingOpenRef = useRef<{ wsId: string; worktree: Worktree } | null>(null);
  useEffect(() => {
    const pending = pendingOpenRef.current;
    if (pending && pending.wsId === wsId) {
      pendingOpenRef.current = null;
      openInlineHub(pending.worktree);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);
  // The always-visible command bar at the bottom; ⌘K (and the sidebar's
  // search button) put the cursor in it.
  const commandBarRef = useRef<CommandBarHandle | null>(null);
  const focusCommandBar = () => commandBarRef.current?.focus();
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readSidebarCollapsed());
  const [activeView, setActiveView] = useState<SidebarView>(INITIAL_VIEW);
  const [reviewState, setReviewState] = useState<MergeRequest['state']>('open');
  const [reviewSearchFilter, setReviewSearchFilter] = useState({ wsId, value: '' });
  const [reviewRepoFilter, setReviewRepoFilter] = useState({ wsId, value: 'all' });
  // Repository ids are workspace-local. Derive the reset synchronously so the
  // first render after a workspace switch cannot fire a request with the old
  // workspace's repository id while an effect catches up.
  const reviewSearch = reviewSearchFilter.wsId === wsId ? reviewSearchFilter.value : '';
  const reviewRepoId = reviewRepoFilter.wsId === wsId ? reviewRepoFilter.value : 'all';
  const setReviewSearch = (value: string) => setReviewSearchFilter({ wsId, value });
  const setReviewRepoId = (value: string) => setReviewRepoFilter({ wsId, value });
  // Top-level destinations close whichever worktree hub is open.
  const selectView = (view: SidebarView) => {
    setActiveView(view);
    setSelectedPath(null);
    setSelectedRemote(null);
  };
  const codeReviews = useCodeReviews(wsId, reviewState, reviewSearch, reviewRepoId);

  // Tickets: resolve configured providers once, then poll live ticket
  // statuses for all rows every 60s and publish to the shared store (rows
  // subscribe via useTickets).
  const [ticketsOn, setTicketsOn] = useState(false);
  const { providerErrors } = useTickets();
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  // Bumped when the command box changes a setting while Settings is open: the
  // page remounts and reads the new value.
  const [settingsNonce, setSettingsNonce] = useState(0);
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsSection !== null;
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [showAddRepo, setShowAddRepo] = useState(false);
  // A path typed with "add repo <path>", for the dialog to open on.
  const [addRepoPath, setAddRepoPath] = useState<string | null>(null);
  const [addRepoAnchor, setAddRepoAnchor] = useState<AddRepoAnchor | null>(null);
  // Full-screen renderer overlays can be owned here or one level up in App.
  // The Browser preview and its DevTools are native WebContentsViews, so they
  // have to be parked off-screen while any of these is visible.
  // Smaller overlays (the sidebar's worktree hover card) register themselves.
  const overlays = useRendererOverlayRegistry();
  const modalOpen = !!(
    props.modalOpen || settingsSection || feedbackOpen || showAddRepo || overlays.anyOpen
  );
  const [welcomed, setWelcomed] = useState(() => localStorage.getItem('strado:onboarding-welcomed') === '1');
  const refreshTicketProviders = useCallback(() => {
    Promise.all([api.tickets.providers(), api.jira.status().catch(() => null)])
      .then(([providers, jira]) => {
        const configured = providers.filter((p) => p.configured).map((p) => p.provider);
        publishTickets({ configured, jiraBaseUrl: jira?.baseUrl ?? null });
        setTicketsOn(configured.length > 0);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => { refreshTicketProviders(); }, [refreshTicketProviders]);
  useEffect(() => {
    const open = (e: Event) => {
      const section = (e as CustomEvent<{ section?: 'gitlab' | 'github' }>).detail?.section ?? 'gitlab';
      setSettingsSection(section);
    };
    window.addEventListener('strado:open-settings', open);
    return () => window.removeEventListener('strado:open-settings', open);
  }, []);
  const ticketRefs = useMemo(
    () => {
      const refs = state.worktrees
        .filter((w) => !!w.meta?.ticketId)
        .map((w) => ({ provider: (w.meta!.ticketProvider ?? 'jira') as TicketProviderId, key: w.meta!.ticketId }));
      const uniq = new Map(refs.map((r) => [`${r.provider}:${r.key}`, r]));
      return [...uniq.values()].sort((a, b) => `${a.provider}:${a.key}`.localeCompare(`${b.provider}:${b.key}`));
    },
    [state.worktrees],
  );
  useEffect(() => {
    if (!ticketsOn || ticketRefs.length === 0) return;
    let alive = true;
    const load = () =>
      api.tickets.issues(ticketRefs).then(({ issues, missing, errors }) => {
        if (alive) publishTickets({ issues, missing, providerErrors: errors });
      }).catch(() => undefined);
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [ticketsOn, JSON.stringify(ticketRefs)]);

  const prevClaude = useRef<ClaudeStatusMap>({});
  const intercom = useIntercom();
  // Questions waiting on the human, workspace-wide — the header count.
  const openCount = useMemo(() => openEscalations(intercom).length, [intercom.escalations]);
  // The intercom panel lives here, above every surface that opens it (the row
  // badge, a notification, the header count, the hub's banner), so there is
  // only ever one panel and one piece of state describing what it shows.
  const [intercomPanel, setIntercomPanel] = useState<{ tab: 'escalations' | 'tasks'; worktreePath?: string; focusId?: string } | null>(null);

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => undefined);
    }
  }, []);

  // Beep gating reads the CURRENT hub selection at fire time, not the one
  // captured when the worktrees array last changed.
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  useEffect(() => {
    const repoNames: Record<string, string> = {};
    for (const r of state.repos) repoNames[r.id] = r.name;
    const toFire = computeClaudeNotifications(prevClaude.current, state.worktrees, repoNames);
    prevClaude.current = snapshotStatuses(state.worktrees);
    const canNotify = typeof Notification !== 'undefined' && Notification.permission === 'granted';
    for (const n of toFire) {
      // Chime when Claude finishes — but not at the user's face: skip it when
      // they're already looking at that worktree's hub in a focused window.
      const watching = document.hasFocus() && selectedPathRef.current === n.path;
      if (n.kind === 'finished' && !watching) playDoneBeep();
      if (!canNotify) continue;
      const worktree = state.worktrees.find((w) => w.path === n.path);
      const notification = new Notification(n.title, n.body ? { body: n.body } : undefined);
      notification.onclick = () => {
        window.focus();
        // land on the exact session tab the notification came from
        // A retargeted ask from an exited asker has no tab: the drawer only.
        if (worktree && n.mode && n.sessionId) openInlineHub(worktree, n.mode, n.sessionId);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.worktrees]);

  // null = not yet initialized (first loaded snapshot for this workspace);
  // distinguishes "no escalations were open before" from "we haven't seen a
  // snapshot yet", so the first load never fires a notification for
  // escalations already open. Reset on every workspace switch — declared
  // ahead of the notification effect below — so the new workspace's first
  // snapshot also seeds silently instead of firing for everything already
  // open there.
  const prevOpenEscalations = useRef<Set<string> | null>(null);
  useEffect(() => {
    prevOpenEscalations.current = null;
  }, [wsId]);
  useEffect(() => {
    if (!intercom.loaded) return;
    const label = (p: string) => state.worktrees.find((w) => w.path === p)?.meta?.ticketId ?? p.split('/').pop() ?? p;
    const { seen, fire } = nextSeenIds(prevOpenEscalations.current, intercom, label);
    prevOpenEscalations.current = seen;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const n of fire) {
      const worktree = state.worktrees.find((w) => w.path === n.path);
      const notification = new Notification(n.title, n.body ? { body: n.body } : undefined);
      notification.onclick = () => {
        window.focus();
        // A retargeted ask from an exited asker has no tab: the drawer only.
        if (worktree && n.mode && n.sessionId) openInlineHub(worktree, n.mode, n.sessionId);
        setIntercomPanel({ tab: 'escalations', focusId: n.id });
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intercom.escalations, intercom.peers, intercom.loaded]);

  useEffect(() => {
    localStorage.setItem(STORE_SIDEBAR, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  // Home with nothing open is the start screen. Asking for the list (the
  // sidebar's Worktrees, "All worktrees →", the box's "worktrees") shows the
  // full list instead, and stays asked: Back from a worktree opened there
  // returns to the list. "Go home" (and app start) is home again.
  const [homeAll, setHomeAll] = useState(false);
  const onHome = !selectedRemote && !(selectedPath && state.worktrees.some((w) => w.path === selectedPath))
    && activeView.kind === 'worktrees' && !state.loading && state.repos.length > 0 && !homeAll;
  // The sidebar is where the user left it, everywhere (home included): only
  // their own toggle changes it (⌘B, its buttons, the box's "hide the
  // sidebar"). A hub closing itself (its last session gone) must not hide it.
  const sidebarHidden = sidebarCollapsed;

  // Collapsing the sidebar unmounts it, and with it the space chord's own
  // listener — while the shell keeps intercepting the chord inside embeds and
  // forwarding it, so it became a swallowed no-op. There is no carousel to
  // animate here, so this switches straight over.
  useSpaceShortcut((dir) => {
    const i = allWorkspaces.findIndex((w) => w.id === wsId);
    const target = i === -1 ? undefined : allWorkspaces[i + dir];
    if (!target) return;
    Promise.resolve(switchTo(target.id)).catch((err: unknown) =>
      dispatch({ type: 'error', message: `Could not switch to that workspace: ${(err as Error).message}` }),
    );
  }, sidebarHidden);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      // ⌘B: left sidebar
      if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusCommandBar();
      } else if (e.key === ',') {
        e.preventDefault();
        setSettingsSection('profile');
      }
    };
    // capture phase: xterm stops propagation of keys it handles, so a
    // bubble listener never sees ⌘K/⌘B while a terminal is focused
    window.addEventListener('keydown', onKeyDown, true);
    // Shortcuts pressed inside an embed (Browser preview view, VS Code iframe)
    // never reach window listeners; the shell forwards them over IPC.
    const offHotkey = window.strado?.onHotkey?.((combo) => {
      if (combo === 'palette') focusCommandBar();
      else if (combo === 'settings') setSettingsSection('profile');
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      offHotkey?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Paths currently in state — lets the SSE handler tell "update for a row I
  // have" from "a worktree I've never seen" without re-subscribing on every
  // state change.
  const knownPathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    knownPathsRef.current = new Set(state.worktrees.map((w) => w.path));
  }, [state.worktrees]);

  // Runner worktrees, fetched separately from the local list on purpose: this
  // one crosses the network, so it must never sit in front of the local
  // sidebar rendering. Polled rather than pushed — remote changes have no SSE
  // channel into this window yet.
  const [remote, setRemote] = useState<{ runners: RunnerStatus[]; worktrees: RemoteWorktree[] }>({
    runners: [],
    worktrees: [],
  });
  // True until this workspace's FIRST remote fetch settles — the sidebar shows
  // a quiet loading hint instead of runner rows popping in a beat late.
  const [remoteLoading, setRemoteLoading] = useState(true);
  const openRemoteWorktree = useCallback((w: RemoteWorktree) => {
    const gate = focusGateRef.current();
    if (gate !== 'open') {
      pendingFocusOpenRef.current = { kind: 'remote', w };
      if (gate === 'ask') window.dispatchEvent(new CustomEvent(NEW_FOCUS_EVENT, { detail: { seedPinId: `remote:${w.runnerId}:${w.path}` } }));
      return;
    }
    noteOpenedRef.current(`remote:${w.runnerId}:${w.path}`);
    setSelectedPath(null); // one hub at a time
    setSelectedRemote(w);
    setActiveView(INITIAL_VIEW);
    props.onOpenRemoteWorktree?.(w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onOpenRemoteWorktree]);

  // An opened worktree joins the active Focus. Assigned every render so the
  // open callbacks above see the current Focus.
  const focusApi = useFocuses(wsId);
  // Jarvis (⌘K commands): the last run's undo toast, and the tab the last
  // command acted on ("it" for the next one) — kept across palette opens.
  const [jarvisRun, setJarvisRun] = useState<JarvisRun | null>(null);
  const jarvisLastActed = useRef<JarvisTabRef | null>(null);
  useFocusShortcut({ focuses: focusApi.focuses, activeId: focusApi.activeId, activate: focusApi.activate });
  focusGateRef.current = () => (!focusApi.loaded ? 'wait' : focusApi.active ? 'open' : 'ask');
  noteOpenedRef.current = (pinId) => {
    joiningRef.current.add(pinId);
    void (async () => {
      await ensureFocusesLoaded(wsId);
      const active = activeFocusOf(wsId);
      if (active && !active.members.includes(pinId)) await focusApi.setMembership(active.id, pinId, true);
    })()
      .catch((err) => dispatch({ type: 'error', message: `Could not add to focus: ${(err as Error).message}` }))
      .finally(() => { joiningRef.current.delete(pinId); });
  };
  // Persist the open worktree under the active Focus (remote hubs store nothing).
  useEffect(() => {
    const id = focusApi.activeId;
    if (id && restoredForRef.current === id) writeSelPath(id, selectedRemote ? null : selectedPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, selectedRemote]);
  // An open that waited for a Focus goes through once one is active.
  useEffect(() => {
    const pending = pendingFocusOpenRef.current;
    if (!pending || !focusApi.loaded || !focusApi.active) return;
    pendingFocusOpenRef.current = null;
    if (pending.kind === 'local') openInlineHub(pending.w, pending.mode, pending.sessionId);
    else openRemoteWorktree(pending.w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusApi.loaded, focusApi.active]);
  // A Focus becoming active (load, switch, creation) brings back the worktree
  // it last had open, if it still holds it. Otherwise, and whenever the open
  // worktree is dropped from the active Focus, the hub closes: it never shows
  // a worktree the sidebar does not.
  useEffect(() => {
    if (!focusApi.loaded) return;
    const active = focusApi.active;
    const pin = selectedRemote ? remotePinId(selectedRemote) : selectedPath ? `local:${selectedPath}` : null;
    if (active && restoredForRef.current !== active.id) {
      restoredForRef.current = active.id;
      const path = readSelMap()[active.id] ?? null;
      if (path && active.members.includes(`local:${path}`)) {
        if (path !== selectedPath || selectedRemote) {
          setSelectedMode(undefined);
          setSelectedSessionId(undefined);
          setSelectedRemote(null);
          setSelectedPath(path);
        }
        return;
      }
    }
    if (!pin || joiningRef.current.has(pin)) return;
    if (active?.members.includes(pin)) return;
    setSelectedPath(null);
    setSelectedRemote(null);
  }, [focusApi.loaded, focusApi.active, selectedPath, selectedRemote]);
  useEffect(() => {
    // A space switch clears the previous space's rows rather than letting them
    // linger: they'd render as orphan repo folders here until the fetch lands.
    setRemote({ runners: [], worktrees: [] });
    setRemoteLoading(true);
  }, [wsId]);
  const reloadRemote = useCallback(async () => {
    try {
      const result = await api.runners.remoteWorktrees(wsId);
      // A slow response from before a workspace switch must not land under
      // the new workspace — by the time it resolves, wsId may have moved on.
      if (wsRef.current === wsId) setRemote(result);
    } catch {
      // No account, cloud down, old server: simply no remote rows.
      if (wsRef.current === wsId) setRemote({ runners: [], worktrees: [] });
    } finally {
      if (wsRef.current === wsId) setRemoteLoading(false);
    }
  }, [wsId]);
  const remoteRefreshKey = props.remoteRefreshKey ?? 0;
  const appliedRemoteRefreshKey = useRef(remoteRefreshKey);
  useEffect(() => {
    // Skip the initial render—the normal load effect below owns it. If a
    // mutation finishes while the local tree is still loading, leave the key
    // unapplied so this effect retries as soon as loading settles.
    if (state.loading || appliedRemoteRefreshKey.current === remoteRefreshKey) return;
    appliedRemoteRefreshKey.current = remoteRefreshKey;
    void reloadRemote();
  }, [remoteRefreshKey, reloadRemote, state.loading]);
  useEffect(() => {
    if (state.loading) return; // never compete with the first local paint
    void reloadRemote();
    const t = window.setInterval(() => void reloadRemote(), 20_000);
    return () => window.clearInterval(t);
  }, [state.loading, reloadRemote]);

  useEffect(() => {
    let alive = true;
    const loadAll = async () => {
      try {
        const [repos, worktrees] = await Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]);
        if (alive) commitTree(repos, worktrees);
      } catch (err) {
        if (alive) dispatch({ type: 'error', message: (err as Error).message });
      }
    };
    void loadAll();
    const unsub = subscribeWorktrees((evt) => {
      dispatch({ type: 'event', data: evt });
      // A partial event can't build a full row, so the reducer drops events
      // for unknown paths — which is exactly what worktree CREATION emits.
      // Refetch so new worktrees appear without waiting for the 15s poll.
      if (!evt.data.removed && !knownPathsRef.current.has(evt.data.path)) void loadAll();
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [wsId]);

  // Live process/status updates arrive over SSE (subscribeWorktrees). This
  // interval only re-syncs state that SSE can't push: worktrees created/removed
  // on disk and external-process detection. (We no longer call refreshGit per
  // worktree — its git ahead/behind/dirty result was never rendered.)
  useEffect(() => {
    if (state.loading) return;
    const id = setInterval(async () => {
      try {
        const [repos, worktrees] = await Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]);
        // A tick in flight across a workspace switch resolves with the OLD
        // workspace's tree; dispatching it would repaint the new sidebar with
        // the old repos until the next revalidation. Drop it instead.
        if (wsRef.current === wsId) commitTree(repos, worktrees);
      } catch {
        // ignore transient failures
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [state.loading, wsId]);

  const selectedWorktree = selectedPath ? state.worktrees.find((w) => w.path === selectedPath) ?? null : null;

  // ---------- the Dock ----------
  const { stations } = useStations(wsId);
  // What sits above the Dock: a station's card or the Line view; only ever opened by the user.
  const [dockPanel, setDockPanel] = useState<{ kind: 'station'; agentId: string } | { kind: 'line' } | null>(null);
  // Listen: a station's recent messages on its card, the whole line in the Line view.
  const cardFeed = useFeed(wsId, dockPanel?.kind === 'station' ? dockPanel.agentId : null, dockPanel?.kind === 'station');
  const lineFeed = useFeed(wsId, null, dockPanel?.kind === 'line');
  const [devError, setDevError] = useState<{ path: string; message: string } | null>(null);
  // Bumped by the Dock's "logs": the hub opens its log drawer.
  const [logsSeq, setLogsSeq] = useState(0);
  // The hub's dev server (local or on a runner), as it reports it.
  const [hubDev, setHubDev] = useState<DevState | null>(null);
  const dockWorktree = selectedRemote
    ? { name: selectedRemote.branch ?? selectedRemote.name, branch: null }
    : selectedWorktree
      ? { name: selectedWorktree.meta?.ticketId || selectedWorktree.branch || selectedWorktree.path.split('/').pop() || selectedWorktree.path, branch: selectedWorktree.branch ?? null }
      : null;
  const devFor = (w: Worktree) => ({
    status: w.process?.status ?? 'idle',
    port: w.process?.port ?? null,
    error: devError?.path === w.path ? devError.message : null,
    onStart: () => {
      setDevError(null);
      api.worktrees.start(wsId, w.path).catch((err: unknown) => setDevError({ path: w.path, message: (err as Error).message }));
    },
    onStop: () => {
      api.worktrees.stop(wsId, w.path).catch((err: unknown) => setDevError({ path: w.path, message: (err as Error).message }));
    },
    onLogs: () => setLogsSeq((n) => n + 1),
  });
  const devFromHub = (d: DevState) => ({
    status: d.status,
    port: d.port,
    detail: d.detail,
    remote: d.remote,
    profiles: d.profiles,
    onProfile: d.setProfile,
    error: devError?.path === d.path ? devError.message : null,
    onStart: () => {
      setDevError(null);
      d.start().catch((err: unknown) => setDevError({ path: d.path, message: (err as Error).message }));
    },
    onStop: () => {
      d.stop().catch((err: unknown) => setDevError({ path: d.path, message: (err as Error).message }));
    },
    onLogs: () => setLogsSeq((n) => n + 1),
  });
  const dockDev = hubDev ? devFromHub(hubDev) : selectedWorktree && !selectedRemote ? devFor(selectedWorktree) : null;
  const openStationTab = (s: StationDto) => {
    setDockPanel(null);
    const w = state.worktrees.find((x) => x.path === s.worktreePath);
    if (w) openInlineHub(w, s.mode as typeof selectedMode, s.sessionId);
  };
  const cardStation = dockPanel?.kind === 'station' ? stations.find((s) => s.agentId === dockPanel.agentId) : undefined;
  const dockPanelEl = cardStation ? (
    <StationCard
      key={cardStation.agentId}
      station={cardStation}
      recent={cardFeed}
      onAnswer={(callId, text) => api.intercom.escalations.resolve(wsId, callId, text)}
      onDismiss={(callId) => api.intercom.escalations.dismiss(wsId, callId)}
      onTalk={async (text) => {
        const d = (await jarvisServerPort(wsId).message(cardStation.agentId, text)) as { delivered?: string } | undefined;
        const name = cardStation.alias ?? cardStation.name;
        // How it landed, in the box's own words (always via the intercom).
        if (d?.delivered === 'sent') setJarvisRun({ ok: true, notice: true, summary: `Sent to ${name} via intercom`, undo: [], undoable: false });
        else if (d?.delivered === 'queued') setJarvisRun({ ok: true, notice: true, summary: `${name} is busy — it’ll read it after this turn`, undo: [], undoable: false });
      }}
      onOpenTab={() => openStationTab(cardStation)}
      onClose={() => setDockPanel(null)}
    />
  ) : dockPanel?.kind === 'line' ? (
    <LineView
      stations={stations}
      worktreePath={selectedRemote ? null : selectedPath}
      feed={lineFeed}
      tasks={intercom.tasks ?? []}
      onOpenStation={(agentId) => setDockPanel({ kind: 'station', agentId })}
      onOpenDetails={() => { setDockPanel(null); setIntercomPanel({ tab: 'escalations' }); }}
      onClose={() => setDockPanel(null)}
    />
  ) : null;

  // The rail spans machines: local worktrees plus every runner's, mapped to the
  const handleStop = async (w: Worktree) => {
    try {
      await api.worktrees.stop(wsId, w.path);
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  };
  const handleKillExternal = async (w: Worktree) => {
    if (!confirm(`Send SIGTERM to external pid ${w.process.pid}?`)) return;
    try {
      await api.worktrees.killExternal(wsId, w.path);
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  };
  // One element, rendered in both toolbars — the Worktrees page's and the hub's
  // — so the "what is serving right now" answer is the same wherever you are. Opening a
  // row lands on the preview tab in the desktop app; the web build has no
  // embedded browser, so it opens the hub's shell instead.
  // Questions waiting on you, workspace-wide. Amber whenever the count is
  // non-zero and a muted glyph otherwise, so the control never moves or vanishes.
  const intercomButton = (
    <button
      aria-label={openCount > 0 ? `Open intercom, ${openCount} waiting on you` : 'Open intercom'}
      title={openCount > 0 ? `${openCount} waiting on you` : 'Intercom'}
      onClick={() => setIntercomPanel({ tab: 'escalations' })}
      className={
        openCount > 0
          ? 'shrink-0 rounded-md border border-amber-800/60 bg-amber-950/40 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-900/40'
          : 'shrink-0 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
      }
    >
      {openCount > 0 ? `⚑ ${openCount}` : '⚑'}
    </button>
  );
  const runningServers = (
    <RunningServers
      worktrees={state.worktrees}
      onOpen={(w) => openInlineHub(w, typeof window !== 'undefined' && window.strado ? 'browser' : 'shell')}
      onStop={handleStop}
      onKillExternal={handleKillExternal}
    />
  );

  // First run: the welcome gate is a standalone page — no sidebar, no
  // sessions dock — and blocks until every environment check passes.
  if (!welcomed && (state.loading || state.repos.length === 0)) {
    if (state.loading) return <div className="h-screen bg-zinc-950" />;
    return (
      <OnboardingWelcome
        onContinue={() => {
          localStorage.setItem('strado:onboarding-welcomed', '1');
          setWelcomed(true);
        }}
      />
    );
  }

  // App control: an agent's `focus:true` placement switches this window to
  // the worktree it names (local worktrees only — the server can't name a
  // runner's).
  const openWorktreeForAgent = (path: string): boolean => {
    const w = state.worktrees.find((x) => x.path === path);
    if (!w) return false;
    openInlineHub(w);
    return true;
  };

  // The rest of the app for the command box: pages, Settings, plain settings.
  const appPort: JarvisAppPort = {
    page: (page) => {
      setSettingsSection(null);
      if (page === 'home') { selectView(INITIAL_VIEW); setHomeAll(false); }
      else if (page === 'worktrees') { selectView({ kind: 'worktrees' }); setHomeAll(true); }
      else selectView({ kind: page });
    },
    settings: (section) => { setSettingsSection(section); setSettingsNonce((n) => n + 1); },
    set: async (setting, value) => {
      if (setting === 'profile.name') await api.profile.save({ fullName: value });
      else if (setting === 'profile.callMe') await api.profile.save({ callMe: value });
      else if (setting === 'privacy.telemetry') await api.profile.save({ telemetryOptOut: value === 'off' });
      else if (setting === 'commandbox.localOnly') await api.profile.save({ jarvisLocalOnly: value === 'on' });
      else {
        const key = ({ 'appearance.theme': 'preset', 'appearance.font': 'font', 'appearance.diffFont': 'diffFont', 'appearance.terminalFont': 'terminalFont' } as const)[setting as 'appearance.theme'];
        if (!key || !setAppearance(key, value)) throw new Error(`Can't set ${setting} to ${value}`);
      }
      // Settings open: show the new value there.
      if (settingsOpenRef.current) setSettingsNonce((n) => n + 1);
    },
    // The same state ⌘B and the collapse/open buttons use.
    sidebar: (show) => setSidebarCollapsed(!(show ?? sidebarHidden)),
    // Focus edits go through the sidebar's own calls: a new Focus becomes the
    // active one, and deleting the active one leaves none active.
    focus: async ({ op, focusId, name, worktreePaths }) => {
      const members = worktreePaths.map((path) => {
        const w = state.worktrees.find((x) => x.path === path);
        if (!w) throw new Error(`No worktree at ${path}`);
        return localPinId(w);
      });
      const id = () => { if (!focusId) throw new Error('Which Focus?'); return focusId; };
      if (op === 'create') {
        if (!name?.trim()) throw new Error('A new Focus needs a name');
        return { focusId: (await focusApi.create(name.trim(), members)).id };
      } else if (op === 'rename') {
        if (!name?.trim()) throw new Error('Rename it to what?');
        await focusApi.rename(id(), name.trim());
      } else if (op === 'delete') await focusApi.remove(id());
      else if (op === 'add') await focusApi.addMembers(id(), members);
      else for (const m of members) await focusApi.setMembership(id(), m, false);
    },
  };

  // The command bar: the home screen's big box while home shows, the Dock's
  // otherwise, and over Settings while Settings is open (one at a time).
  const commandBar = (hero: boolean) => (
    <JarvisPaletteHost
      app={appPort}
      // Real dialogs only (the bar's own popover and hover cards are overlays, not dialogs).
      dialogOpen={!!(props.modalOpen || feedbackOpen || showAddRepo)}
      embedded={!hero}
      hero={hero}
      stations={stations}
      barRef={commandBarRef}
      onOpen={() => track('palette_used')}
      wsId={wsId}
      lastActedOn={jarvisLastActed}
      onOpenCommandSettings={() => setSettingsSection('commandbox')}
      onRan={(r) => setJarvisRun(r)}
      nav={{
        worktree: (path) => { const w = state.worktrees.find((x) => x.path === path); if (w) openInlineHub(w); },
        focus: (id) => focusApi.activate(id),
        workspace: (id) => { props.onCloseOverlays(); void switchTo(id); },
        repo: (repoPath) => { const r = state.repos.find((x) => x.path === repoPath); if (r) { props.onCloseOverlays(); props.onNewWorktree(r.id); } },
        line: () => setDockPanel({ kind: 'line' }),
        addRepo: (path) => { props.onCloseOverlays(); setAddRepoAnchor(null); setAddRepoPath(path); setShowAddRepo(true); },
        newWorktree: (repoPath) => {
          const r = repoPath ? state.repos.find((x) => x.path === repoPath) : undefined;
          props.onCloseOverlays();
          props.onNewWorktree(r?.id);
        },
      }}
      focusName={focusApi.active?.name}
      focusMemberIds={focusApi.active ? new Set(focusApi.active.members) : undefined}
      focuses={focusApi.focuses}
      activeFocusId={focusApi.activeId}
      onSwitchFocus={focusApi.activate}
      repos={state.repos}
      worktrees={state.worktrees}
      workspaces={allWorkspaces}
      activeWorkspaceId={wsId}
      remoteWorktrees={remote.worktrees}
      onOpenRemoteWorktree={openRemoteWorktree}
      onOpenWorktree={(w, fromWs) => {
        if (fromWs && fromWs !== wsId) {
          // hub (if open) must come down before the workspace flips —
          // mounted across the switch it would reconnect its old
          // sessions against the new workspace
          props.onCloseOverlays();
          setSelectedPath(null);
          pendingOpenRef.current = { wsId: fromWs, worktree: w };
          void switchTo(fromWs);
        } else {
          openInlineHub(w);
        }
      }}
      onGoRepo={(repoId) => { props.onCloseOverlays(); props.onNewWorktree(repoId); }}
      onSwitchWorkspace={(id) => {
        props.onCloseOverlays();
        void switchTo(id);
      }}
      onClose={() => {}}
    />
  );

  return (
    <UiControlProvider wsId={wsId} openWorktree={openWorktreeForAgent}>
    <RendererOverlayContext.Provider value={overlays.report}>
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-200">
      <div className={settingsSection ? 'hidden' : 'flex min-w-0 flex-1'}>
      {!sidebarHidden && (
        <div className="contents">
        <Sidebar
          repos={state.repos}
          worktrees={state.worktrees}
          remoteWorktrees={remote.worktrees}
          runnerStatuses={remote.runners}
          remoteLoading={remoteLoading}
          onDeleteRemoteWorktree={(w) => props.onDeleteRemoteWorktree?.(w)}
          onRebuildSandbox={(w) => props.onRebuildSandbox?.(w)}
          onOpenRemoteWorktree={openRemoteWorktree}
          // Home is no page: nothing in the page row is current there.
          selected={onHome ? null : activeView}
          onSelect={(view) => { selectView(view); if (view.kind === 'worktrees') setHomeAll(true); }}
          onSwitchError={(message) => dispatch({ type: 'error', message })}
          onOpenSettings={() => setSettingsSection('profile')}
          onCollapse={() => setSidebarCollapsed(true)}
          onAddRepo={(anchor) => {
            setAddRepoAnchor(anchor ?? null);
            setShowAddRepo(true);
          }}
          onSearch={focusCommandBar}
          onOpenWorktree={(w, mode, sessionId) => openInlineHub(w, mode, sessionId)}
          onOpenMr={props.onOpenMr}
          onOpenDiff={props.onOpenDiff}
          activeWorktreePath={selectedRemote?.path ?? selectedPath}
          onNewWorktree={(ticket) => props.onNewWorktree(undefined, ticket)}
          onWorktreeSettings={(w) => props.onMenu(w)}
          onDeleteWorktree={(w) => props.onDeleteWorktree(w)}
          update={props.update}
        />
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {state.error && (
          <div className="mx-4 mt-3 rounded bg-red-900/40 px-3 py-2 text-sm text-red-200">{state.error}</div>
        )}

        {selectedRemote ? (
          <div className="min-h-0 flex-1">
            {/* The SAME hub as a local worktree — one surface, one set of
                habits. TerminalView reads `remote` and sources its session list
                from that runner instead of this machine. */}
            <TerminalView
              key={`${selectedRemote.runnerId}:${selectedRemote.path}`}
              worktree={remoteAsWorktree(selectedRemote)}
              mode={selectedMode}
              sessionId={selectedSessionId}
              openSeq={openSeq}
              onClose={() => setSelectedRemote(null)}
              sidebarCollapsed={sidebarCollapsed}
              onExpandSidebar={() => setSidebarCollapsed(false)}
              runningServers={runningServers}
              onOpenUsage={() => setActiveView({ kind: 'usage' })}
              modalOpen={modalOpen}
              logsSeq={logsSeq}
              onDevState={setHubDev}
            />
          </div>
        ) : selectedWorktree ? (
          <div className="min-h-0 flex-1">
            <TerminalView
              key={selectedWorktree.path}
              worktree={selectedWorktree}
              mode={selectedMode}
              sessionId={selectedSessionId}
              openSeq={openSeq}
              onClose={() => setSelectedPath(null)}
              sidebarCollapsed={sidebarCollapsed}
              onExpandSidebar={() => setSidebarCollapsed(false)}
              runningServers={runningServers}
              onOpenUsage={() => setActiveView({ kind: 'usage' })}
              modalOpen={modalOpen}
              logsSeq={logsSeq}
              onDevState={setHubDev}
            />
          </div>
        ) : activeView.kind === 'reviews' ? (
          <CodeReviewsPage
            key={wsId}
            reviews={codeReviews.reviews}
            repositories={codeReviews.repositories}
            counts={codeReviews.counts}
            state={reviewState}
            repoId={reviewRepoId}
            repos={state.repos}
            worktrees={state.worktrees}
            loading={codeReviews.loading}
            refreshing={codeReviews.refreshing}
            page={codeReviews.page}
            pageSize={codeReviews.pageSize}
            hasMore={codeReviews.hasMore}
            pageLimit={codeReviews.pageLimit}
            error={codeReviews.error}
            onRefresh={codeReviews.refresh}
            onStateChange={setReviewState}
            onRepoChange={setReviewRepoId}
            onSearchChange={setReviewSearch}
            onPageChange={codeReviews.goToPage}
            sidebarCollapsed={sidebarCollapsed}
            onExpandSidebar={() => setSidebarCollapsed(false)}
            runningServers={runningServers}
          />
        ) : activeView.kind === 'usage' ? (
          <UsagePage
            key={wsId}
            wsId={wsId}
            sidebarCollapsed={sidebarCollapsed}
            onExpandSidebar={() => setSidebarCollapsed(false)}
            runningServers={runningServers}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {state.loading ? (
              <div className="px-6 py-8 text-sm text-zinc-500">Loading…</div>
            ) : state.repos.length === 0 ? (
              <OnboardingCard
                wsId={wsId}
                onAdded={async () => {
                  const [repos, worktrees] = await Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]);
                  commitTree(repos, worktrees);
                }}
                onOpenRepos={() => {
                  setAddRepoAnchor(null);
                  setShowAddRepo(true);
                }}
              />
            ) : (
              <>
                {(Object.entries(providerErrors) as [TicketProviderId, string][]).map(([provider]) => (
                  <button
                    key={provider}
                    onClick={() => setSettingsSection(provider)}
                    className="mx-4 mt-3 block w-[calc(100%-2rem)] rounded bg-amber-900/30 px-3 py-2 text-left text-sm text-amber-200 hover:bg-amber-900/40"
                  >
                    {providerLabel(provider)} connection failed — reconnect in Settings
                  </button>
                ))}
              {onHome ? (
              <HomeScreen
                bar={settingsSection ? null : commandBar(true)}
                recent={recentWorktrees(state.worktrees, state.repos, readWorktreeLru())}
                waiting={stations.filter((st) => lightOf(st) === 'calling').length}
                onOpenRecent={(w) => openInlineHub(w)}
                onAllWorktrees={() => setHomeAll(true)}
                onAddRepo={() => { setAddRepoAnchor(null); setShowAddRepo(true); }}
                onNewWorktree={() => props.onNewWorktree()}
                onWaiting={() => setDockPanel({ kind: 'line' })}
                sidebarCollapsed={sidebarHidden}
                onExpandSidebar={() => setSidebarCollapsed(false)}
              />
              ) : (
              <WorktreesPage
                key={wsId}
                wsId={wsId}
                repos={state.repos}
                worktrees={state.worktrees}
                remoteWorktrees={remote.worktrees}
                runnerStatuses={remote.runners}
                activeWorktreePath={null /* the page shows only while no hub is open */}
                sidebarCollapsed={sidebarCollapsed}
                onExpandSidebar={() => setSidebarCollapsed(false)}
                runningServers={<>{intercomButton}{runningServers}</>}
                onAddRepo={() => { setAddRepoAnchor(null); setShowAddRepo(true); }}
                onNewWorktree={(repoId) => props.onNewWorktree(repoId)}
                onRemoveRepo={async (repo) => {
                  if (!confirm(`Remove "${repo.name}" from this workspace? Worktrees on disk are left untouched.`)) return;
                  try {
                    await api.repos.remove(wsId, repo.id);
                    const [repos, worktrees] = await Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]);
                    commitTree(repos, worktrees);
                  } catch (err) {
                    dispatch({ type: 'error', message: (err as Error).message });
                  }
                }}
                onOpenWorktree={(w) => openInlineHub(w)}
                onOpenRemoteWorktree={openRemoteWorktree}
                onOpenMr={props.onOpenMr}
                onWorktreeSettings={(w) => props.onMenu(w)}
                onDeleteWorktree={(w) => props.onDeleteWorktree(w)}
                onDeleteRemoteWorktree={(w) => props.onDeleteRemoteWorktree?.(w)}
                onError={(message) => dispatch({ type: 'error', message })}
              />
              )}
              </>
            )}
          </div>
        )}
        <Dock
          worktree={dockWorktree}
          worktreePath={selectedRemote ? null : selectedPath}
          onBrowse={() => commandBarRef.current?.browse()}
          stations={stations}
          onOpenStation={(agentId) => setDockPanel({ kind: 'station', agentId })}
          onOpenLine={() => setDockPanel({ kind: 'line' })}
          dev={dockDev}
          panel={dockPanelEl}
          onClosePanel={() => setDockPanel(null)}
          bare={onHome}
        >
        {onHome || settingsSection ? null : commandBar(false)}
        </Dock>
      </main>
      </div>


      {settingsSection && (
        <SettingsPage
          key={`${settingsSection}:${settingsNonce}`}
          section={settingsSection}
          bottomInset
          onClose={() => setSettingsSection(null)}
          onJiraConnected={() => {
            track('jira_connected');
            refreshTicketProviders();
          }}
          onOpenFeedback={() => setFeedbackOpen(true)}
        />
      )}
      {settingsSection && (
        <div className="fixed inset-x-0 bottom-0 z-[60] flex h-11 items-center border-t border-zinc-900 bg-zinc-950 px-4" data-testid="settings-command-bar">
          {commandBar(false)}
        </div>
      )}

      {intercomPanel && (
        <IntercomPanel
          // The panel reads its tab and worktree filter into state once, so a
          // second open with a different tab or worktree has to remount to apply
          // them. `focusId` is excluded — it's a plain prop the panel reacts to
          // on every change, so clicking a second notification while the drawer
          // is already open scrolls to the new row instead of remounting it.
          key={`${intercomPanel.tab}:${intercomPanel.worktreePath ?? ''}`}
          initialTab={intercomPanel.tab}
          worktreePath={intercomPanel.worktreePath}
          focusId={intercomPanel.focusId}
          onClose={() => setIntercomPanel(null)}
          onOpenTab={(path, mode, sessionId) => {
            const w = state.worktrees.find((x) => x.path === path);
            if (w) openInlineHub(w, mode, sessionId);
          }}
        />
      )}

      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        context={activeView.kind}
      />

      {showAddRepo && (
        <AddRepoDialog
          anchor={addRepoAnchor}
          initialPath={addRepoPath}
          onAdded={async () => {
            const [repos, worktrees] = await Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]);
            commitTree(repos, worktrees);
          }}
          onClose={() => {
            setShowAddRepo(false);
            setAddRepoAnchor(null);
            setAddRepoPath(null);
          }}
        />
      )}

      {jarvisRun && <JarvisToast wsId={wsId} run={jarvisRun} onDone={() => setJarvisRun(null)} />}
    </div>
    </RendererOverlayContext.Provider>
    </UiControlProvider>
  );
}
