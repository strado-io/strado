import { OpenSidebarButton } from '../components/SidebarToggle';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, type FocusTicket, type RemoteWorktree, type RunnerStatus, type TicketProviderId } from '../api';
import { subscribeWorktrees, worktreesReducer } from '../eventStream';
import { computeClaudeNotifications, snapshotStatuses, type ClaudeStatusMap } from '../hooks/claudeNotifications';
import { UiControlProvider } from '../contexts/UiControlContext';
import { JarvisPaletteHost, JarvisToast, type JarvisRun } from '../components/jarvis/JarvisPaletteHost';
import type { CommandBarHandle } from '../components/CommandPalette';
import { Dock } from '../components/dock/Dock';
import { HomeScreen } from '../components/home/HomeScreen';
import { recentInFocus, recentWorktrees } from '../lib/home/recent';
import { AddWorktreesDialog } from '../components/focus/AddWorktreesDialog';
import { lightOf } from '../lib/dock/stations';
import { focusWorktreesOf, missionStations } from '../components/mission/mission';
import { OrphanCalls } from '../components/mission/OrphanCalls';
import { MissionStack } from '../components/mission/MissionStack';
import { runCommandsError } from '../components/runCommands/RunCommandsDialog';
import { useMissionBox, type MissionBoxDeps } from '../components/mission/useMissionBox';
import { chipLabel } from '../lib/mention/chips';
import { jarvisServerPort } from '../lib/jarvis/serverPort';
import { useStations } from '../hooks/stations';
import type { TabRef as JarvisTabRef } from '../lib/jarvis/types';
import { nextSeenCalls } from '../hooks/callNotifications';
import { playDoneBeep } from '../lib/beep';
import type { MergeRequest, RepoConfig, Worktree, WorkflowStatus } from '../types';
import { OnboardingCard } from '../components/OnboardingCard';
import { AddRepoDialog, type AddRepoAnchor } from '../components/AddRepoDialog';
import { Sidebar, type SidebarView } from '../components/Sidebar';
import type { UpdateFooterProps } from '../components/UpdateFooter';
import { publishTickets, providerLabel, useTickets } from '../hooks/tickets';
import { isRunning } from '../hooks/filters';
import { RunningServers } from '../components/RunningServers';
import { getSidebarCollapsed, loadSidebarCollapsed, setSidebarCollapsed, useSidebarCollapsed } from '../lib/sidebarStore';
import { useAppHistory, type Place } from '../lib/navHistory';
import { OnboardingWelcome } from '../components/OnboardingWelcome';
import { SettingsPage, type SettingsSection } from '../components/settings/SettingsPage';
import type { HostTab } from '../components/hosts/HostDetails';
import { setAppearance } from '../hooks/useAppearance';
import { useHubDisplayPreferences } from '../hooks/useHubDisplayPreferences';
import type { JarvisAppPort } from '../lib/jarvis/execute';
import { FeedbackDialog } from '../components/FeedbackDialog';
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
import { useCodeReviews } from '../hooks/codeReviews';
import { requestRunInShell } from '../lib/runInShell';
import { worktreeLabel } from '../components/sidebar/labels';
import { FocusJarvisMain, FocusJarvisProvider, FocusJarvisStatus, type OpenCard } from '../components/focusJarvis/FocusJarvisHost';
import type { JarvisStart } from '../components/focusJarvis/FocusJarvisView';
import { useFocusJarvisBadges } from '../components/focusJarvis/badges';

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

// Tasks remains the initial destination; code reviews is the second
// workspace-level view. We intentionally do not restore the old retired view
// values from `strado:view`.
// No hub open: the Worktrees page, every repo and worktree in the space.
const INITIAL_VIEW: SidebarView = { kind: 'worktrees' };

