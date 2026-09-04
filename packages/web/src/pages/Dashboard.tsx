import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, type RemoteWorktree, type RunnerStatus, type TicketProviderId } from '../api';
import { subscribeWorktrees, worktreesReducer } from '../eventStream';
import { computeClaudeNotifications, snapshotStatuses, type ClaudeStatusMap } from '../hooks/claudeNotifications';
import { playDoneBeep } from '../lib/beep';
import type { MergeRequest, RepoConfig, Worktree, WorkflowStatus } from '../types';
import { OnboardingCard } from '../components/OnboardingCard';
import { AddRepoDialog, type AddRepoAnchor } from '../components/AddRepoDialog';
import { Sidebar, type SidebarView } from '../components/Sidebar';
import type { UpdateFooterProps } from '../components/UpdateFooter';
import { FilterBar } from '../components/FilterBar';
import { publishTickets, providerLabel, useTickets } from '../hooks/tickets';
import { isRunning } from '../hooks/filters';
import { RunningServers } from '../components/RunningServers';
import { OnboardingWelcome } from '../components/OnboardingWelcome';
import { OnboardingChecklist } from '../components/OnboardingChecklist';
import { SettingsModal, type SettingsSection } from '../components/settings/SettingsModal';
import { FeedbackDialog } from '../components/FeedbackDialog';
import { CommandPalette } from '../components/CommandPalette';
import { useColumnWidths } from '../hooks/useColumnWidths';
import { useDensity } from '../hooks/useDensity';
import { useBoardPrefs } from '../hooks/boardPrefs';
import { useWorkspace } from '../hooks/useWorkspace';
import { useSpaceShortcut } from '../hooks/spaceShortcut';
import { TaskBoard } from '../components/TaskBoard';
import { computeReorderPatches } from '../hooks/rowOrder';
import { bumpWorktreeOpened } from '../lib/worktreeLru';
import { rememberClosedAgent } from '../hooks/agentTabs';
import { track } from '../telemetry';
import { TerminalView } from './TerminalView';
import { CodeReviewsPage } from '../components/CodeReviewsPage';
import { UsagePage } from '../components/usage/UsagePage';
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

const STORE_SIDEBAR = 'strado:sidebar-collapsed';

// Tasks remains the initial destination; code reviews is the second
// workspace-level view. We intentionally do not restore the old retired view
// values from `strado:view`.
const INITIAL_VIEW: SidebarView = { kind: 'tasks' };
function readSidebarCollapsed(): boolean {
  return localStorage.getItem(STORE_SIDEBAR) === '1';
}