// Per-Focus memory of the open worktree, so switching Focus (or space) brings
// back what each Focus had open instead of the Worktrees page (the tab WITHIN
// a worktree is already remembered per-worktree by TerminalView). Keyed by
// Focus id, which is unique across spaces. Remote hubs aren't persisted yet.
const STORE_SELECTED = 'strado:selected-by-focus';
function readSelMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(STORE_SELECTED) || '{}') as Record<string, string>; }
  catch { return {}; }
}
// The Focuses whose Jarvis chat this window has open (per window: another
// window may be on the same Focus, looking at a worktree).
const STORE_JARVIS = 'strado:jarvis-by-focus';
function readJarvisOpen(focusId: string): boolean {
  try { return (JSON.parse(sessionStorage.getItem(STORE_JARVIS) || '[]') as string[]).includes(focusId); }
  catch { return false; }
}
function writeJarvisOpen(focusId: string, open: boolean): void {
  try {
    const ids = (JSON.parse(sessionStorage.getItem(STORE_JARVIS) || '[]') as string[]).filter((x) => x !== focusId);
    sessionStorage.setItem(STORE_JARVIS, JSON.stringify(open ? [...ids, focusId] : ids));
  } catch { /* disabled storage — ignore */ }
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
  // The active Focus's Jarvis chat fills the main area. Opening a worktree,
  // a remote one or a page replaces it.
  const [jarvisOpen, setJarvisOpen] = useState(false);
  useEffect(() => { if (selectedPath || selectedRemote) setJarvisOpen(false); }, [selectedPath, selectedRemote]);
  // undefined = a generic open — TerminalView restores the worktree's
  // last-active tab instead of being forced onto one.
  const [selectedMode, setSelectedMode] = useState<'claude' | 'shell' | 'codex' | 'opencode' | 'pi' | 'browser' | 'files' | undefined>(undefined);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  // Bumped on every explicit open (for example, a notification) so the
  // hub switches to the requested tab even when it's already showing this
  // worktree — its mode/sessionId are only read at mount.
  const [openSeq, setOpenSeq] = useState(0);
  // The open is a ⌘[ / ⌘] step back to a tab: switch to it only if it is still open.
  const [openSoft, setOpenSoft] = useState(false);
  // The hub's tab on screen, as TerminalView reports it: part of the place ⌘[ / ⌘] record.
  const [hubTab, setHubTab] = useState<{ path: string; mode: string; id: string } | null>(null);
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
  type PendingFocusOpen = { kind: 'local'; w: Worktree; mode?: typeof selectedMode; sessionId?: string } | { kind: 'remote'; w: RemoteWorktree; mode?: 'files' };
  const pendingFocusOpenRef = useRef<PendingFocusOpen | null>(null);
  // Pin ids whose join is still in flight: the gate effect must not close
  // the hub in the beat between the open and the server's answer.
  const joiningRef = useRef(new Set<string>());
  const openInlineHub = useCallback((w: Worktree, mode?: typeof selectedMode, sessionId?: string, soft = false) => {
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
    setOpenSoft(soft);
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
  const { showDock } = useHubDisplayPreferences();
  // The sidebar's state lives in lib/sidebarStore, outside this component, so
  // a toggle re-renders only the sidebar and the open buttons. Mounting
  // re-reads what was persisted (hidden until asked for, ⌘B: the Dock at the
  // bottom is all a day needs).
  useState(loadSidebarCollapsed);
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
    setJarvisOpen(false);
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
  // Settings › Projects › this one (a repo id), from a deep link.
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  // A runner's host page to open inside Settings → Runners, from a deep link.
  const [settingsHost, setSettingsHost] = useState<{ runnerId: string; tab?: HostTab } | undefined>(undefined);
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
      const detail = (e as CustomEvent<{ section?: 'gitlab' | 'github' | 'runners'; runnerId?: string; tab?: HostTab }>).detail;
      const section = detail?.section ?? 'gitlab';
      setSettingsHost(section === 'runners' && detail?.runnerId ? { runnerId: detail.runnerId, tab: detail.tab } : undefined);
      setSettingsSection(section);
      setSettingsNonce((n) => n + 1);
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
  // Every agent/shell tab with its calls to you: the Dock, Mission Control and the call notifier.
  const { stations, orphanCalls, loaded: stationsLoaded } = useStations(wsId);
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
  // distinguishes "no calls were open before" from "we haven't seen a
  // snapshot yet", so the first load never fires a notification for calls
  // already open. Reset on every workspace switch — declared ahead of the
  // notification effect below — so the new workspace's first snapshot also
  // seeds silently instead of firing for everything already open there.
  const prevOpenCalls = useRef<Set<string> | null>(null);
  useEffect(() => {
    prevOpenCalls.current = null;
  }, [wsId]);
  useEffect(() => {
    if (!stationsLoaded) return;
    const label = (p: string) => state.worktrees.find((w) => w.path === p)?.meta?.ticketId ?? p.split('/').pop() ?? p;
    const { seen, fire } = nextSeenCalls(prevOpenCalls.current, stations, label, orphanCalls);
    prevOpenCalls.current = seen;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const n of fire) {
      const worktree = state.worktrees.find((w) => w.path === n.path);
      const notification = new Notification(n.title, n.body ? { body: n.body } : undefined);
      notification.onclick = () => {
        window.focus();
        // Its tab, as before, and its pill in the strip: the box is ready for the reply.
        // An orphan call (its asker's tab closed) has neither: its line sits above the strip.
        if (worktree && n.mode && n.sessionId) openInlineHub(worktree, n.mode as typeof selectedMode, n.sessionId);
        if (n.agentId) selectAgentRef.current(n.agentId);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, orphanCalls, stationsLoaded]);

  // The sidebar is where the user left it, everywhere (home included): only
  // their own toggle changes it (⌘B, its buttons, the box's "hide the
  // sidebar"). A hub closing itself (its last session gone) must not hide it.
  // It toggles in one frame, as Warp's does: no slide (a slide made every
  // terminal beside it hold, clip and refit mid-motion, which read as
  // shaking). The store declares each toggle a layout jump, so terminals fit
  // in that same frame and tell the pty at once.

  // Collapsed, the sidebar's space chord stands down, while the shell keeps
  // intercepting the chord inside embeds and forwarding it — so this one
  // switches straight over (CollapsedSpaceShortcut, below).
  const moveSpace = (dir: -1 | 1) => {
    const i = allWorkspaces.findIndex((w) => w.id === wsId);
    const target = i === -1 ? undefined : allWorkspaces[i + dir];
    if (!target) return;
    Promise.resolve(switchTo(target.id)).catch((err: unknown) =>
      dispatch({ type: 'error', message: `Could not switch to that workspace: ${(err as Error).message}` }),
    );
  };

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
    // Shortcuts pressed inside an embed (the Browser preview view)
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
  // mode: the hover card's Files button; otherwise the hub restores the worktree's last tab.
  const openRemoteWorktree = useCallback((w: RemoteWorktree, mode?: 'files') => {
    const gate = focusGateRef.current();
    if (gate !== 'open') {
      pendingFocusOpenRef.current = { kind: 'remote', w, mode };
      if (gate === 'ask') window.dispatchEvent(new CustomEvent(NEW_FOCUS_EVENT, { detail: { seedPinId: `remote:${w.runnerId}:${w.path}` } }));
      return;
    }
    noteOpenedRef.current(`remote:${w.runnerId}:${w.path}`);
    // A local open's mode must not carry over onto this hub.
    setSelectedMode(mode);
    setSelectedSessionId(undefined);
    setOpenSeq((n) => n + 1);
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
  // Jarvis needs a Focus; which Focus has it open is kept for this window.
  useEffect(() => {
    if (focusApi.loaded && !focusApi.active) setJarvisOpen(false);
  }, [focusApi.loaded, focusApi.active]);
  useEffect(() => {
    const id = focusApi.activeId;
    if (id && restoredForRef.current === id) writeJarvisOpen(id, jarvisOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jarvisOpen]);
  // The other Focuses' rows: approvals waiting and unread replies, refreshed on the stations feed's events.
  const jarvisBadges = useFocusJarvisBadges(wsId, focusApi.focuses, focusApi.activeId, stations);
  // With a Focus active, the main area is never the global home: nothing else
  // open means its Jarvis chat. Home is for when no Focus is active.
  const hubOpen = !!selectedRemote || !!(selectedPath && state.worktrees.some((w) => w.path === selectedPath));
  const chatShown = !!focusApi.active && !hubOpen && (jarvisOpen || activeView.kind === 'worktrees');
  const onHome = !chatShown && !hubOpen && activeView.kind === 'worktrees' && !state.loading && state.repos.length > 0
    && !focusApi.active && (focusApi.loaded || !focusApi.activeId);
  // Until the list loads, a stored active Focus means its view is coming: no home flash.
  const focusPending = !focusApi.loaded && !!focusApi.activeId;
  // The empty chat's starting points: the Focus's own recent worktrees, or ways to fill a blank one.
  const [addingToFocus, setAddingToFocus] = useState(false);
  const jarvisStart: JarvisStart | undefined = focusApi.active ? {
    recent: recentInFocus(focusApi.active.members, state.worktrees, state.repos, readWorktreeLru()),
    onOpenRecent: (w) => openInlineHub(w),
    onAddWorktrees: () => setAddingToFocus(true),
    onNewWorktree: () => props.onNewWorktree(undefined, focusApi.active?.ticket),
  } : undefined;
  const openJarvis = () => {
    setSelectedRemote(null);
    setSelectedPath(null);
    setJarvisOpen(true);
  };
  // A card in the chat opens its tab: the worktree's hub on that session.
  const openJarvisCard: OpenCard = (r) => {
    const w = state.worktrees.find((x) => x.path === r.worktreePath);
    if (w) openInlineHub(w, r.mode, r.sessionId);
  };
  // ⌘[ / ⌘]: where you are, as a place in the workspace's history (lib/navHistory).
  const navPlace: Place | null = !focusApi.loaded && !!focusApi.activeId ? null
    : selectedRemote ? { kind: 'remote', focusId: focusApi.activeId, runnerId: selectedRemote.runnerId, path: selectedRemote.path }
    : hubOpen && selectedPath ? {
      kind: 'hub', focusId: focusApi.activeId, path: selectedPath,
      ...(hubTab && hubTab.path === selectedPath ? { tab: { mode: hubTab.mode, id: hubTab.id } } : {}),
    }
    : activeView.kind !== 'worktrees' ? { kind: 'page', page: activeView.kind }
    : chatShown && focusApi.activeId ? { kind: 'jarvis', focusId: focusApi.activeId }
    : { kind: 'home' };
  const navFocusOk = (id: string | null) => id === null || focusApi.focuses.some((f) => f.id === id);
  useAppHistory({
    scope: wsId,
    place: navPlace,
    valid: (p) => {
      if (p.kind === 'hub') return navFocusOk(p.focusId) && state.worktrees.some((w) => w.path === p.path);
      if (p.kind === 'remote') return navFocusOk(p.focusId) && remote.worktrees.some((w) => w.runnerId === p.runnerId && w.path === p.path);
      if (p.kind === 'jarvis') return navFocusOk(p.focusId);
      return true;
    },
    go: (p) => {
      if (p.kind === 'page') { selectView({ kind: p.page }); return; }
      if (p.kind === 'home') { selectView(INITIAL_VIEW); setJarvisOpen(false); return; }
      // Another Focus: leave it set to come back to this place, then switch; its restore opens it.
      if (p.focusId && p.focusId !== focusApi.activeId) {
        writeJarvisOpen(p.focusId, p.kind === 'jarvis');
        if (p.kind === 'hub') writeSelPath(p.focusId, p.path);
        focusApi.activate(p.focusId);
        return;
      }
      if (p.kind === 'jarvis') { setActiveView(INITIAL_VIEW); openJarvis(); return; }
      if (p.kind === 'remote') {
        const w = remote.worktrees.find((x) => x.runnerId === p.runnerId && x.path === p.path);
        if (w) openRemoteWorktree(w);
        return;
      }
      const w = state.worktrees.find((x) => x.path === p.path);
      if (w) openInlineHub(w, p.tab?.mode as typeof selectedMode, p.tab?.id, true);
    },
  });
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
    else openRemoteWorktree(pending.w, pending.mode);
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
      // A blank Focus is only its Jarvis; one left on Jarvis in this window comes back to it.
      if (active.members.length === 0 || readJarvisOpen(active.id)) {
        setSelectedRemote(null);
        setSelectedPath(null);
        setJarvisOpen(true);
        return;
      }
      setJarvisOpen(false);
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
      // No saved view: nothing is selected, so the main area shows its Jarvis (chatShown).
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
  // ---------- Mission Control: the agent strip and the box's selected agent ----------
  // The strip shows the open Focus's agents (plus any outside one that needs you); no Focus: the workspace's.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  useEffect(() => { setSelectedAgent(null); }, [wsId]);
  const openAgentRef = useRef<((agentId: string) => void) | null>(null);
  const missionShellRef = useRef<MissionBoxDeps['shell'] | null>(null);
  // The bar's mission stack height: its popover opens above all of it (the strip stays visible).
  const [stackHeight, setStackHeight] = useState(0);
  // A repo's run-command editor (from the Worktrees page's repo menu).
  const missionScoped = useMemo(
    () => missionStations(stations, 'focus', focusWorktreesOf(focusApi.active ?? null)),
    [stations, focusApi.active],
  );
  // Selecting = the agent's @chip at the start of the box (the box reports it back).
  const selectAgent = (id: string | null) => {
    const s = id ? stations.find((x) => x.agentId === id) : null;
    commandBarRef.current?.selectAgent(s ? { agentId: s.agentId, label: chipLabel({ name: s.name, alias: s.alias, worktreeName: s.worktreeName, inThisWorktree: s.worktreePath === selectedPath }) } : null);
  };
  // A notification fires from an effect: it reads the latest selectAgent, not its render's.
  const selectAgentRef = useRef(selectAgent);
  selectAgentRef.current = selectAgent;
  // "Who needs me?" (home's waiting count): the first agent calling you, in the strip's order.
  // Only orphan calls (no pill to select): their lines are already above the strip.
  const selectFirstNeedsYou = () => {
    const first = [...missionScoped, ...stations].find((st) => lightOf(st) === 'calling');
    if (first) selectAgent(first.agentId);
    focusCommandBar();
  };
  const missionServer = jarvisServerPort(wsId);
  const missionBox = useMissionBox({
    wsId,
    stations: missionScoped,
    selectedAgentId: selectedAgent,
    onSelect: selectAgent,
    openAgent: (id) => openAgentRef.current?.(id),
    message: (id, text) => missionServer.message(id, text),
    interrupt: (id) => api.intercom.interrupt(wsId, id),
    recap: missionServer.recap ? (ids) => missionServer.recap!(ids) : undefined,
    dismissCall: (ws, id) => api.intercom.escalations.dismiss(ws, id),
    answerCall: (ws, id, text) => api.intercom.escalations.resolve(ws, id, text),
    shell: {
      risk: (id, c) => missionShellRef.current?.risk(id, c) ?? null,
      run: (id, c) => missionShellRef.current?.run(id, c) ?? Promise.reject(new Error('The box is not ready')),
      interrupt: (id) => missionShellRef.current?.interrupt(id) ?? Promise.reject(new Error('The box is not ready')),
    },
  });
  // One strip: the hub's tab bar, only this worktree's tabs, each wearing its
  // agent's state. The box keeps only the selected agent's line, while its chip leads.
  const hubMission = {
    stations,
  };
  const agentStrip = missionBox.line
    ? <div data-testid="selected-agent-line" className="min-w-0 px-2 py-0.5">{missionBox.line}</div>
    : null;
  // In the bar it reports its height, so the popover opens above it (home's popover opens below the box).
  const orphanLines = <OrphanCalls calls={orphanCalls} onDismiss={(id) => api.intercom.escalations.dismiss(wsId, id)} />;
  const missionStack = (inBar: boolean) => <MissionStack onHeight={inBar ? setStackHeight : undefined} approvals={orphanLines} strip={agentStrip} />;
  // The chip names the project too: "master" alone doesn't say which repo.
  const repoNameOf = (id: string | null | undefined) => (id ? state.repos.find((r) => r.id === id)?.name ?? null : null);
  const dockWorktree = selectedRemote
    ? { repo: repoNameOf(selectedRemote.localRepoId) ?? selectedRemote.remoteRepoName ?? null, name: selectedRemote.branch ?? selectedRemote.name, branch: null }
    : selectedWorktree
      ? { repo: repoNameOf(selectedWorktree.repoId), name: selectedWorktree.meta?.ticketId || selectedWorktree.branch || selectedWorktree.path.split('/').pop() || selectedWorktree.path, branch: selectedWorktree.branch ?? null }
      : null;

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
  // What is serving right now, in the sidebar's bottom bar beside Usage, so the
  // answer is the same wherever you are. Opening a row lands on the preview tab
  // in the desktop app; the web build has no embedded browser, so it opens the
  // hub's shell instead.
  const runningServers = (
    <RunningServers
      worktrees={state.worktrees}
      onOpen={(w) => openInlineHub(w, typeof window !== 'undefined' && window.strado ? 'browser' : 'shell')}
      onStop={handleStop}
      onKillExternal={handleKillExternal}
      placement="up"
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
      if (page === 'home') selectView(INITIAL_VIEW);
      else selectView({ kind: page });
    },
    settings: (section, projectPath) => {
      setSettingsProject(projectPath ? state.repos.find((r) => r.path === projectPath)?.id ?? null : null);
      setSettingsSection(section);
      setSettingsNonce((n) => n + 1);
    },
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
    sidebar: (show) => setSidebarCollapsed(!(show ?? getSidebarCollapsed())),
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
      // Bottom bar hidden: ⌘K opens the bar as a dialog mid-window, results below it.
      dropDown={!hero && !showDock}
      stations={stations}
      mission={{ stations: missionScoped, openRef: openAgentRef, shellRef: missionShellRef }}
      agentKey={missionBox.agentKey}
      onAgentChip={setSelectedAgent}
      popoverLift={hero ? 0 : stackHeight + 4 /* the stack row's pt-1 */}
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
    <FocusJarvisProvider wsId={wsId} focus={focusApi.active ?? null} focuses={focusApi.focuses} worktrees={state.worktrees} repos={state.repos}
      workspaces={allWorkspaces} stations={stations} lastActedOn={jarvisLastActed}
      chatOpen={chatShown}
      onTreeChanged={() => {
        void Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)])
          .then(([repos, worktrees]) => { if (wsRef.current === wsId) commitTree(repos, worktrees); })
          .catch(() => { /* the 15 s re-sync catches up */ });
      }}>
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-200">
      {/* Settings is a modal over the app, which stays in view behind it. */}
      <div className="flex min-w-0 flex-1" aria-hidden={settingsSection ? true : undefined}>
      <CollapsedSpaceShortcut move={moveSpace} />
      <div className="contents">
        <LiveSidebar
          repos={state.repos}
          worktrees={state.worktrees}
          remoteWorktrees={remote.worktrees}
          runnerStatuses={remote.runners}
          remoteLoading={remoteLoading}
          onDeleteRemoteWorktree={(w) => props.onDeleteRemoteWorktree?.(w)}
          onRebuildSandbox={(w) => props.onRebuildSandbox?.(w)}
          onOpenRemoteWorktree={openRemoteWorktree}
          // Home is no page: nothing in the page row is current there.
          // A worktree's tabs are open: no page is current (the rail shows which worktree).
          selected={onHome || chatShown || selectedRemote || selectedWorktree ? null : activeView}
          onSelect={selectView}
          onSwitchError={(message) => dispatch({ type: 'error', message })}
          onOpenSettings={() => setSettingsSection('profile')}
          running={runningServers}
          onCollapse={() => setSidebarCollapsed(true)}
          onAddRepo={(anchor) => {
            setAddRepoAnchor(anchor ?? null);
            setShowAddRepo(true);
          }}
          onOpenWorktree={(w, mode, sessionId) => openInlineHub(w, mode, sessionId)}
          onOpenMr={props.onOpenMr}
          onOpenDiff={props.onOpenDiff}
          activeWorktreePath={selectedRemote?.path ?? selectedPath}
          onNewWorktree={(ticket) => props.onNewWorktree(undefined, ticket)}
          onWorktreeSettings={(w) => props.onMenu(w)}
          onProjectSettings={(repoId) => { setSettingsProject(repoId); setSettingsSection('projects'); setSettingsNonce((n) => n + 1); }}
          onDeleteWorktree={(w) => props.onDeleteWorktree(w)}
          update={props.update}
          // The open Focus's header is its Jarvis: status, click to open the chat.
          jarvis={{ status: <FocusJarvisStatus />, selected: chatShown, onOpen: openJarvis }}
          jarvisBadges={jarvisBadges}
          // A Focus opened from its row lands on its Jarvis chat (the restore below reads this).
          onOpenFocus={(id) => writeJarvisOpen(id, true)}
        />
        </div>

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
              openSoft={openSoft}
              onActiveTab={setHubTab}
              onClose={() => setSelectedRemote(null)}
              onExpandSidebar={() => setSidebarCollapsed(false)}
              modalOpen={modalOpen}
              mission={hubMission}
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
              openSoft={openSoft}
              onActiveTab={setHubTab}
              onClose={() => setSelectedPath(null)}
              onExpandSidebar={() => setSidebarCollapsed(false)}
              modalOpen={modalOpen}
              mission={hubMission}
            />
          </div>
        ) : chatShown ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* The window's grab strip, as on home and the worktree view. */}
            <div data-testid="jarvis-drag" className="app-drag flex h-11 shrink-0 items-center gap-2 px-3">
              <OpenSidebarButton />
            </div>
            <div className="flex min-h-0 flex-1">
              <FocusJarvisMain onOpenCard={openJarvisCard} start={jarvisStart} />
            </div>
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
            onExpandSidebar={() => setSidebarCollapsed(false)}
          />
        ) : activeView.kind === 'usage' ? (
          <UsagePage
            key={wsId}
            wsId={wsId}
            onExpandSidebar={() => setSidebarCollapsed(false)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {state.loading || focusPending ? (
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
              <HomeScreen
                bar={settingsSection ? null : commandBar(true)}
                strip={settingsSection ? null : missionStack(false)}
                recent={recentWorktrees(state.worktrees, state.repos, readWorktreeLru())}
                waiting={stations.filter((st) => lightOf(st) === 'calling').length + orphanCalls.length}
                onOpenRecent={(w) => openInlineHub(w)}
                onAddRepo={() => { setAddRepoAnchor(null); setShowAddRepo(true); }}
                onNewWorktree={() => props.onNewWorktree()}
                onWaiting={selectFirstNeedsYou}
                onExpandSidebar={() => setSidebarCollapsed(false)}
              />
              </>
            )}
          </div>
        )}
        {!onHome && !settingsSection && (
          // With the bottom bar hidden and nothing in the stack, no rule or padding is left behind.
          <div data-testid="mission-stack-row" className={`dock-panel shrink-0 ${!showDock && stackHeight === 0 ? '' : 'border-t border-white/[0.07] pt-1'}`}>{missionStack(true)}</div>
        )}
        <Dock
          worktree={dockWorktree}
          focus={focusApi.active?.name ?? null}
          bare={onHome}
          collapsed={!showDock}
        >
        {onHome || settingsSection ? null : commandBar(false)}
        </Dock>
      </main>
      </div>


      {settingsSection && (
        <SettingsPage
          key={`${settingsSection}:${settingsNonce}`}
          section={settingsSection}
          host={settingsSection === 'runners' ? settingsHost : undefined}
          project={settingsSection === 'projects' ? settingsProject : null}
          projects={{
            repos: state.repos,
            worktrees: state.worktrees,
            onAdd: () => { setAddRepoAnchor(null); setShowAddRepo(true); },
            onPatch: async (repo, patch) => {
              await api.repos.patch(wsId, repo.id, patch);
              commitTree(await api.repos.list(wsId), state.worktrees);
            },
            onSaveRunCommands: async (repo, list) => {
              try {
                await api.repos.setRunCommands(wsId, repo.id, list);
                commitTree(await api.repos.list(wsId), state.worktrees);
              } catch (err) {
                throw new Error(runCommandsError(err));
              }
            },
            onRemove: async (repo) => {
              await api.repos.remove(wsId, repo.id);
              const [repos, worktrees] = await Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]);
              commitTree(repos, worktrees);
            },
            onDeleteWorktree: (w) => props.onDeleteWorktree(w),
          }}
          bottomInset={showDock}
          onClose={() => { setSettingsSection(null); setSettingsHost(undefined); setSettingsProject(null); }}
          onJiraConnected={() => {
            track('jira_connected');
            refreshTicketProviders();
          }}
          onOpenFeedback={() => setFeedbackOpen(true)}
          // Install types into a new shell in the worktree open behind Settings
          // (this Mac's only: a runner's hub has its own machine).
          lspInstall={selectedWorktree && !selectedRemote ? {
            label: worktreeLabel(selectedWorktree),
            run: (command) => {
              setSettingsSection(null);
              requestRunInShell({ worktreePath: selectedWorktree.path, command });
            },
          } : null}
        />
      )}
      {settingsSection && (
        // Follows Settings › Appearance › Show bottom bar: hidden, ⌘K opens it as the same mid-window dialog.
        <div className={`fixed inset-x-0 bottom-0 z-[60] bg-zinc-950 ${showDock ? 'border-t border-zinc-900' : ''}`}
          data-testid="settings-command-bar" data-collapsed={!showDock || undefined}>
          <Dock worktree={dockWorktree} focus={focusApi.active?.name ?? null} collapsed={!showDock}>
            {commandBar(false)}
          </Dock>
        </div>
      )}

      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        context={activeView.kind}
      />

      {addingToFocus && focusApi.active && (
        <AddWorktreesDialog focus={focusApi.active} repos={state.repos} worktrees={state.worktrees} remoteWorktrees={remote.worktrees}
          onAdd={(ids) => void focusApi.addMembers(focusApi.active!.id, ids).catch((err: Error) => dispatch({ type: 'error', message: `Could not add to ${focusApi.active?.name ?? 'focus'}: ${err.message}` }))}
          onClose={() => setAddingToFocus(false)} />
      )}
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
    </FocusJarvisProvider>
    </RendererOverlayContext.Provider>
    </UiControlProvider>
  );
}

// The sidebar with its live collapsed state: only this re-renders on a toggle.
function LiveSidebar(props: Omit<React.ComponentProps<typeof Sidebar>, 'hidden'>) {
  const hidden = useSidebarCollapsed();
  return <Sidebar {...props} hidden={hidden} />;
}

// The workspace switch chord while the sidebar (whose own chord stands down) is collapsed.
function CollapsedSpaceShortcut({ move }: { move: (dir: -1 | 1) => void }) {
  useSpaceShortcut(move, useSidebarCollapsed());
  return null;
}