// Per-workspace memory of the open worktree, so swiping between workspaces
// restores what each had open (the tab WITHIN a worktree is already remembered
// per-worktree by TerminalView). A map keyed by workspace id — a bare string
// here would be one global selection shared across every workspace, which is
// why a swipe used to land on the dashboard. Remote hubs aren't persisted yet.
const STORE_SELECTED = 'strado:selected-by-ws';
function readSelMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(STORE_SELECTED) || '{}') as Record<string, string>; }
  catch { return {}; }
}
function writeSelPath(wsId: string, path: string | null): void {
  try {
    const map = readSelMap();
    if (path) map[wsId] = path; else delete map[wsId];
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
  onNewWorktree: (repoId?: string) => void;
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
  const [selectedPath, setSelectedPath] = useState<string | null>(() => readSelMap()[wsId] ?? null);
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
  // The workspace the on-screen selection belongs to. Updated only on a
  // deliberate restore/switch, so the persist effect writes under the right
  // workspace and a mid-switch stale selection can't land under the new one.
  const selWsRef = useRef(wsId);
  // Persist the open worktree under its workspace (remote hubs store nothing).
  useEffect(() => {
    writeSelPath(selWsRef.current, selectedRemote ? null : selectedPath);
  }, [selectedPath, selectedRemote]);
  // Restore that workspace's open worktree when the workspace changes (swipe,
  // ⌘K). A generic open (mode undefined) lets TerminalView reopen the
  // worktree's last-active tab. Runs on mount too — a no-op there, since
  // useState already seeded selectedPath from the same store. A ⌘K deep-link to
  // another workspace overrides this via the pendingOpenRef effect below, which
  // runs after it.
  useEffect(() => {
    selWsRef.current = wsId;
    setSelectedMode(undefined);
    setSelectedSessionId(undefined);
    setSelectedRemote(null);
    setSelectedPath(readSelMap()[wsId] ?? null);
  }, [wsId]);
  const openInlineHub = useCallback((w: Worktree, mode?: typeof selectedMode, sessionId?: string) => {
    track('hub_opened', { tab: mode ?? 'restored' });
    // Record the open so the ⌘K palette can rank recently-used worktrees on top.
    bumpWorktreeOpened(w.path);
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
  const [showPalette, setShowPalette] = useState(false);
  const [density, setDensity] = useDensity();
  const [boardPrefs, patchBoardPrefs] = useBoardPrefs(wsId);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readSidebarCollapsed());
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('strado:expanded-repos') || '[]')); }
    catch { return new Set(); }
  });
  useEffect(() => {
    localStorage.setItem('strado:expanded-repos', JSON.stringify([...expandedRepos]));
  }, [expandedRepos]);
  const toggleRepo = (repoId: string) =>
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      next.has(repoId) ? next.delete(repoId) : next.add(repoId);
      return next;
    });
  const { gridTemplate, totalWidth, startResize } = useColumnWidths();
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
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [addRepoAnchor, setAddRepoAnchor] = useState<AddRepoAnchor | null>(null);
  // Full-screen renderer overlays can be owned here or one level up in App.
  // The Browser preview and its DevTools are native WebContentsViews, so they
  // have to be parked off-screen while any of these is visible.
  const modalOpen = !!(
    props.modalOpen || showPalette || settingsSection || feedbackOpen || showAddRepo
  );
  const [welcomed, setWelcomed] = useState(() => localStorage.getItem('strado:onboarding-welcomed') === '1');
  const [checklistDismissed, setChecklistDismissed] = useState(
    () => localStorage.getItem('strado:onboarding-dismissed') === '1',
  );
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
        if (worktree) openInlineHub(worktree, n.mode, n.sessionId);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.worktrees]);

  useEffect(() => {
    localStorage.setItem(STORE_SIDEBAR, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

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
  }, sidebarCollapsed);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      // ⌘B: left sidebar
      if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette((p) => !p);
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
      if (combo === 'palette') setShowPalette((p) => !p);
      else if (combo === 'settings') setSettingsSection('profile');
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      offHotkey?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep palette telemetry separate from native-view suppression; the latter
  // is passed directly to TerminalView together with every other modal.
  useEffect(() => {
    if (showPalette) track('palette_used');
  }, [showPalette]);

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

  const repoById = useMemo(() => {
    const map = new Map<string, RepoConfig>();
    for (const r of state.repos) map.set(r.id, r);
    return map;
  }, [state.repos]);

  const selectedWorktree = selectedPath ? state.worktrees.find((w) => w.path === selectedPath) ?? null : null;

  // The rail spans machines: local worktrees plus every runner's, mapped to the
  const handleStart = async (w: Worktree) => {
    track('dev_server_started');
    try {
      await api.worktrees.start(wsId, w.path);
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  };
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
  // One element, rendered in both toolbars — the board's and the hub's — so the
  // "what is serving right now" answer is the same wherever you are. Opening a
  // row lands on the preview tab in the desktop app; the web build has no
  // embedded browser, so it opens the hub's shell instead.
  const runningServers = (
    <RunningServers
      worktrees={state.worktrees}
      onOpen={(w) => openInlineHub(w, typeof window !== 'undefined' && window.strado ? 'browser' : 'shell')}
      onStop={handleStop}
      onKillExternal={handleKillExternal}
    />
  );
  const hasRunningServers = state.worktrees.some(isRunning);

  const handleSetEnvProfile = async (w: Worktree, profile: string) => {
    const wasRunning = w.process.status === 'running' || w.process.status === 'starting';
    if (w.process.external) {
      alert(
        'An external (non-managed) process is running for this worktree. Kill it first, then switch the env.',
      );
      return;
    }
    if (!w.tracked) {
      alert('Adopt this worktree first (via the More menu) before switching env profile.');
      return;
    }
    if (wasRunning && !confirm(`Switch env to "${profile}"? This will restart the running process.`)) {
      return;
    }
    dispatch({ type: 'patchMeta', path: w.path, patch: { activeEnvProfile: profile } });
    try {
      await api.worktrees.setEnvProfile(wsId, w.path, profile);
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  };

  const handleSetWorkflowStatus = (w: Worktree, status: WorkflowStatus | null) => {
    dispatch({ type: 'patchMeta', path: w.path, patch: { workflowStatus: status } });
    api.worktrees.patch(wsId, w.path, { workflowStatus: status }).catch((err) =>
      dispatch({ type: 'error', message: (err as Error).message }),
    );
  };

  const handleReorder = (contextRows: Worktree[], draggedPath: string, targetPath: string, place: 'before' | 'after') => {
    for (const { path, order } of computeReorderPatches(contextRows, draggedPath, targetPath, place)) {
      dispatch({ type: 'patchMeta', path, patch: { order } });
      api.worktrees.patch(wsId, path, { order }).catch((err) =>
        dispatch({ type: 'error', message: (err as Error).message }),
      );
    }
  };

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

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-200">
      {!sidebarCollapsed && (
        <Sidebar
          repos={state.repos}
          worktrees={state.worktrees}
          remoteWorktrees={remote.worktrees}
          runnerStatuses={remote.runners}
          remoteLoading={remoteLoading}
          onDeleteRemoteWorktree={(w) => props.onDeleteRemoteWorktree?.(w)}
          onOpenRemoteWorktree={(w) => {
            setSelectedPath(null); // one hub at a time
            setSelectedRemote(w);
            props.onOpenRemoteWorktree?.(w);
          }}
          selected={activeView}
          onSelect={selectView}
          onSwitchError={(message) => dispatch({ type: 'error', message })}
          onOpenSettings={() => setSettingsSection('profile')}
          onOpenOrgSettings={() => setSettingsSection('organization')}
          onOpenFeedback={() => setFeedbackOpen(true)}
          taskCount={state.worktrees.length}
          reviewCount={codeReviews.counts.open}
          reviewLoading={codeReviews.loading && codeReviews.repositories.length === 0}
          onCollapse={() => setSidebarCollapsed(true)}
          onAddRepo={(anchor) => {
            setAddRepoAnchor(anchor ?? null);
            setShowAddRepo(true);
          }}
          onDeleteRepo={async (repo) => {
            if (!confirm(`Remove "${repo.name}" from this workspace? Worktrees on disk are left untouched.`)) return;
            try {
              await api.repos.remove(wsId, repo.id);
              const [repos, worktrees] = await Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]);
              commitTree(repos, worktrees);
            } catch (err) {
              dispatch({ type: 'error', message: (err as Error).message });
            }
          }}
          expandedRepos={expandedRepos}
          onToggleRepo={toggleRepo}
          onOpenWorktree={(w, mode, sessionId) => openInlineHub(w, mode, sessionId)}
          onOpenMr={props.onOpenMr}
          onOpenDiff={props.onOpenDiff}
          activeWorktreePath={selectedRemote?.path ?? selectedPath}
          onNewWorktreeForRepo={(repo) => props.onNewWorktree(repo.id)}
          onWorktreeSettings={(w) => props.onMenu(w)}
          onDeleteWorktree={(w) => props.onDeleteWorktree(w)}
          update={props.update}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Code reviews carries the sidebar toggle and running-servers chip in
            its own toolbar, so the shared row would only be an empty strip. */}
        {!(state.repos.length === 0 && !state.loading) && !selectedWorktree && !selectedRemote
          && activeView.kind !== 'reviews' && activeView.kind !== 'usage' && (sidebarCollapsed || hasRunningServers) && (
        <FilterBar
          leading={
            sidebarCollapsed ? (
              <button
                aria-label="Open sidebar"
                title="Open sidebar (⌘B)"
                onClick={() => setSidebarCollapsed(false)}
                className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              >
                »
              </button>
            ) : undefined
          }
          trailing={runningServers}
        />
        )}

        {state.error && (
          <div className="mx-4 mt-3 rounded bg-red-900/40 px-3 py-2 text-sm text-red-200">{state.error}</div>
        )}

        {activeView.kind === 'tasks' && !state.loading && state.repos.length > 0 && !checklistDismissed && (
          <OnboardingChecklist
            repos={state.repos}
            worktrees={state.worktrees}
            jiraOn={ticketsOn}
            onNewWorktree={props.onNewWorktree}
            onOpenJiraSettings={() => setSettingsSection('jira')}
            onDismiss={() => {
              localStorage.setItem('strado:onboarding-dismissed', '1');
              setChecklistDismissed(true);
            }}
          />
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
        <div className="flex-1 overflow-auto">
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
              <TaskBoard
                wsId={wsId}
                worktrees={state.worktrees}
                repoById={repoById}
                gridTemplate={gridTemplate}
                totalWidth={totalWidth}
                onStartResize={startResize}
                density={density}
                onReorder={handleReorder}
                prefs={boardPrefs}
                onPrefs={patchBoardPrefs}
                handlers={{
                  onOpenShellTerminal: (w) => openInlineHub(w, 'shell'),
                  onSetWorkflowStatus: handleSetWorkflowStatus,
                  onOpenNote: props.onOpenNote,
                  onOpenDiff: props.onOpenDiff,
                  onStart: handleStart,
                  onStop: handleStop,
                  onKillExternal: handleKillExternal,
                  onOpenSettings: props.onMenu,
                  onOpenMr: props.onOpenMr,
                }}
              />
            </>
          )}
        </div>
        )}
      </main>

      {showPalette && (
        <CommandPalette
          repos={state.repos}
          worktrees={state.worktrees}
          workspaces={allWorkspaces}
          activeWorkspaceId={wsId}
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
          onGoRepo={(repoId) => { setSelectedPath(null); setExpandedRepos((prev) => new Set(prev).add(repoId)); props.onCloseOverlays(); }}
          onSwitchWorkspace={(id) => {
            props.onCloseOverlays();
            void switchTo(id);
          }}
          onClose={() => setShowPalette(false)}
        />
      )}

      {settingsSection && (
        <SettingsModal
          key={settingsSection}
          section={settingsSection}
          onClose={() => setSettingsSection(null)}
          onJiraConnected={() => {
            track('jira_connected');
            refreshTicketProviders();
          }}
          onOpenFeedback={() => setFeedbackOpen(true)}
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
          onAdded={async () => {
            const [repos, worktrees] = await Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]);
            commitTree(repos, worktrees);
          }}
          onClose={() => {
            setShowAddRepo(false);
            setAddRepoAnchor(null);
          }}
        />
      )}

    </div>
  );
}
