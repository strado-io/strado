import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MergeRequest, RepoConfig, WorkflowStatus, Worktree } from '../types';
import { useWorkspace } from '../hooks/useWorkspace';
import { track } from '../telemetry';
import { api } from '../api';
import { subscribeWorktrees } from '../eventStream';
import { useCapabilities } from '../hooks/capabilities';
import { readClosedAgents, rememberClosedAgent } from '../hooks/agentTabs';
import { readVscodeTabs, rememberVscodeTab } from '../hooks/vscodeTabs';
import { readKbTabs, rememberKbTab } from '../hooks/kbTabs';
import { renameSession, sessionNameKey, shellNameKey, useShellNames, type NamedSessionMode } from '../hooks/shellNames';
import { closeVscodeTab } from './vscodeTabClose';
import {
  browserTabLabel, previewKey, readBrowserMeta, readBrowserTabIds, readBrowserTabs,
  readBrowserUrls, rememberBrowserMeta, rememberBrowserTab, rememberBrowserTabIds,
  rememberBrowserUrl,
} from '../hooks/browserTabs';
import { DiffView } from './DiffView';
import { LogPanel } from '../components/LogPanel';
import { ChangesRail } from '../components/ChangesRail';
import { MrReviewModal } from '../components/MrReviewModal';
import { WorkflowStatusSelect } from '../components/WorkflowStatusSelect';
import { TicketStatusSelect } from '../components/TicketStatusSelect';
import { formatActiveTime } from '../components/WorktreeRow';
import { KnowledgeBasePanel } from '../components/KnowledgeBasePanel';
import {
  ArrowLeftIcon, ArrowRightIcon, BookIcon, CameraIcon, ClaudeIcon, ClockIcon,
  CodexIcon, CopyIcon, ExternalIcon, GlobeIcon, LogsIcon, OpencodeIcon, PiIcon,
  PlayIcon, PlusIcon, ReloadIcon, ScreenIcon, ShellIcon, StopIcon, TrashIcon, VsCodeIcon,
} from '../components/hub/icons';
import { PROC_COLOR, type ProcState } from '../components/hub/shared';
import { useTickets, ticketRef } from '../hooks/tickets';
import { applyTabOrder, readActiveTab, readTabOrder, rememberActiveTab, rememberTabOrder, tabKeyOf } from '../hooks/tabOrder';
import { agentTabStatus, shellHostedAgent } from '../hooks/agentTabStatus';
import {
  hasLeaf, leafKeys, pruneLeaves, readPaneLayouts, rememberPaneLayout,
  removeLeaf, replaceLeaf, splitLeaf, withRatio, type PaneNode,
} from '../hooks/paneLayout';
import { localizeRemoteUrl, useRemoteForward } from '../hooks/remoteForward';
import { useHubDisplayPreferences } from '../hooks/useHubDisplayPreferences';
import { XtermPane, type PtyTab, type RemoteTarget } from '../components/XtermPane';
import { readRemoteShells, rememberRemoteShells, type RemoteShell } from '../hooks/remoteShells';
import { useActivityBeacon } from '../hooks/useActivityBeacon';

type Tab = {
  path: string;
  mode: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi' | 'vscode' | 'browser' | 'kb';
  id: string;
  /** Set when this session's pty lives on a runner rather than this machine. */
  remote?: RemoteTarget | null;
};

/**
 * Same tab? The runner is part of the identity: a local Shell 1 and a runner's
 * Shell 1 in the same worktree are different sessions on different machines,
 * and treating them as one makes them share a pane and a focus state.
 */
function sameTab(a: { path: string; mode: string; id: string; remote?: { runnerId: string } | null }, b: typeof a): boolean {
  return (
    a.path === b.path &&
    a.mode === b.mode &&
    a.id === b.id &&
    (a.remote?.runnerId ?? null) === (b.remote?.runnerId ?? null)
  );
}

// One group per worktree that has (or is about to have) live sessions. The
// terminal panel is a workspace-wide session hub: a super tab per group
// ("repo | worktree"), sub tabs for that group's sessions.
type Group = {
  path: string;
  repoName: string;
  label: string;
  claudeOpen: boolean;
  codexOpen: boolean;
  opencodeOpen: boolean;
  piOpen: boolean;
  // Purely client-side: VS Code web is an iframe, not a pty session, so the
  // server never reports it — the tab lives and dies with this panel.
  vscodeOpen: boolean;
  // Electron-only embedded preview (webview) of the worktree's dev server.
  browserOpen: boolean;
  // Extra Browser tabs beyond 1 (client-side, persisted in localStorage).
  browserIds: string[];
  // Client-side, like vscodeOpen: the Knowledge Base tab has no server
  // session — it just renders the worktree's markdown files.
  kbOpen: boolean;
  claudeStatus?: 'idle' | 'working' | 'waiting';
  // Per-session status for multi-session worktrees; id '1' falls back to the
  // aggregate field when absent (older servers).
  claudeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  codexStatus?: 'idle' | 'working' | 'waiting';
  codexStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  opencodeStatus?: 'idle' | 'working' | 'waiting';
  opencodeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  piStatus?: 'idle' | 'working' | 'waiting';
  piStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  serverShellIds: string[];
  // Tabs the user opened locally that the server may not report live yet.
  localShellIds: string[];
  // Agent sessions BEYOND session 1 (which the *Open flag governs, with its
  // user-closed suppression); same server/local split as shells.
  serverClaudeIds: string[];
  localClaudeIds: string[];
  serverCodexIds: string[];
  localCodexIds: string[];
  serverOpencodeIds: string[];
  localOpencodeIds: string[];
  serverPiIds: string[];
  localPiIds: string[];
  /** Set when this group's sessions live on a runner. */
  remote?: RemoteTarget | null;
};

// Extra session ids only — session 1 stays on the agent's *Open flag.
function extraIds(ids: Iterable<string> | undefined): string[] {
  return [...(ids ?? [])].filter((id) => id !== '1');
}

// Tab icons are the mode identity; their COLOR carries status only
// (amber = agent working, blue = needs your input, neutral = idle).
const IDLE_ICON = 'text-zinc-500';
const SHELL_HOST_ICON = { claude: ClaudeIcon, codex: CodexIcon, opencode: OpencodeIcon, pi: PiIcon };
const SHELL_HOST_LABEL = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };

const AGENT_ICON: Record<string, string> = {
  working: 'text-amber-400 animate-pulse',
  waiting: 'text-blue-400',
  idle: IDLE_ICON,
};

// The Browser preview renders as an Electron <webview> (real DevTools, no
// frame restrictions) — the option only exists inside the desktop shell.
// Detect the desktop shell via the preload bridge, NOT the user agent — the
// shell deliberately presents a plain-Chrome UA so OAuth providers don't
// refuse sign-in in previews (sniffing the UA here broke the Browser tab).
const isElectron = typeof window !== 'undefined' && !!window.strado;

function sortIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => Number(a) - Number(b));
}

function rowLabel(w: Pick<Worktree, 'path' | 'branch' | 'meta'>): string {
  return w.meta?.ticketId?.trim() || w.branch || w.path.split('/').pop() || w.path;
}

// Human title stored at create time is a slug; show it readably next to the
// ticket. Empty when absent or when it just echoes the ticket id.
function metaTitle(w: Pick<Worktree, 'meta'>): string {
  const t = w.meta?.title?.trim();
  if (!t) return '';
  const pretty = t.replace(/[-_]+/g, ' ').trim();
  return pretty && pretty !== w.meta?.ticketId?.trim() ? pretty : '';
}

// Favicon with a graceful fallback: some sites' icons 404 or sit behind auth
// (dev environments) — a broken-image glyph looks worse than the globe.
function FaviconIcon({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <GlobeIcon className={IDLE_ICON} />;
  return (
    <img
      src={src}
      alt=""
      onError={() => setBroken(true)}
      className="h-3.5 w-3.5 shrink-0 rounded-[3px]"
    />
  );
}

function groupTabs(
  g: Group,
  shellNames: Record<string, string> = {},
  browserMeta: Record<string, { title?: string; favicon?: string | null }> = {},
  // VS Code is served by the worktree's OWN machine, so on a self-hosted runner
  // its tab must be ABSENT (a runner has no vscode-web) — this flag is false for
  // a remote worktree.
  embeds = true,
  // Shells whose pty lives on a runner. They sit in this worktree's strip
  // alongside local ones — that adjacency is the whole point of the feature.
  remoteShells: RemoteShell[] = [],
  // The Browser preview is rendered by the LOCAL desktop (a WebContentsView
  // pointing at the forwarded 127.0.0.1 URL), not by the worktree's server, so
  // it IS available for a remote worktree — gated separately from VS Code.
  browserEmbeds = embeds,
): { tab: Tab; label: string; icon: React.ReactNode; hint?: string }[] {
  // saved drag order applies at the end, so every consumer (strip, switcher,
  // hotkeys) sees the same sequence
  const agentTabs = <M extends 'claude' | 'codex' | 'opencode' | 'pi'>(
    mode: M,
    open: boolean,
    server: string[],
    local: string[],
    label: string,
    byId: Group['claudeStatusById'],
    aggregate: Group['claudeStatus'],
    Icon: (props: { className?: string }) => React.ReactElement,
  ) => {
    const ids = [...(open ? ['1'] : []), ...sortIds([...server, ...local]).filter((id) => id !== '1')];
    return ids.map((id) => {
      const status = agentTabStatus(id, byId, aggregate) ?? 'idle';
      return {
        tab: { path: g.path, mode, id },
        label: shellNames[sessionNameKey(g.path, mode, id)] ?? (id === '1' ? label : `${label} ${id}`),
        icon: <Icon className={AGENT_ICON[status] ?? IDLE_ICON} />,
      };
    });
  };
  const entries = [
    ...agentTabs('claude', g.claudeOpen, g.serverClaudeIds, g.localClaudeIds, 'Claude', g.claudeStatusById, g.claudeStatus, ClaudeIcon),
    ...agentTabs('codex', g.codexOpen, g.serverCodexIds, g.localCodexIds, 'Codex', g.codexStatusById, g.codexStatus, CodexIcon),
    ...agentTabs('opencode', g.opencodeOpen, g.serverOpencodeIds, g.localOpencodeIds, 'OpenCode', g.opencodeStatusById, g.opencodeStatus, OpencodeIcon),
    ...agentTabs('pi', g.piOpen, g.serverPiIds, g.localPiIds, 'Pi', g.piStatusById, g.piStatus, PiIcon),
    ...sortIds([...g.serverShellIds, ...g.localShellIds]).map((id) => {
      // An agent typed by hand inside a Shell tab takes the tab's icon over
      // for as long as it runs, so the strip says WHICH tab is busy — the
      // plain terminal glyph comes back when the agent exits.
      const hosted = shellHostedAgent(id, {
        claude: g.claudeStatusById, codex: g.codexStatusById,
        opencode: g.opencodeStatusById, pi: g.piStatusById,
      });
      const Icon = hosted ? SHELL_HOST_ICON[hosted.mode] : ShellIcon;
      return {
        tab: { path: g.path, mode: 'shell' as const, id },
        label: shellNames[shellNameKey(g.path, id)] ?? (id === '1' ? 'Shell' : `Shell ${id}`),
        icon: <Icon className={hosted ? AGENT_ICON[hosted.status] : IDLE_ICON} />,
        // the swapped icon needs a name on hover, or a Codex-hosted shell just
        // looks like a mislabelled Codex tab
        hint: hosted ? `${SHELL_HOST_LABEL[hosted.mode]} ${hosted.status}` : undefined,
      };
    }),
    ...remoteShells.map((rs) => ({
      // Labelled by machine, not "Cloud": the user picked a specific runner and
      // the tab has to keep saying which one, because where it runs changes what
      // it can see (its own filesystem, its own git credentials).
      tab: { path: g.path, mode: 'shell' as const, id: rs.id, remote: rs as RemoteTarget },
      label: rs.runnerId.replace(/-[a-z0-9]{4}$/, ''),
      icon: <ShellIcon className={IDLE_ICON} />,
    })),
    ...(g.vscodeOpen && embeds
      ? [{
          tab: { path: g.path, mode: 'vscode' as const, id: '1' },
          label: 'VS Code',
          icon: <VsCodeIcon className={IDLE_ICON} />,
        }]
      : []),
    ...(browserEmbeds ? [...(g.browserOpen ? ['1'] : []), ...g.browserIds.filter((id) => id !== '1')] : []).map((id) => {
      const meta = browserMeta[previewKey(g.path, id)];
      return {
        tab: { path: g.path, mode: 'browser' as const, id },
        // Real-browser tab identity: live page title + favicon (globe until
        // the page reports them).
        label: browserTabLabel(meta?.title, id),
        icon: meta?.favicon ? (
          // keyed by URL so a navigation to a new site retries after a break
          <FaviconIcon key={meta.favicon} src={meta.favicon} />
        ) : (
          <GlobeIcon className={IDLE_ICON} />
        ),
      };
    }),
    ...(g.kbOpen
      ? [{
          tab: { path: g.path, mode: 'kb' as const, id: '1' },
          label: 'Knowledge Base',
          icon: <BookIcon className={IDLE_ICON} />,
        }]
      : []),
  ];
  // A remote group's pty tabs all target the runner. The Browser tab is a LOCAL
  // desktop surface (it renders the forwarded 127.0.0.1 URL), and VS Code/KB are
  // absent on a runner — so none of those get the runner target; only pty modes
  // do.
  const withTarget = g.remote
    ? entries.map((e) =>
        e.tab.mode === 'vscode' || e.tab.mode === 'browser' || e.tab.mode === 'kb'
          ? e
          : { ...e, tab: { ...e.tab, remote: g.remote } },
      )
    : entries;
  return applyTabOrder(readTabOrder(g.path), withTarget);
}

// Docked DevTools pane. A <webview> cannot host the DevTools frontend
// (Electron never injects the embedder binding — the UI loads but every
// panel stays empty on a "stub connection"), so the pane is a main-process
// WebContentsView overlaid on the window. This placeholder reserves the space
// and streams its bounds. Keep it mounted across hub-tab switches so Chromium
// retains the DevTools frontend state (notably the Network request log);
// unmounting is reserved for an explicit DevTools/browser close.
function elementBounds(el: HTMLElement): StradoBounds {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

// Keeps a main-process overlay glued to a placeholder element: resize events
// catch size changes, the interval catches pure position shifts (the overlay
// does not move with the DOM).
function useBoundsSync(
  ref: React.RefObject<HTMLDivElement>,
  send: (b: StradoBounds) => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = '';
    const push = () => {
      const b = elementBounds(el);
      const key = `${b.x}:${b.y}:${b.width}:${b.height}`;
      if (key === last) return;
      last = key;
      send(b);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(push) : null;
    ro?.observe(el);
    window.addEventListener('resize', push);
    const iv = window.setInterval(push, 500);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', push);
      window.clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function DevtoolsDockPane({
  side,
  fraction,
  targetId,
  suppressed,
  onFail,
}: {
  side: 'bottom' | 'right';
  fraction: number;
  targetId: number;
  suppressed: boolean;
  onFail: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // frozen frame shown while the pane is parked offscreen (menus/tooltips
  // paint above the placeholder) — otherwise the region goes black
  const [freeze, setFreeze] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    const bridge = window.strado;
    if (!el || !bridge) {
      onFail();
      return;
    }
    bridge
      .devtools('dock', targetId, elementBounds(el))
      .then((ok) => {
        if (!ok) onFail();
      })
      .catch(() => onFail());
    return () => {
      void bridge.devtools('undock', targetId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);
  // Renderer overlays (menus, in-hub dialogs) paint UNDER a native view, so
  // the pane parks offscreen while one is open and comes back after.
  useEffect(() => {
    const el = ref.current;
    const bridge = window.strado;
    if (!el || !bridge) return;
    let stale = false;
    if (suppressed) {
      // capture before hiding — a hidden pane captures black
      void bridge
        .devtools('thumb', targetId)
        .then((r) => {
          if (typeof r === 'string' && r.startsWith('data:')) setFreeze(r);
        })
        .catch(() => undefined)
        .then(() => {
          if (!stale) void bridge.devtools('hide', targetId);
        });
    } else {
      setFreeze(null);
      void bridge.devtools('show', targetId, elementBounds(el));
    }
    return () => {
      stale = true;
    };
  }, [suppressed, targetId]);
  useBoundsSync(ref, (b) => void window.strado?.devtools('bounds', targetId, b));
  return (
    <div
      ref={ref}
      style={side === 'bottom' ? { height: `${fraction * 100}%` } : { width: `${fraction * 100}%` }}
      className={
        side === 'bottom'
          ? 'relative w-full shrink-0 overflow-hidden border-t border-zinc-800 bg-zinc-950'
          : 'relative h-full shrink-0 overflow-hidden border-l border-zinc-800 bg-zinc-950'
      }
    >
      {suppressed && freeze && (
        <img src={freeze} alt="" className="h-full w-full object-cover object-top" />
      )}
    </div>
  );
}

// Placeholder for a Browser preview: the page itself renders in a
// main-process WebContentsView (see main.cjs for why a <webview> cannot do
// this job). Mounted only while its tab is visible; the view survives
// hidden in main, so switching tabs never reloads the page.
function BrowserPreviewPane({
  path,
  initialUrl,
  suppressed,
  onReady,
}: {
  path: string;
  initialUrl: string;
  suppressed: boolean;
  onReady: (wcId: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // frozen frame shown while the native view is detached (menus/tooltips
  // paint above the placeholder) — otherwise the pane goes black
  const [freeze, setFreeze] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    const bridge = window.strado;
    if (!el || !bridge?.preview) return;
    void bridge
      .preview('open', path, { url: initialUrl, bounds: elementBounds(el) })
      .then((wcId) => {
        if (typeof wcId === 'number') onReady(wcId);
      });
    return () => {
      void bridge.preview?.('hide', path);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => {
    const el = ref.current;
    const bridge = window.strado;
    if (!el || !bridge?.preview) return;
    let stale = false;
    if (suppressed) {
      // capture BEFORE hiding — the two calls used to race, and a hidden
      // view captures black, leaving the placeholder dark instead of frozen.
      // If the overlay closed while capturing, the hide must not fire: it
      // would park the view offscreen with nothing showing until heartbeat.
      void bridge
        .preview('thumb', path)
        .then((r) => {
          if (typeof r === 'string' && r.startsWith('data:')) setFreeze(r);
        })
        .catch(() => undefined)
        .then(() => {
          if (!stale) void bridge.preview?.('hide', path);
        });
    } else {
      setFreeze(null);
      void bridge.preview('open', path, { bounds: elementBounds(el) });
    }
    return () => {
      stale = true;
    };
  }, [suppressed, path]);
  // self-healing: whatever detaches the view without our knowledge, the
  // heartbeat re-asserts attachment (idempotent in main) within ~2s
  useEffect(() => {
    if (suppressed) return;
    const el = ref.current;
    const bridge = window.strado;
    if (!el || !bridge?.preview) return;
    const iv = window.setInterval(() => {
      void bridge.preview?.('open', path, { bounds: elementBounds(el) });
    }, 2000);
    return () => window.clearInterval(iv);
  }, [suppressed, path]);
  useBoundsSync(ref, (b) => void window.strado?.preview?.('bounds', path, b));
  return (
    <div ref={ref} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-zinc-950">
      {suppressed && freeze && (
        <img src={freeze} alt="" className="h-full w-full object-cover object-top" />
      )}
    </div>
  );
}

export function TerminalView({
  worktree,
  onClose,
  mode: modeProp,
  sessionId: sessionIdProp = '1',
  sidebarCollapsed = false,
  onExpandSidebar,
  runningServers,
  openSeq = 0,
  modalOpen = false,
}: {
  worktree: Worktree;
  onClose: () => void;
  /** undefined = a generic open (sidebar row, palette) — restore the tab the
   *  user was on last time; an explicit mode always wins */
  mode?: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi' | 'vscode' | 'browser' | 'kb';
  sessionId?: string;
  /** Bumps on every explicit open request from the parent (for example, a
   *  notification). `mode`/`sessionId` are read once at mount, so this is what
   *  tells an ALREADY-open hub to switch to the requested tab — including when
   *  the same session is re-selected after manual navigation. */
  openSeq?: number;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  /** The board's running-dev-servers chip, handed down so the same control is
   *  reachable from inside a worktree. Owned by the Dashboard, which is where
   *  the live worktree list and the start/stop calls are. */
  runningServers?: React.ReactNode;
  /** A renderer modal outside this hub is open. WebContentsViews always paint
   *  above renderer HTML, so the preview and DevTools must be detached. */
  modalOpen?: boolean;
}) {
  const { workspace } = useWorkspace();
  const { showTime, showStatus } = useHubDisplayPreferences();
  const localWsId = workspace.id;
  /**
   * Set when this worktree lives on a runner. Everything that reads local state
   * has to branch on it: the LOCAL server has never heard of this path, so its
   * session list, git status and process control are all either sourced from the
   * runner or hidden.
   */
  const remote = worktree.remote ?? null;
  // Session and workspace ids are the RUNNER's when remote — opaque here.
  const wsId = remote ? remote.wsId : localWsId;
  // Server-declared capabilities: a runner has no Electron embeds. A remote
  // worktree is on a runner by definition, so never offer them for one.
  const localCaps = useCapabilities();
  const caps = remote ? { ...localCaps, embeds: false, notifications: false } : localCaps;
  // The Browser preview is a LOCAL desktop surface (WebContentsView on the
  // forwarded 127.0.0.1 URL), so it stays available for a REMOTE worktree —
  // unlike VS Code, which the runner would have to serve. Keyed on the desktop's
  // own embed capability, never the runner's.
  const browserEmbeds = isElectron && localCaps.embeds;
  const tickets = useTickets();
  // Resolved once at mount: the hub remounts per worktree switch (keyed by
  // path in Dashboard), so this is what decides where the user lands.
  // A restored tab must actually EXIST after group seeding — restoring a
  // user-closed agent tab left an empty strip, the recovery effect closed the
  // hub (blank board), and the stray pane had already respawned the agent.
  const savedTabAvailable = (t: { mode: string; id: string }, w: Worktree): boolean => {
    const closed = readClosedAgents();
    // Validate the SPECIFIC session id, not just that the mode has any session:
    // id 1 is the mode's primary tab (present whenever the agent is open), but a
    // saved id>1 must still be a live session. Restoring a stale `opencode:2`
    // just because `hasOpencodeSession` is true (from session 1) seeds `active`
    // to a tab that isn't in the strip, and the fallback effect then flips
    // `active` away every render — an infinite remount loop that repeatedly
    // tears the pane down and respawns the agent (the "blank until I switch
    // tabs" churn). Mirror the shell rule (below) for agents too.
    if (t.mode === 'claude') return (t.id === '1' ? !!w.hasClaudeSession : (w.claudeSessions ?? []).includes(t.id)) && !closed.claude.has(w.path);
    if (t.mode === 'codex') return (t.id === '1' ? !!w.hasCodexSession : (w.codexSessions ?? []).includes(t.id)) && !closed.codex.has(w.path);
    if (t.mode === 'opencode') return (t.id === '1' ? !!w.hasOpencodeSession : (w.opencodeSessions ?? []).includes(t.id)) && !closed.opencode.has(w.path);
    if (t.mode === 'pi') return (t.id === '1' ? !!w.hasPiSession : (w.piSessions ?? []).includes(t.id)) && !closed.pi.has(w.path);
    if (t.mode === 'shell') return t.id === '1' || (w.shellSessions ?? []).includes(t.id);
    if (t.mode === 'vscode') return readVscodeTabs().has(w.path);
    if (t.mode === 'kb') return readKbTabs().has(w.path);
    if (t.mode === 'browser') return isElectron && readBrowserTabs().has(w.path);
    return false;
  };
  const [{ mode, sessionId }] = useState(() => {
    if (modeProp !== undefined) return { mode: modeProp, sessionId: sessionIdProp };
    const saved = readActiveTab(worktree.path);
    if (saved && savedTabAvailable(saved, worktree)) return { mode: saved.mode, sessionId: saved.id };
    // Default entry tab: a shell — never silently spawn an agent.
    return { mode: 'shell' as const, sessionId: '1' };
  });
  // Split-pane layout per worktree (only stored while an actual split
  // exists; a single pane implicitly follows the active tab).
  const [paneLayouts, setPaneLayouts] = useState<Record<string, PaneNode>>(readPaneLayouts);
  const setLayout = (path: string, node: PaneNode | null) => {
    setPaneLayouts((prev) => {
      const next = { ...prev };
      if (node && node.kind === 'split') next[path] = node;
      else delete next[path];
      return next;
    });
    rememberPaneLayout(path, node);
  };

  useEffect(() => {
    if (mode === 'vscode') rememberVscodeTab(worktree.path, true);
    if (mode === 'kb') rememberKbTab(worktree.path, true);
  }, [mode, worktree.path]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const rootRef = useRef<HTMLDivElement>(null);

  // In a remote hub every pty session is on the runner, so the target belongs
  // on the tab from the very first render — otherwise the initial pane opens a
  // LOCAL socket for a path this machine doesn't have, and its identity won't
  // match the tabs the strip builds.
  const remoteFor = (path: string) => (remote ? { ...remote, path } : null);
  const [active, setActive] = useState<Tab>(
    mode === 'vscode' || mode === 'browser' || mode === 'kb'
      ? { path: worktree.path, mode, id: '1' }
      : { path: worktree.path, mode, id: sessionId, remote: remoteFor(worktree.path) },
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  // Remember the selection so the next mount of this worktree's hub (every
  // sidebar switch remounts it) lands on the same tab.
  useEffect(() => {
    if (active.path === worktree.path) rememberActiveTab(worktree.path, tabKeyOf(active));
  }, [active, worktree.path]);
  // Cmd+W (window keydown OR forwarded from an embed) closes the active tab.
  // A ref keeps it fresh for the long-lived keydown/onHotkey effect, which
  // would otherwise capture a stale requestCloseTab/active (see previewIdsRef).
  const closeActiveTabRef = useRef<() => void>(() => undefined);
  // Cmd+T opens a new shell in the active worktree (ref for the same reason).
  const addShellRef = useRef<() => void>(() => undefined);
  // Agent tabs the user explicitly closed. A close kills the session AND sets
  // claudeOpen=false optimistically, but a stale in-flight SSE snapshot (taken
  // before the kill, hasClaudeSession=true) would otherwise re-open the tab —
  // and on reload the hub's `mode` default would recreate it. Seeded from (and
  // written through to) localStorage so the close survives a reload; cleared
  // when the user opens the agent again (openMode / openInlineHub). Declared
  // before `groups` so the initial-state seed below can read it.
  const closedAgentsRef = useRef<{ claude: Set<string>; codex: Set<string>; opencode: Set<string>; pi: Set<string> } | null>(null);
  if (!closedAgentsRef.current) closedAgentsRef.current = readClosedAgents();
  // Remote sessions the user closed from THIS hub. A remote hub has no SSE —
  // its session lists come from a 5s poll whose merge is additive — so a
  // snapshot taken before the runner-side kill landed would resurrect the tab
  // forever. Session-scoped (not persisted): cleared when the id is reused.
  const killedRemoteRef = useRef(new Set<string>());
  const remoteKillKey = (p: string, m: string, id: string) => `${p}\0${m}:${id}`;

  // Viewing counts: the active tab (terminal or embedded VS Code) heartbeats
  // its worktree's activity clock while the window is focused.
  useActivityBeacon(active.path);

  const [groups, setGroups] = useState<Group[]>(() => [{
    path: worktree.path,
    repoName: '',
    label: rowLabel(worktree),
    // Stamp the hub's runner on its own group: groupTabs bakes it into every
    // pty tab, and sameTab() treats the runner as part of a tab's identity —
    // without it a runner-stamped `active` never matches the strip (no
    // highlight until the first click).
    remote: worktree.remote ? { ...worktree.remote, path: worktree.path } : null,
    claudeOpen: (mode === 'claude' || !!worktree.hasClaudeSession) && !closedAgentsRef.current!.claude.has(worktree.path),
    codexOpen: (mode === 'codex' || !!worktree.hasCodexSession) && !closedAgentsRef.current!.codex.has(worktree.path),
    opencodeOpen: (mode === 'opencode' || !!worktree.hasOpencodeSession) && !closedAgentsRef.current!.opencode.has(worktree.path),
    piOpen: (mode === 'pi' || !!worktree.hasPiSession) && !closedAgentsRef.current!.pi.has(worktree.path),
    vscodeOpen: mode === 'vscode' || readVscodeTabs().has(worktree.path),
    browserOpen: isElectron && readBrowserTabs().has(worktree.path),
    browserIds: isElectron ? readBrowserTabIds()[worktree.path] ?? [] : [],
    kbOpen: mode === 'kb' || readKbTabs().has(worktree.path),
    claudeStatus: worktree.claudeStatus,
    claudeStatusById: worktree.claudeStatusById,
    codexStatus: worktree.codexStatus,
    codexStatusById: worktree.codexStatusById,
    opencodeStatus: worktree.opencodeStatus,
    opencodeStatusById: worktree.opencodeStatusById,
    piStatus: worktree.piStatus,
    piStatusById: worktree.piStatusById,
    serverShellIds: worktree.shellSessions ?? (worktree.hasShellSession ? ['1'] : []),
    localShellIds: mode === 'shell' ? [sessionId] : [],
    serverClaudeIds: extraIds(worktree.claudeSessions),
    localClaudeIds: mode === 'claude' && sessionId !== '1' ? [sessionId] : [],
    serverCodexIds: extraIds(worktree.codexSessions),
    localCodexIds: mode === 'codex' && sessionId !== '1' ? [sessionId] : [],
    serverOpencodeIds: extraIds(worktree.opencodeSessions),
    localOpencodeIds: mode === 'opencode' && sessionId !== '1' ? [sessionId] : [],
    serverPiIds: extraIds(worktree.piSessions),
    localPiIds: mode === 'pi' && sessionId !== '1' ? [sessionId] : [],
  }]);

  // Agent sessions the server has confirmed live at least once. A
  // hasClaudeSession/hasCodexSession/hasOpencodeSession/hasPiSession:false SSE event only closes a tab that
  // was previously confirmed — a false that lands before a just-spawned pty
  // registers (common when a brand-new worktree is opened straight into
  // Claude) is a pre-spawn snapshot, not a real close. Honoring it would wipe
  // the only tab and close the hub, which for new users looked like the panel
  // flashing open then falling back to the empty board.
  const confirmedRef = useRef<{ claude: Set<string>; codex: Set<string>; opencode: Set<string>; pi: Set<string> } | null>(null);
  if (!confirmedRef.current) {
    confirmedRef.current = {
      claude: new Set(worktree.hasClaudeSession ? [worktree.path] : []),
      codex: new Set(worktree.hasCodexSession ? [worktree.path] : []),
      opencode: new Set(worktree.hasOpencodeSession ? [worktree.path] : []),
      pi: new Set(worktree.hasPiSession ? [worktree.path] : []),
    };
  }

  // Dev-server run state per worktree, seeded from the list fetch and kept
  // live by the same SSE stream that feeds the session tabs.
  const [procs, setProcs] = useState<Record<string, ProcState>>(() => ({
    [worktree.path]: {
      status: worktree.process?.status ?? 'idle',
      port: worktree.process?.port,
      detectedUrl: worktree.process?.detectedUrl,
    },
  }));

  // Repo configs (env profiles) and the user's in-panel profile switches.
  const [reposById, setReposById] = useState<Record<string, RepoConfig>>({});

  // A dev server on a runner binds the RUNNER's loopback, so it is reachable
  // here only through a forwarded local port.
  //
  // Live process port first — frameworks don't always bind what we configured.
  // Then the worktree's own port, then the repo default: a worktree that was
  // adopted rather than created by us has `port: null`, and without the repo
  // fallback no forward would open at all and the hub would just say nothing.
  const remotePreviewPort = remote
    ? procs[worktree.path]?.port ??
      worktree.meta?.port ??
      (worktree.repoId ? reposById[worktree.repoId]?.defaultPort : null) ??
      null
    : null;
  const remoteForward = useRemoteForward(remote?.runnerId ?? null, remotePreviewPort);
  const [envSel, setEnvSel] = useState<Record<string, string>>({});
  // Workflow-status changes made from this panel (optimistic, per worktree).
  const [statusSel, setStatusSel] = useState<Record<string, WorkflowStatus | null>>({});

  // Meta for every known worktree so SSE can add super tabs for worktrees
  // that gain sessions after mount.
  const rowMetaRef = useRef(new Map<string, { repoName: string; label: string }>());
  // Full rows so the in-modal diff can target any group's worktree.
  const rowsRef = useRef(new Map<string, Worktree>());
  // Preview URL per worktree; seeded from the running dev server when opened.
  const [browserUrl, setBrowserUrl] = useState<Record<string, string>>(() => readBrowserUrls());
  const [browserDraft, setBrowserDraft] = useState<Record<string, string>>({});
  // webContents id per preview (resolved when its WebContentsView opens);
  // this is the devtools target and the CDP identity of the page.
  const [previewIds, setPreviewIds] = useState<Record<string, number>>({});
  // Read through a ref from the hotkey/native paths: the onHotkey effect
  // captures its callbacks before BrowserPreviewPane.onReady lands, so a
  // direct read of the previewIds state closure would be stale ({}).
  const previewIdsRef = useRef(previewIds);
  previewIdsRef.current = previewIds;
  const [browserLoad, setBrowserLoad] = useState<Record<string, { loading: boolean; error: string | null }>>({});
  const [bwNav, setBwNav] = useState<Record<string, { canBack: boolean; canForward: boolean }>>({});
  // Live page title + favicon per preview key — the tab's identity. Seeded
  // from the persisted copy so labels survive an app restart (the live page
  // overwrites as soon as its tab is visited).
  const [browserMeta, setBrowserMeta] = useState<Record<string, { title?: string; favicon?: string | null }>>(readBrowserMeta);
  const [bwMenu, setBwMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // transient toolbar feedback ("URL copied", "Saved to Downloads…")
  const [bwNote, setBwNote] = useState<Record<string, string>>({});
  const bwNoteTimers = useRef(new Map<string, number>());
  const flashNote = (path: string, text: string) => {
    setBwNote((p) => ({ ...p, [path]: text }));
    const prev = bwNoteTimers.current.get(path);
    if (prev) window.clearTimeout(prev);
    bwNoteTimers.current.set(
      path,
      window.setTimeout(() => {
        setBwNote((p) => {
          const n = { ...p };
          delete n[path];
          return n;
        });
      }, 2000),
    );
  };
  // Load/navigation state streams from main (the preview lives there).
  useEffect(() => {
    const off = window.strado?.onPreviewEvent?.((ev) => {
      if (ev.type === 'load') {
        setBrowserLoad((prev) => ({
          ...prev,
          [ev.key]: {
            error: ev.loading ? null : (prev[ev.key]?.error ?? null),
            loading: ev.loading,
          },
        }));
      } else if (ev.type === 'error') {
        setBrowserLoad((prev) => ({ ...prev, [ev.key]: { loading: false, error: ev.error } }));
      } else if (ev.type === 'title') {
        // empty = a view that hasn't loaded yet (re-show replay) — keep the
        // last-known label rather than blanking it to "Browser N"
        if (ev.title) {
          rememberBrowserMeta(ev.key, { title: ev.title });
          setBrowserMeta((prev) => ({ ...prev, [ev.key]: { ...prev[ev.key], title: ev.title } }));
        }
      } else if (ev.type === 'favicon') {
        rememberBrowserMeta(ev.key, { favicon: ev.favicon });
        setBrowserMeta((prev) => ({ ...prev, [ev.key]: { ...prev[ev.key], favicon: ev.favicon } }));
      } else if (ev.type === 'url') {
        setBrowserUrl((prev) => ({ ...prev, [ev.key]: ev.url }));
        setBwNav((prev) => ({
          ...prev,
          [ev.key]: { canBack: ev.canBack ?? false, canForward: ev.canForward ?? false },
        }));
        // navigation owns the URL bar again (Chrome behavior)
        setBrowserDraft((prev) => {
          if (!(ev.key in prev)) return prev;
          const next = { ...prev };
          delete next[ev.key];
          return next;
        });
        rememberBrowserUrl(ev.key, ev.url);
      }
    });
    return off;
  }, []);
  // DevTools docking per preview: bottom/right dock a pane next to the
  // placeholder (Chrome-style); 'window' pops a native one.
  const [devtoolsMode, setDevtoolsMode] = useState<Record<string, 'bottom' | 'right' | null>>({});
  // Latest-value refs for the Cmd+Opt+I handler (it lives in an effect whose
  // deps don't include devtoolsMode). lastDockRef remembers the dock the user
  // last chose so the shortcut reopens where they expect.
  const devtoolsModeRef = useRef(devtoolsMode);
  devtoolsModeRef.current = devtoolsMode;
  const lastDockRef = useRef<'bottom' | 'right'>('right');
  // Draggable size of the docked DevTools pane, as a fraction of the hub, per
  // dock side; persisted so it survives reopen. `resizing` parks both native
  // panes (freeze thumbnails) during a drag so the DOM divider gets the events.
  const [devtoolsSize, setDevtoolsSize] = useState<{ bottom: number; right: number }>(() => {
    try {
      const p = JSON.parse(localStorage.getItem('strado:devtools-size') || '{}');
      const clamp = (n: unknown, d: number) => (typeof n === 'number' && n >= 0.15 && n <= 0.85 ? n : d);
      return { bottom: clamp(p.bottom, 0.4), right: clamp(p.right, 0.4) };
    } catch {
      return { bottom: 0.4, right: 0.4 };
    }
  });
  const [resizing, setResizing] = useState(false);
  const resizeSideRef = useRef<'bottom' | 'right' | null>(null);
  useEffect(() => {
    localStorage.setItem('strado:devtools-size', JSON.stringify(devtoolsSize));
  }, [devtoolsSize]);
  // Main drives the drag — the cursor crosses the native preview/DevTools
  // views, so the renderer can't see pointermove once it leaves the divider.
  // Main streams a size fraction from the global cursor; we apply it live.
  useEffect(() => {
    const unsub = window.strado?.onDevtoolsResize?.((ev) => {
      if (ev.type === 'move' && typeof ev.fraction === 'number') {
        const side = resizeSideRef.current;
        if (side) setDevtoolsSize((prev) => ({ ...prev, [side]: ev.fraction }));
      } else if (ev.type === 'end') {
        resizeSideRef.current = null;
        setResizing(false);
      }
    });
    return unsub;
  }, []);
  // Safety net: if the mouse-up lands somewhere main can't observe (e.g. off
  // the window), the renderer still clears the resizing state when it regains
  // events and tells main to drop the drag.
  useEffect(() => {
    if (!resizing) return;
    const stop = () => {
      resizeSideRef.current = null;
      setResizing(false);
      window.strado?.devtoolsResizeStop?.();
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('blur', stop);
    };
  }, [resizing]);
  const startDevtoolsResize = (e: React.PointerEvent, side: 'bottom' | 'right', path: string) => {
    e.preventDefault();
    const targetId = previewIdsRef.current[path];
    if (targetId === undefined || !window.strado?.devtoolsResizeStart) return;
    resizeSideRef.current = side;
    setResizing(true);
    window.strado.devtoolsResizeStart(targetId, path, side);
  };
  const [dtMenu, setDtMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const devtoolsAction = (path: string, mode: 'bottom' | 'right' | 'window' | 'close') => {
    const bridge = window.strado;
    const targetId = previewIdsRef.current[path];
    if (!bridge || targetId === undefined) return;
    if (mode === 'window') {
      // invoke BEFORE unmounting the placeholder: main tears down the docked
      // pane and reopens natively once it's gone; the later 'undock' no-ops.
      void bridge.devtools('window', targetId);
      setDevtoolsMode((prev) => ({ ...prev, [path]: null }));
      return;
    }
    if (mode === 'close') {
      void bridge.devtools('close', targetId);
      setDevtoolsMode((prev) => ({ ...prev, [path]: null }));
      return;
    }
    lastDockRef.current = mode;
    setDevtoolsMode((prev) => ({ ...prev, [path]: mode }));
  };
  // Cmd+Opt+I on a Browser tab (forwarded by the shell menu): toggle the docked
  // DevTools for the active preview — reopen at the last dock, or close it.
  const toggleActiveDevtools = () => {
    if (active.mode !== 'browser') return;
    const pk = previewKey(active.path, active.id);
    if (devtoolsModeRef.current[pk]) devtoolsAction(pk, 'close');
    else devtoolsAction(pk, lastDockRef.current);
  };
  const defaultPreviewUrl = (path: string) => {
    const row = rowsRef.current.get(path) ?? (path === worktree.path ? worktree : undefined);
    // explicit per-worktree override beats anything detected
    const proc = row?.process as { detectedUrl?: string | null; port?: number | null } | undefined;
    const port = proc?.port ?? row?.meta?.port;
    const raw =
      row?.meta?.previewUrl ?? proc?.detectedUrl ?? (port ? `http://localhost:${port}` : 'http://localhost:3000');
    if (!remote) return raw;
    // Everything above names a port on the RUNNER's loopback. Pointing a browser
    // at it here would open whatever is on that port on THIS machine. Resolve
    // through the forward or show nothing.
    return localizeRemoteUrl(raw, remoteForward.forward) ?? 'about:blank';
  };
  // A remote Browser tab opened before the forward was up seeded (and even
  // persisted) 'about:blank' — deliberately, since the runner's localhost URL
  // would render whatever runs on THIS machine. Once the forward exists, heal
  // every still-blank Browser tab of this worktree: state, persistence, and
  // the already-open view.
  useEffect(() => {
    if (!remote || !remoteForward.forward) return;
    const g = groups.find((x) => x.path === worktree.path);
    if (!g) return;
    const url = defaultPreviewUrl(worktree.path);
    if (url === 'about:blank') return;
    for (const id of [...(g.browserOpen ? ['1'] : []), ...g.browserIds.filter((i) => i !== '1')]) {
      const pk = previewKey(worktree.path, id);
      const cur = browserUrl[pk];
      if (cur && cur !== 'about:blank') continue;
      setBrowserUrl((p) => ({ ...p, [pk]: url }));
      rememberBrowserUrl(pk, url);
      void window.strado?.preview?.('navigate', pk, { url });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, remoteForward.forward, groups, browserUrl]);
  const [showDiff, setShowDiff] = useState(false);
  const showDiffRef = useRef(false);
  showDiffRef.current = showDiff;
  const [mrReview, setMrReview] = useState<MergeRequest | null>(null);
  const mrReviewRef = useRef(mrReview);
  mrReviewRef.current = mrReview;
  const [showLogs, setShowLogs] = useState(false);
  const showLogsRef = useRef(false);
  showLogsRef.current = showLogs;
  // Custom shell-tab names (double-click a shell tab to rename; shell only —
  // agent/vscode/browser tabs keep their fixed labels). `renaming` holds the
  // tab being edited plus the draft text for the inline input.
  const shellNames = useShellNames();
  // Remote shells per worktree path, restored from storage so a reopened window
  // finds the sessions still running on the runner.
  const [remoteShells, setRemoteShells] = useState<Record<string, RemoteShell[]>>(() => readRemoteShells());
  const [renaming, setRenaming] = useState<{ path: string; mode: NamedSessionMode; id: string; value: string } | null>(null);
  // "+" on the session-tab row: pick which session type to open.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const addMenuRef = useRef(false);
  addMenuRef.current = addMenu !== null;
  // "More" menu popover holding the per-worktree header controls.
  // Right-side Changes rail: toggled from the header, refreshed on SSE ticks
  // for this worktree so a commit/checkout elsewhere updates the file list.
  const [changesOpen, setChangesOpen] = useState(false);
  const [changesRefresh, setChangesRefresh] = useState(0);
  // OpenCode and Pi are the add-menu rows gated on the binary actually being
  // installed — the server's tool-check reports them, so the menu can grey them
  // out with a hint instead of spawning a session that just fails.
  const [opencodeInstalled, setOpencodeInstalled] = useState<boolean | null>(null);
  const [piInstalled, setPiInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api.envCheck()
      .then((tools) => {
        if (!live) return;
        setOpencodeInstalled(!!tools.find((t) => t.id === 'opencode')?.found);
        setPiInstalled(!!tools.find((t) => t.id === 'pi')?.found);
      })
      .catch(() => {
        if (!live) return;
        setOpencodeInstalled(false);
        setPiInstalled(false);
      });
    return () => { live = false; };
  }, []);

  /**
   * Repos + worktrees for whichever machine owns this hub.
   *
   * A runner is the only source of truth for its own sessions, so a remote hub
   * asks IT, through the same proxy the sidebar uses. The shapes are identical
   * (it is the same server), which is what lets every consumer below stay
   * unaware of where the rows came from.
   */
  const loadRows = useCallback(async (): Promise<{ repos: RepoConfig[]; rows: Worktree[] }> => {
    if (!remote) {
      const [repos, rows] = await Promise.all([api.repos.list(localWsId), api.worktrees.list(localWsId)]);
      return { repos, rows };
    }
    const [repos, worktrees] = await Promise.all([
      api.runners.rpc<{ repos: RepoConfig[] }>(remote.runnerId, `/api/w/${encodeURIComponent(remote.wsId)}/repos`),
      api.runners.rpc<{ worktrees: Worktree[] }>(remote.runnerId, `/api/w/${encodeURIComponent(remote.wsId)}/worktrees`),
    ]);
    return { repos: repos.repos, rows: worktrees.worktrees };
  }, [remote, localWsId]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
    loadRows()
      .then(({ repos, rows }) => {
        if (cancelled) return;
        const repoName = new Map(repos.map((r) => [r.id, r.name]));
        setReposById(Object.fromEntries(repos.map((r) => [r.id, r])));
        rowMetaRef.current = new Map(rows.map((row) => [row.path, {
          repoName: (row.repoId && repoName.get(row.repoId)) || '',
          label: rowLabel(row),
        }]));
        rowsRef.current = new Map(rows.map((row) => [row.path, row]));
        for (const row of rows) {
          if (row.hasClaudeSession) confirmedRef.current!.claude.add(row.path);
          if (row.hasCodexSession) confirmedRef.current!.codex.add(row.path);
          if (row.hasOpencodeSession) confirmedRef.current!.opencode.add(row.path);
          if (row.hasPiSession) confirmedRef.current!.pi.add(row.path);
        }
        setProcs((prev) => {
          const next = { ...prev };
          for (const row of rows) {
            next[row.path] = {
              status: row.process?.status ?? 'idle',
              port: row.process?.port,
              detectedUrl: row.process?.detectedUrl,
            };
          }
          return next;
        });
        setGroups((prev) => {
          const next = prev.map((g) => {
            const meta = rowMetaRef.current.get(g.path);
            return meta ? { ...g, ...meta } : g;
          });
          for (const rawRow of rows) {
            // A remote hub's rows come from a poll, and the merge below is
            // additive — drop ids the user killed from this hub so a snapshot
            // taken before the runner processed the kill can't resurrect them.
            const killed = killedRemoteRef.current;
            const surviving = (m: string, ids: string[] | undefined) =>
              ids?.filter((i) => !killed.has(remoteKillKey(rawRow.path, m, i)));
            const row = remote && killed.size
              ? {
                  ...rawRow,
                  shellSessions: surviving('shell', rawRow.shellSessions),
                  claudeSessions: surviving('claude', rawRow.claudeSessions),
                  codexSessions: surviving('codex', rawRow.codexSessions),
                  opencodeSessions: surviving('opencode', rawRow.opencodeSessions),
                  piSessions: surviving('pi', rawRow.piSessions),
                }
              : rawRow;
            const idx = next.findIndex((g) => g.path === row.path);
            if (idx !== -1) {
              const g = next[idx]!;
              next[idx] = {
                ...g,
                claudeOpen: (g.claudeOpen || !!row.hasClaudeSession) && !closedAgentsRef.current!.claude.has(row.path),
                codexOpen: (g.codexOpen || !!row.hasCodexSession) && !closedAgentsRef.current!.codex.has(row.path),
                opencodeOpen: (g.opencodeOpen || !!row.hasOpencodeSession) && !closedAgentsRef.current!.opencode.has(row.path),
                piOpen: (g.piOpen || !!row.hasPiSession) && !closedAgentsRef.current!.pi.has(row.path),
                claudeStatus: row.claudeStatus ?? g.claudeStatus,
                claudeStatusById: row.claudeStatusById ?? g.claudeStatusById,
                codexStatus: row.codexStatus ?? g.codexStatus,
                codexStatusById: row.codexStatusById ?? g.codexStatusById,
                opencodeStatus: row.opencodeStatus ?? g.opencodeStatus,
                opencodeStatusById: row.opencodeStatusById ?? g.opencodeStatusById,
                piStatus: row.piStatus ?? g.piStatus,
                piStatusById: row.piStatusById ?? g.piStatusById,
                // Merge additively: this response may be a snapshot taken
                // before the pty we just spawned existed, and it can land
                // after the SSE event that confirmed the session. Replacing
                // would wipe the only tab and close the panel; removals are
                // SSE's job.
                serverShellIds: sortIds([...(row.shellSessions ?? []), ...g.serverShellIds]),
                serverClaudeIds: sortIds([...extraIds(row.claudeSessions), ...g.serverClaudeIds]),
                serverCodexIds: sortIds([...extraIds(row.codexSessions), ...g.serverCodexIds]),
                serverOpencodeIds: sortIds([...extraIds(row.opencodeSessions), ...g.serverOpencodeIds]),
                serverPiIds: sortIds([...extraIds(row.piSessions), ...g.serverPiIds]),
              };
              continue;
            }
            const storedVscode = readVscodeTabs().has(row.path);
            const storedBrowser = isElectron && readBrowserTabs().has(row.path);
            const storedKb = readKbTabs().has(row.path);
            const live =
              row.hasClaudeSession || row.hasCodexSession || row.hasOpencodeSession || row.hasPiSession ||
              storedVscode || storedBrowser ||
              storedKb || (row.shellSessions?.length ?? 0) > 0;
            if (!live) continue;
            const meta = rowMetaRef.current.get(row.path)!;
            next.push({
              path: row.path,
              ...meta,
              // Per-group target: every row in a remote hub is a different
              // worktree on the same runner.
              remote: remote ? { ...remote, path: row.path } : null,
              claudeOpen: !!row.hasClaudeSession && !closedAgentsRef.current!.claude.has(row.path),
              codexOpen: !!row.hasCodexSession && !closedAgentsRef.current!.codex.has(row.path),
              opencodeOpen: !!row.hasOpencodeSession && !closedAgentsRef.current!.opencode.has(row.path),
              piOpen: !!row.hasPiSession && !closedAgentsRef.current!.pi.has(row.path),
              vscodeOpen: storedVscode,
              browserOpen: storedBrowser,
              browserIds: isElectron ? readBrowserTabIds()[row.path] ?? [] : [],
              kbOpen: storedKb,
              claudeStatus: row.claudeStatus,
              claudeStatusById: row.claudeStatusById,
              codexStatus: row.codexStatus,
              codexStatusById: row.codexStatusById,
              opencodeStatus: row.opencodeStatus,
              opencodeStatusById: row.opencodeStatusById,
              piStatus: row.piStatus,
              piStatusById: row.piStatusById,
              serverShellIds: row.shellSessions ?? [],
              localShellIds: [],
              serverClaudeIds: extraIds(row.claudeSessions),
              localClaudeIds: [],
              serverCodexIds: extraIds(row.codexSessions),
              localCodexIds: [],
              serverOpencodeIds: extraIds(row.opencodeSessions),
              localOpencodeIds: [],
              serverPiIds: extraIds(row.piSessions),
              localPiIds: [],
            });
          }
          return next;
        });
      })
      .catch(() => undefined);
    };
    load();
    // A runner pushes no SSE into this window, so its session list is polled.
    // Local hubs get the same data over SSE and need no timer.
    const timer = remote ? window.setInterval(load, 5_000) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [loadRows, remote, worktree.path]);

  useEffect(() => {
    // A remote hub polls the runner instead; local SSE carries local paths and
    // would graft this machine's worktrees into a runner's hub.
    if (remote) return;
    return subscribeWorktrees((evt) => {
      const path = evt.data.path;
      const proc = evt.data.process as { status?: string; port?: number | null; detectedUrl?: string | null } | undefined;
      if (proc) {
        setProcs((prev) => ({
          ...prev,
          [path]: { status: 'idle', ...prev[path], ...proc },
        }));
      }
      const shellSessions = Array.isArray(evt.data.shellSessions) ? evt.data.shellSessions : null;
      const claudeSessions = Array.isArray(evt.data.claudeSessions) ? (evt.data.claudeSessions as string[]) : null;
      const codexSessions = Array.isArray(evt.data.codexSessions) ? (evt.data.codexSessions as string[]) : null;
      const opencodeSessions = Array.isArray(evt.data.opencodeSessions) ? (evt.data.opencodeSessions as string[]) : null;
      const piSessions = Array.isArray(evt.data.piSessions) ? (evt.data.piSessions as string[]) : null;
      setGroups((prev) => {
        const idx = prev.findIndex((g) => g.path === path);
        if (idx === -1) {
          const gained =
            evt.data.hasClaudeSession || evt.data.hasCodexSession || evt.data.hasOpencodeSession ||
            evt.data.hasPiSession || (shellSessions?.length ?? 0) > 0;
          if (!gained) return prev;
          const meta = rowMetaRef.current.get(path) ?? {
            repoName: '',
            label: path.split('/').pop() ?? path,
          };
          return [...prev, {
            path,
            ...meta,
            claudeOpen: !!evt.data.hasClaudeSession && !closedAgentsRef.current!.claude.has(path),
            codexOpen: !!evt.data.hasCodexSession && !closedAgentsRef.current!.codex.has(path),
            opencodeOpen: !!evt.data.hasOpencodeSession && !closedAgentsRef.current!.opencode.has(path),
            piOpen: !!evt.data.hasPiSession && !closedAgentsRef.current!.pi.has(path),
            vscodeOpen: false,
            browserOpen: false,
            browserIds: [],
            kbOpen: false,
            claudeStatus: evt.data.claudeStatus,
            claudeStatusById: evt.data.claudeStatusById,
            codexStatus: evt.data.codexStatus,
            codexStatusById: evt.data.codexStatusById,
            opencodeStatus: evt.data.opencodeStatus,
            opencodeStatusById: evt.data.opencodeStatusById,
            piStatus: evt.data.piStatus,
            piStatusById: evt.data.piStatusById,
            serverShellIds: shellSessions ?? [],
            localShellIds: [],
            serverClaudeIds: extraIds(claudeSessions ?? []),
            localClaudeIds: [],
            serverCodexIds: extraIds(codexSessions ?? []),
            localCodexIds: [],
            serverOpencodeIds: extraIds(opencodeSessions ?? []),
            localOpencodeIds: [],
            serverPiIds: extraIds(piSessions ?? []),
            localPiIds: [],
          }];
        }
        const g = prev[idx]!;
        const ng = { ...g };
        if (shellSessions) {
          ng.serverShellIds = shellSessions;
          // Once the server confirms an id, the server list owns it; drop it
          // from the local (unconfirmed) set so a later server-side removal
          // actually removes the tab. Ids the server hasn't reported yet stay
          // local (e.g. a freshly-opened tab whose pty hasn't spawned yet).
          ng.localShellIds = g.localShellIds.filter((id) => !shellSessions.includes(id));
        }
        if (claudeSessions) {
          // Same server/local handoff as shells, for agent ids beyond 1.
          ng.serverClaudeIds = extraIds(claudeSessions);
          ng.localClaudeIds = g.localClaudeIds.filter((id) => !claudeSessions.includes(id));
        }
        if (codexSessions) {
          ng.serverCodexIds = extraIds(codexSessions);
          ng.localCodexIds = g.localCodexIds.filter((id) => !codexSessions.includes(id));
        }
        if (opencodeSessions) {
          ng.serverOpencodeIds = extraIds(opencodeSessions);
          ng.localOpencodeIds = g.localOpencodeIds.filter((id) => !opencodeSessions.includes(id));
        }
        if (piSessions) {
          ng.serverPiIds = extraIds(piSessions);
          ng.localPiIds = g.localPiIds.filter((id) => !piSessions.includes(id));
        }
        if (evt.data.claudeStatusById !== undefined) {
          ng.claudeStatusById = evt.data.claudeStatusById as Group['claudeStatusById'];
        }
        if (evt.data.codexStatusById !== undefined) {
          ng.codexStatusById = evt.data.codexStatusById as Group['codexStatusById'];
        }
        if (evt.data.opencodeStatusById !== undefined) {
          ng.opencodeStatusById = evt.data.opencodeStatusById as Group['opencodeStatusById'];
        }
        if (evt.data.piStatusById !== undefined) {
          ng.piStatusById = evt.data.piStatusById as Group['piStatusById'];
        }
        if (evt.data.claudeStatus !== undefined) ng.claudeStatus = evt.data.claudeStatus;
        if (evt.data.codexStatus !== undefined) ng.codexStatus = evt.data.codexStatus;
        if (evt.data.opencodeStatus !== undefined) ng.opencodeStatus = evt.data.opencodeStatus;
        if (evt.data.piStatus !== undefined) ng.piStatus = evt.data.piStatus;
        // Only a session confirmed live at least once may be closed by a
        // false — otherwise a pre-spawn snapshot would wipe a tab the user
        // just opened (see confirmedRef).
        if (evt.data.hasClaudeSession) {
          confirmedRef.current!.claude.add(path);
          if (!closedAgentsRef.current!.claude.has(path)) ng.claudeOpen = true;
        } else if (evt.data.hasClaudeSession === false && confirmedRef.current!.claude.has(path)) {
          confirmedRef.current!.claude.delete(path);
          ng.claudeOpen = false;
        }
        if (evt.data.hasCodexSession) {
          confirmedRef.current!.codex.add(path);
          if (!closedAgentsRef.current!.codex.has(path)) ng.codexOpen = true;
        } else if (evt.data.hasCodexSession === false && confirmedRef.current!.codex.has(path)) {
          confirmedRef.current!.codex.delete(path);
          ng.codexOpen = false;
        }
        if (evt.data.hasOpencodeSession) {
          confirmedRef.current!.opencode.add(path);
          if (!closedAgentsRef.current!.opencode.has(path)) ng.opencodeOpen = true;
        } else if (evt.data.hasOpencodeSession === false && confirmedRef.current!.opencode.has(path)) {
          confirmedRef.current!.opencode.delete(path);
          ng.opencodeOpen = false;
        }
        if (evt.data.hasPiSession) {
          confirmedRef.current!.pi.add(path);
          if (!closedAgentsRef.current!.pi.has(path)) ng.piOpen = true;
        } else if (evt.data.hasPiSession === false && confirmedRef.current!.pi.has(path)) {
          confirmedRef.current!.pi.delete(path);
          ng.piOpen = false;
        }
        const next = [...prev];
        next[idx] = ng;
        return next;
      });
      if (evt.data.path === worktree.path) setChangesRefresh((n) => n + 1);
    });
   }, [worktree.path, remote]);

  useEffect(() => {
    // While the diff overlay is open, Esc belongs to it (DiffView has its own
    // listener) — don't also close the terminal panel underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (mrReviewRef.current) { setMrReview(null); return; }
      if (showDiffRef.current) return;
      // Esc peels popovers first (add-session menu), then the logs drawer.
      // The hub itself is left via Back / sidebar now, not Esc.
      if (addMenuRef.current) setAddMenu(null);
      else if (showLogsRef.current) setShowLogs(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // VS Code web server base urls, keyed by worktree path — each worktree now
  // runs its own serve-web daemon on its own port, so the base URL is fetched
  // lazily the first time that worktree's VS Code tab becomes active and
  // cached per-folder for the panel's lifetime.
  const [vscodeUrls, setVscodeUrls] = useState<Record<string, string>>({});
  const [vscodeError, setVscodeError] = useState<string | null>(null);
  useEffect(() => {
    if (active.mode !== 'vscode' || vscodeUrls[active.path]) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const path = active.path;
    setVscodeError(null);
    // ready:false = serve-web is still downloading a VS Code update and would
    // serve a raw placeholder page — keep OUR loading overlay and re-poll.
    const attempt = () => {
      api.vscode
        .open(path)
        .then((r) => {
          if (!alive) return;
          if (r.ready === false) { timer = setTimeout(attempt, 3000); return; }
          setVscodeUrls((m) => ({ ...m, [path]: r.url }));
        })
        .catch((e) => alive && setVscodeError(e instanceof Error ? e.message : String(e)));
    };
    attempt();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active.mode, active.path, vscodeUrls]);


  // Phase 2: the hub is scoped to one worktree — render only its own group.
  // Cross-worktree groups may still exist in `groups` (SSE), but they never
  // surface in the UI now that the super-tab row is gone.
  const ordered = useMemo(() => {
    const own = groups.find((g) => g.path === worktree.path);
    return own ? [own] : [];
  }, [groups, worktree.path]);

  const activeGroup = ordered.find((g) => g.path === active.path) ?? null;

  // ---------- split panes (Cmd+D / Cmd+Shift+D) ----------
  const isPtyMode = (m: Tab['mode']): m is PtyTab['mode'] =>
    m !== 'vscode' && m !== 'browser' && m !== 'kb';
  const hubRemote = remote;
  const keyToTab = (path: string, key: string): PtyTab | null => {
    const i = key.indexOf(':');
    if (i === -1) return null;
    let m = key.slice(0, i);
    const id = key.slice(i + 1);
    // `shell@<runnerId>:<id>` — a remote pane. The target has to come back from
    // the registry, because a pane's whole identity is its key string.
    let remote: RemoteTarget | null = null;
    const at = m.indexOf('@');
    if (at !== -1) {
      const runnerId = m.slice(at + 1);
      m = m.slice(0, at);
      remote =
        (remoteShells[path] ?? []).find((s) => s.runnerId === runnerId && s.id === id) ??
        // A remote hub's own target: its groups are all on one runner.
        (hubRemote && hubRemote.runnerId === runnerId ? { ...hubRemote, path } : null);
      // The runner was unlinked (or storage cleared) while a split layout still
      // referenced it: no target means no socket, so drop the leaf rather than
      // render a pane that can never connect.
      if (!remote) return null;
    }
    if (m !== 'shell' && m !== 'claude' && m !== 'codex' && m !== 'opencode' && m !== 'pi') return null;
    return { path, mode: m, id, remote: remote ?? (hubRemote ? { ...hubRemote, path } : null) };
  };
  const layout = paneLayouts[worktree.path] ?? null;
  const paneLayoutsRef = useRef(paneLayouts);
  paneLayoutsRef.current = paneLayouts;
  // The rendered tree: an explicit split layout, or the active pty tab as an
  // implicit single pane. Embed tabs render outside this tree; while one is
  // active an existing split stays mounted (hidden) so its sessions live on.
  const paneTree: PaneNode | null =
    layout ?? (isPtyMode(active.mode) ? { kind: 'leaf', key: tabKeyOf(active) } : null);

  // Route a pty tab into the pane tree: focus its pane when it has one, else
  // re-target the focused pane. Embed tabs bypass the tree entirely.
  const activateTab = (tab: Tab) => {
    if (layout && isPtyMode(tab.mode) && isPtyMode(active.mode)) {
      const key = tabKeyOf(tab);
      if (!hasLeaf(layout, key)) {
        setLayout(worktree.path, replaceLeaf(layout, tabKeyOf(active), key));
      }
    }
    setActive(tab);
  };

  // Split the focused pane, spawning a fresh session of the same mode into
  // the new half (right for row, below for col).
  const splitPane = (dir: 'row' | 'col') => {
    if (!isPtyMode(active.mode) || active.path !== worktree.path) return;
    const newTab = allocSession(active.mode);
    if (!newTab) return;
    const base: PaneNode = paneTree ?? { kind: 'leaf', key: tabKeyOf(active) };
    setLayout(worktree.path, splitLeaf(base, tabKeyOf(active), tabKeyOf(newTab), dir));
    setActive(newTab);
  };
  const splitPaneRef = useRef(splitPane);
  splitPaneRef.current = splitPane;
  const activateTabRef = useRef(activateTab);
  activateTabRef.current = activateTab;

  const startDividerDrag = (e: React.PointerEvent<HTMLDivElement>, addr: number[], dir: 'row' | 'col') => {
    e.preventDefault();
    const parent = e.currentTarget.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* jsdom / pointer gone */ }
    const move = (ev: PointerEvent) => {
      const frac = dir === 'row'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      const ratio = Math.min(0.85, Math.max(0.15, frac));
      setPaneLayouts((prev) => {
        const cur = prev[worktree.path];
        if (!cur) return prev;
        return { ...prev, [worktree.path]: withRatio(cur, addr, ratio) };
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      // ratios changed live in state; persist the final tree once
      rememberPaneLayout(worktree.path, paneLayoutsRef.current[worktree.path] ?? null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const renderPane = (node: PaneNode, addr: number[]): React.ReactNode => {
    if (node.kind === 'leaf') {
      const tab = keyToTab(worktree.path, node.key);
      if (!tab) return null;
      const isFocused = sameTab(active, tab);
      return (
        <XtermPane
          key={node.key}
          wsId={wsId}
          tab={tab}
          focused={isFocused}
          onFocus={() => { if (!isFocused) setActive(tab); }}
        />
      );
    }
    return (
      <div
        data-testid="pane-split"
        data-split-dir={node.dir}
        className={`flex h-full w-full min-h-0 min-w-0 ${node.dir === 'row' ? 'flex-row' : 'flex-col'}`}
      >
        <div style={{ flexBasis: `${node.ratio * 100}%` }} className="min-h-0 min-w-0 shrink-0 grow-0 overflow-hidden">
          {renderPane(node.a, [...addr, 0])}
        </div>
        <div
          role="separator"
          aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'}
          aria-label="Resize panes"
          className={
            node.dir === 'row'
              ? 'w-1 shrink-0 cursor-col-resize bg-zinc-900 hover:bg-sky-500/60'
              : 'h-1 shrink-0 cursor-row-resize bg-zinc-900 hover:bg-sky-500/60'
          }
          onPointerDown={(e) => startDividerDrag(e, addr, node.dir)}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{renderPane(node.b, [...addr, 1])}</div>
      </div>
    );
  };
  // Diffstat for the active worktree, shown on the Changes toggle. The hub is
  // scoped to one worktree, so the active tab is normally this worktree — read
  // the `worktree` prop, which Dashboard keeps fresh (its 15s poll of the
  // worktrees list, where diffStats is computed; SSE merges preserve it). The
  // mount-time rowsRef never gets fresh diffStats (SSE events don't carry it),
  // so it's only the fallback for a non-own path.
  const activeDiff =
    (active.path === worktree.path ? worktree : rowsRef.current.get(active.path))?.diffStats ?? null;

  // Cmd+Right/Left: Arc-style tab switcher for the ACTIVE worktree. Hold Cmd
  // and tap arrows to cycle a card strip with live previews; releasing Cmd
  // commits the selection. Capture-phase so xterm never sees the keys.
  const [switcher, setSwitcher] = useState<{ kind: 'tabs' | 'groups'; index: number } | null>(null);
  const switcherRef = useRef<{ kind: 'tabs' | 'groups'; index: number } | null>(null);
  switcherRef.current = switcher;
  // Cmd+Tab-style LRU: the switcher lists tabs most-recently-used first, so
  // the active tab is index 0 and ONE Cmd+Right lands on the previous tab.
  const tabMruRef = useRef<Record<string, string[]>>({});
  useEffect(() => {
    const k = `${active.mode}:${active.id}`;
    const list = tabMruRef.current[active.path] ?? [];
    tabMruRef.current[active.path] = [k, ...list.filter((x) => x !== k)].slice(0, 24);
  }, [active]);
  const switcherTabs = (g: Group) => {
    const base = groupTabs(g, shellNames, browserMeta, caps.embeds, remoteShells[g.path] ?? [], browserEmbeds);
    const mru = tabMruRef.current[g.path] ?? [];
    return base
      .map((t, i) => {
        const j = mru.indexOf(tabKeyOf(t.tab));
        return { t, r: j < 0 ? mru.length + i : j };
      })
      .sort((a, b) => a.r - b.r)
      .map((x) => x.t);
  };
  const [switchCards, setSwitchCards] = useState<Record<string, { lines?: string[]; img?: string; url?: string }>>({});
  const commitRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const commit = () => {
      const s = switcherRef.current;
      if (s) {
        track('switcher_used', { kind: s.kind });
        if (activeGroup) {
          const t = switcherTabs(activeGroup)[s.index];
          if (t) activateTabRef.current(t.tab);
        }
      }
      setSwitcher(null);
    };
    // Cmd+Arrow cycles the worktree's tabs, Cmd+Opt+Arrow the worktrees;
    // once open, the strip keeps its kind regardless of Opt.
    const advance = (kindWanted: 'tabs' | 'groups', dir: 1 | -1) => {
      const kind = switcherRef.current?.kind ?? kindWanted;
      const count = activeGroup ? switcherTabs(activeGroup).length : 0;
      if (count < 2) return;
      setSwitcher((prev) => {
        const cur =
          prev?.index ??
          switcherTabs(activeGroup!).findIndex((t) => t.tab.mode === active.mode && t.tab.id === active.id);
        return { kind, index: (Math.max(cur, 0) + dir + count) % count };
      });
    };
    commitRef.current = commit;
    const onKeyDown = (e: KeyboardEvent) => {
      if (switcherRef.current && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commit();
        return;
      }
      // Cmd+L toggles the worktree's Changes rail. Ctrl+L deliberately falls
      // through so shells keep their clear-screen binding.
      if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'l') {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        setChangesOpen((open) => !open);
        return;
      }
      // Cmd+W closes the active tab (terminal/shell/agent focus lands here;
      // Browser/VS Code focus arrives via the 'close-tab' IPC combo below).
      if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'w') {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        closeActiveTabRef.current();
        return;
      }
      // Cmd+T opens a new shell in the active worktree.
      if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 't') {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        addShellRef.current();
        return;
      }
      // Cmd+D splits the focused pane side-by-side; Cmd+Shift+D top/bottom.
      // Renderer-focused only, on purpose: inside the VS Code embed Cmd+D is
      // multi-cursor "add next match" and must stay VS Code's.
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'd') {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        splitPaneRef.current(e.shiftKey ? 'col' : 'row');
        return;
      }
      if (!e.metaKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      advance('tabs', e.key === 'ArrowRight' ? 1 : -1);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') commit();
      if (e.key === 'Escape' && switcherRef.current) {
        e.stopPropagation();
        setSwitcher(null);
      }
    };
    const cancel = () => setSwitcher(null);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    // blur = focus moved elsewhere (another app, another webContents): the
    // Meta keyup will never arrive here, so cancel instead of committing
    window.addEventListener('blur', cancel);
    // chords pressed inside an embed (Browser preview view, VS Code iframe)
    // arrive via IPC instead of the listeners above; pull focus back to the
    // hub so the rest of the hold (arrows, Cmd release) lands natively
    const offHotkey = window.strado?.onHotkey?.((combo) => {
      if (combo === 'meta-up') {
        if (switcherRef.current) commit();
        return;
      }
      if (combo === 'devtools') {
        toggleActiveDevtools();
        return;
      }
      if (combo === 'close-tab') {
        closeActiveTabRef.current();
        return;
      }
      if (combo === 'new-shell') {
        addShellRef.current();
        return;
      }
      if (combo === 'changes') {
        setChangesOpen((open) => !open);
        return;
      }
      const dir = combo === 'tab-next' || combo === 'group-next' ? 1 : combo === 'tab-prev' || combo === 'group-prev' ? -1 : null;
      if (dir === null) return; // palette etc. — handled elsewhere
      rootRef.current?.focus();
      advance('tabs', dir);
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', cancel);
      offHotkey?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup, active, ordered]);
  // Announce when the VS Code iframe is the active tab: the shell then
  // intercepts the window's Cmd+Arrow keys (the cross-origin iframe would
  // otherwise swallow them and the switcher could never open).
  useEffect(() => {
    const bridge = window.strado;
    if (!bridge?.hotkeyScope) return;
    bridge.hotkeyScope(active.mode === 'vscode');
    return () => bridge.hotkeyScope?.(false);
  }, [active.mode]);
  // Card previews load once per open: terminal tails + browser thumbnail.
  const switcherOpen = switcher !== null;
  useEffect(() => {
    if (!switcherOpen) {
      // bail-out-friendly clear: a fresh {} every render would add renders
      // during tab-close recovery and double-fire onClose
      setSwitchCards((p) => (Object.keys(p).length ? {} : p));
      return;
    }
    let alive = true;
    const loadFor = (cardKey: string, t: Tab | undefined, path: string) => {
      if (!t) return;
      if (t.mode === 'browser') {
        const pk = previewKey(path, t.id);
        const url = browserUrl[pk] ?? defaultPreviewUrl(path);
        setSwitchCards((p) => ({ ...p, [cardKey]: { url } }));
        void window.strado?.preview?.('thumb', pk).then((r) => {
          if (alive && typeof r === 'string' && r.startsWith('data:')) {
            setSwitchCards((p) => ({ ...p, [cardKey]: { url, img: r } }));
          }
        });
      } else if (t.mode !== 'vscode' && t.mode !== 'kb') {
        // Hover previews read the LOCAL pty buffer; a remote session's buffer
        // lives on the runner, and asking here would return an empty preview
        // that looks like a dead session.
        if (t.remote) return;
        void api.terminal
          .peek(localWsId, t.path, t.mode, t.id)
          .then((lines) => {
            if (alive) setSwitchCards((p) => ({ ...p, [cardKey]: { lines } }));
          })
          .catch(() => undefined);
      }
    };
    if (activeGroup) {
      for (const t of groupTabs(activeGroup, shellNames, browserMeta, caps.embeds, remoteShells[activeGroup.path] ?? [], browserEmbeds)) {
        loadFor(`${t.tab.mode}:${t.tab.id}`, t.tab, activeGroup.path);
      }
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switcherOpen, activeGroup?.path]);
  // Classic pointer-based tab reorder (Chrome-tabs style): the real tab
  // follows the cursor on its own transform, siblings slide aside with eased
  // transforms computed from their ORIGINAL rects (stable — no feedback
  // loops), and release settles the tab into its slot before committing.
  // No React re-renders during the drag: pure DOM transforms via refs.
  const [, bumpTabOrder] = useReducer((n: number) => n + 1, 0);
  const tabs = activeGroup ? groupTabs(activeGroup, shellNames, browserMeta, caps.embeds, remoteShells[activeGroup.path] ?? [], browserEmbeds) : [];

  // Sessions die from anywhere (✕, kill, server exit): drop their panes; a
  // tree collapsing to a single leaf clears the stored layout.
  const tabKeysJoined = tabs.filter((t) => isPtyMode(t.tab.mode)).map((t) => tabKeyOf(t.tab)).join(',');
  useEffect(() => {
    if (!layout) return;
    const valid = new Set(tabKeysJoined.split(',').filter(Boolean));
    if (!leafKeys(layout).some((k) => !valid.has(k))) return;
    const pruned = pruneLeaves(layout, valid);
    setLayout(worktree.path, pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, tabKeysJoined, worktree.path]);
  const tabElsRef = useRef(new Map<string, HTMLElement>());
  const TAB_GAP = 2; // gap-0.5 in the strip
  const tabDragRef = useRef<null | {
    key: string;
    el: HTMLElement;
    startX: number;
    pointerId: number;
    started: boolean;
    fromIdx: number;
    insertIdx: number; // insertion index among the OTHER tabs (0..others.length)
    slots: { key: string; el: HTMLElement; center: number; width: number }[];
  }>(null);
  const justDraggedRef = useRef(false);

  const tabPointerDown = (e: React.PointerEvent<HTMLElement>, tKey: string) => {
    if (e.button !== 0 || !activeGroup) return;
    // close button / rename input keep their own gestures
    if ((e.target as HTMLElement).closest('[data-tab-close], input')) return;
    const slots = tabs
      .map(({ tab }) => {
        const el = tabElsRef.current.get(tabKeyOf(tab));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { key: tabKeyOf(tab), el, center: r.left + r.width / 2, width: r.width };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    const fromIdx = slots.findIndex((s) => s.key === tKey);
    if (fromIdx < 0) return;
    tabDragRef.current = {
      key: tKey, el: e.currentTarget, startX: e.clientX, pointerId: e.pointerId,
      started: false, fromIdx, insertIdx: fromIdx, slots,
    };
    // Do NOT capture here: pointer capture retargets the eventual click to
    // this span, which would swallow the inner button's tab-switch click.
    // Capture only once an actual drag starts (threshold crossed).
  };

  const tabPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = tabDragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.started) {
      if (Math.abs(dx) < 4) return; // click, not a drag
      d.started = true;
      try { d.el.setPointerCapture(d.pointerId); } catch { /* pointer gone */ }
      d.el.style.zIndex = '10';
      d.el.style.position = 'relative';
      d.el.style.transition = 'none';
      d.el.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)';
      d.el.style.cursor = 'grabbing';
    }
    d.el.style.transform = `translateX(${dx}px)`;
    const draggedCenter = d.slots[d.fromIdx]!.center + dx;
    const draggedWidth = d.slots[d.fromIdx]!.width + TAB_GAP;
    const others = d.slots.filter((_, i) => i !== d.fromIdx);
    d.insertIdx = others.filter((s) => s.center < draggedCenter).length;
    others.forEach((s, i) => {
      // original index i maps to: i < fromIdx ? i : i + 1 in the full list
      const shift =
        i >= d.insertIdx && i < d.fromIdx ? draggedWidth // dragged moved left past it
        : i < d.insertIdx && i >= d.fromIdx ? -draggedWidth // dragged moved right past it
        : 0;
      s.el.style.transition = 'transform 160ms ease';
      s.el.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  };

  const tabPointerUp = () => {
    const d = tabDragRef.current;
    tabDragRef.current = null;
    if (!d || !d.started) return;
    justDraggedRef.current = true;
    // settle the dragged tab into its target slot, then commit + clean up
    const others = d.slots.filter((_, i) => i !== d.fromIdx);
    const crossed = d.insertIdx > d.fromIdx
      ? others.slice(d.fromIdx, d.insertIdx)
      : others.slice(d.insertIdx, d.fromIdx);
    const dir = d.insertIdx > d.fromIdx ? 1 : -1;
    const settle = dir * crossed.reduce((sum, s) => sum + s.width + TAB_GAP, 0);
    d.el.style.transition = 'transform 150ms ease';
    d.el.style.transform = `translateX(${settle}px)`;
    const finish = () => {
      const keys = d.slots.map((s) => s.key);
      keys.splice(d.fromIdx, 1);
      keys.splice(d.insertIdx, 0, d.key);
      if (activeGroup) rememberTabOrder(activeGroup.path, keys);
      for (const s of d.slots) {
        s.el.style.transition = '';
        s.el.style.transform = '';
        s.el.style.zIndex = '';
        s.el.style.position = '';
        s.el.style.boxShadow = '';
        s.el.style.cursor = '';
      }
      bumpTabOrder();
    };
    window.setTimeout(finish, 160);
  };

  // If the active tab disappears (closed elsewhere / via SSE), fall back to
  // another tab in the same group, then any group, and close the panel only
  // when no session remains anywhere.
  useEffect(() => {
    const exists = tabs.some(
      (t) => t.tab.path === active.path && t.tab.mode === active.mode && t.tab.id === active.id,
    );
    if (exists) return;
    const fallback = tabs[0] ?? ordered.flatMap((g) => groupTabs(g, shellNames, browserMeta, caps.embeds, remoteShells[g.path] ?? [], browserEmbeds))[0];
    if (fallback) setActive(fallback.tab);
    else onCloseRef.current();
  }, [tabs, ordered, active]);

  // Allocate the lowest unused session id of a mode and register it as a
  // local (not yet server-confirmed) tab. Returns the new tab; the caller
  // decides where it appears (active tab, or a fresh split pane).
  const allocSession = (m: 'shell' | 'claude' | 'codex' | 'opencode' | 'pi'): Tab | null => {
    const g = activeGroup;
    if (!g) return null;
    const serverIds =
      m === 'shell' ? g.serverShellIds
      : m === 'claude' ? g.serverClaudeIds
      : m === 'codex' ? g.serverCodexIds
      : m === 'opencode' ? g.serverOpencodeIds : g.serverPiIds;
    const localKey =
      m === 'shell' ? ('localShellIds' as const)
      : m === 'claude' ? ('localClaudeIds' as const)
      : m === 'codex' ? ('localCodexIds' as const)
      : m === 'opencode' ? ('localOpencodeIds' as const)
      : ('localPiIds' as const);
    // For agents, id 1 lives on the *Open flag rather than the lists.
    const agentOpen =
      m === 'claude' ? g.claudeOpen
      : m === 'codex' ? g.codexOpen
      : m === 'opencode' ? g.opencodeOpen : g.piOpen;
    const ids = [
      ...(m !== 'shell' && agentOpen ? ['1'] : []),
      ...sortIds([...serverIds, ...g[localKey]]),
    ];
    let n = 1;
    while (ids.includes(String(n))) n++;
    const id = String(n);
    // Reusing a killed remote id lifts its poll suppression — the new session
    // must be allowed to show up in runner snapshots again.
    killedRemoteRef.current.delete(remoteKillKey(g.path, m, id));
    setGroups((prev) =>
      prev.map((x) => (x.path === g.path ? { ...x, [localKey]: sortIds([...x[localKey], id]) } : x)),
    );
    return { path: g.path, mode: m, id };
  };

  const addShell = () => {
    const tab = allocSession('shell');
    if (tab) activateTab(tab);
  };
  addShellRef.current = addShell;

  // "Browser" in the new-session menu: open the primary preview if it isn't
  // open, otherwise add another Browser tab (its own WebContentsView).
  const addBrowser = () => {
    const g = activeGroup;
    if (!g) return;
    if (!g.browserOpen) {
      openMode('browser');
      return;
    }
    const ids = ['1', ...sortIds(g.browserIds)];
    let n = 1;
    while (ids.includes(String(n))) n++;
    const id = String(n);
    const nextIds = sortIds([...g.browserIds, id]);
    setGroups((prev) => prev.map((x) => (x.path === g.path ? { ...x, browserIds: nextIds } : x)));
    rememberBrowserTabIds(g.path, nextIds);
    const pk = previewKey(g.path, id);
    setBrowserUrl((prev) => {
      if (prev[pk]) return prev;
      const url = defaultPreviewUrl(g.path);
      rememberBrowserUrl(pk, url);
      return { ...prev, [pk]: url };
    });
    setActive({ path: g.path, mode: 'browser', id });
  };

  // An agent in the new-session menu: open the primary session if it isn't
  // open, otherwise spawn the lowest unused id — same scheme as shells.
  const addAgent = (m: 'claude' | 'codex' | 'opencode' | 'pi') => {
    const g = activeGroup;
    if (!g) return;
    const open =
      m === 'claude' ? g.claudeOpen
      : m === 'codex' ? g.codexOpen
      : m === 'opencode' ? g.opencodeOpen : g.piOpen;
    if (!open) {
      openMode(m);
      return;
    }
    const tab = allocSession(m);
    if (tab) activateTab(tab);
  };

  // Header quick-launch: open (or jump to) a Claude/Codex/VS Code tab for the
  // ACTIVE worktree without leaving the panel. Marking the group open and
  // activating the tab is enough — the terminal WS spawns the pty on connect.
  const openMode = (
    m: 'claude' | 'codex' | 'opencode' | 'pi' | 'vscode' | 'browser' | 'kb',
    opts?: { path?: string; id?: string },
  ) => {
    const path = opts?.path ?? active.path;
    // Agents can have several sessions; embeds are always the single tab.
    const id = m === 'vscode' || m === 'browser' || m === 'kb' ? '1' : opts?.id ?? '1';
    // Re-opening an agent lifts the user-closed suppression so SSE session
    // detection can drive the tab again.
    if (m === 'claude' || m === 'codex' || m === 'opencode' || m === 'pi') {
      closedAgentsRef.current![m].delete(path);
      rememberClosedAgent(m, path, false);
      killedRemoteRef.current.delete(remoteKillKey(path, m, id));
    }
    if (m === 'vscode') rememberVscodeTab(path, true);
    if (m === 'kb') rememberKbTab(path, true);
    if (m === 'browser') {
      rememberBrowserTab(path, true);
      setBrowserUrl((prev) => {
        if (prev[path]) return prev;
        const url = defaultPreviewUrl(path);
        rememberBrowserUrl(path, url);
        return { ...prev, [path]: url };
      });
    }
    setGroups((prev) =>
      prev.map((g) =>
        g.path === path
          ? {
              ...g,
              claudeOpen: g.claudeOpen || m === 'claude',
              codexOpen: g.codexOpen || m === 'codex',
              opencodeOpen: g.opencodeOpen || m === 'opencode',
              piOpen: g.piOpen || m === 'pi',
              vscodeOpen: g.vscodeOpen || m === 'vscode',
              browserOpen: g.browserOpen || m === 'browser',
              kbOpen: g.kbOpen || m === 'kb',
            }
          : g,
      ),
    );
    // Embed tabs carry no runner identity (they're local desktop surfaces);
    // stamping one would make sameTab() miss the strip entry — no highlight.
    setActive({
      path,
      mode: m,
      id,
      remote: m === 'vscode' || m === 'browser' || m === 'kb' ? null : remoteFor(path),
    });
  };

  // Apply an explicit open request from the parent (such as a notification)
  // that lands while THIS worktree's hub is already open — the
  // initial mount is already handled by the seeded `active`/`groups` state,
  // which deliberately respects a user-closed agent (a reload passes mode=…
  // and must NOT resurrect a closed tab). So skip the mount run and only react
  // to LATER requests; openSeq bumps per request so re-selecting the same
  // session after manually switching tabs still refocuses it.
  const openReqMounted = useRef(false);
  useEffect(() => {
    if (!openReqMounted.current) { openReqMounted.current = true; return; }
    if (modeProp === undefined) return;
    if (modeProp === 'shell') {
      setActive({ path: worktree.path, mode: 'shell', id: sessionIdProp, remote: remoteFor(worktree.path) });
    } else {
      openMode(modeProp, { path: worktree.path, id: sessionIdProp });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSeq]);

  // Warn before closing a tab with work in progress: a shell with a running
  // command, or an agent that's actively working. Confirmed close falls
  // through to closeTab.
  const requestCloseTab = async (tab: Tab) => {
    if (tab.mode === 'shell') {
      let busy = false;
      try {
        busy = tab.remote ? false : (await api.worktrees.sessionBusy(localWsId, tab.path, 'shell', tab.id)).busy;
      } catch {
        busy = false; // don't block closing if the check fails
      }
      if (busy && !confirm('A command is still running in this shell. Close it anyway?')) return;
    } else if (tab.mode === 'claude' || tab.mode === 'codex' || tab.mode === 'opencode' || tab.mode === 'pi') {
      const g = groups.find((x) => x.path === tab.path);
      const byId =
        tab.mode === 'claude' ? g?.claudeStatusById
        : tab.mode === 'codex' ? g?.codexStatusById
        : tab.mode === 'opencode' ? g?.opencodeStatusById : g?.piStatusById;
      const aggregate =
        tab.mode === 'claude' ? g?.claudeStatus
        : tab.mode === 'codex' ? g?.codexStatus
        : tab.mode === 'opencode' ? g?.opencodeStatus : g?.piStatus;
      const status = byId?.[tab.id] ?? (tab.id === '1' ? aggregate : undefined);
      const label = SHELL_HOST_LABEL[tab.mode];
      if (status === 'working' && !confirm(`${label} is still working. Close it anyway?`)) return;
    }
    closeTab(tab);
  };
  closeActiveTabRef.current = () => {
    void requestCloseTab(activeRef.current);
  };

  const closeTab = (tab: Tab) => {
    // Closing a runner shell ATTACHED to a local hub DETACHES — it never
    // kills the pty. That session is the thing the user came for (it outlives
    // this window on purpose). A REMOTE hub's own tabs are different: there
    // the user is managing the runner's sessions, so close means kill (below).
    if (tab.remote && !remote) {
      const next = (remoteShells[tab.path] ?? []).filter(
        (s) => !(s.runnerId === tab.remote!.runnerId && s.id === tab.id),
      );
      setRemoteShells((prev) => ({ ...prev, [tab.path]: next }));
      rememberRemoteShells(tab.path, next);
      if (layout && hasLeaf(layout, tabKeyOf(tab))) {
        const pruned = removeLeaf(layout, tabKeyOf(tab));
        setLayout(worktree.path, pruned);
        if (pruned && sameTab(active, tab)) {
          const next = keyToTab(worktree.path, leafKeys(pruned)[0]!);
          if (next) setActive(next);
        }
      }
      return;
    }
    // VS Code / Browser / Knowledge Base are client-side embed tabs — nothing
    // to kill server-side.
    if (tab.mode !== 'vscode' && tab.mode !== 'browser' && tab.mode !== 'kb') {
      if (remote) {
        // The session lives on the runner — the local server has never heard
        // of this path. Suppress the id BEFORE the request so a poll snapshot
        // racing the kill can't re-add the tab.
        killedRemoteRef.current.add(remoteKillKey(tab.path, tab.mode, tab.id));
        api.runners
          .killRemoteSession(localWsId, {
            runnerId: remote.runnerId,
            remoteWsId: remote.wsId,
            path: tab.path,
            mode: tab.mode,
            id: tab.id,
          })
          .catch(() => undefined);
      } else {
        api.worktrees.killSession(localWsId, tab.path, tab.mode, tab.id).catch(() => undefined);
      }
    }
    // Panes: drop this tab's leaf immediately; when it was the focused pane,
    // move focus to a surviving sibling so the split doesn't strand focus.
    if (layout && isPtyMode(tab.mode) && tab.path === worktree.path && hasLeaf(layout, tabKeyOf(tab))) {
      const pruned = removeLeaf(layout, tabKeyOf(tab));
      setLayout(worktree.path, pruned);
      if (pruned && sameTab(active, tab)) {
        const next = keyToTab(worktree.path, leafKeys(pruned)[0]!);
        if (next) setActive(next);
      }
    }
    // Mark agent tabs as user-closed so a stale in-flight SSE snapshot can't
    // re-open them (cleared when the user opens the agent again via openMode).
    // Only the PRIMARY session carries the suppression — extra ids are
    // list-driven like shells, so a close just drops them from the lists.
    if ((tab.mode === 'claude' || tab.mode === 'codex' || tab.mode === 'opencode' || tab.mode === 'pi') && tab.id === '1') {
      closedAgentsRef.current![tab.mode].add(tab.path);
      rememberClosedAgent(tab.mode, tab.path, true);
    }
    // Forget a closed Browser tab's URL (state + persisted): new tabs reuse
    // the lowest free id, and a leftover URL would open the closed tab's page
    // instead of a fresh one.
    if (tab.mode === 'browser') {
      const pk = previewKey(tab.path, tab.id);
      rememberBrowserUrl(pk, null);
      setBrowserUrl((prev) => {
        if (!(pk in prev)) return prev;
        const next = { ...prev };
        delete next[pk];
        return next;
      });
      setBrowserDraft((prev) => {
        if (!(pk in prev)) return prev;
        const next = { ...prev };
        delete next[pk];
        return next;
      });
    }
    // Only update session state here; the active-tab recovery effect owns the
    // transition (activate the first remaining tab, or onClose when none
    // remain), so onClose fires exactly once.
    setGroups((prev) =>
      prev.map((g) => {
        if (g.path !== tab.path) return g;
        if (tab.mode === 'claude') {
          if (tab.id !== '1') {
            return {
              ...g,
              serverClaudeIds: g.serverClaudeIds.filter((i) => i !== tab.id),
              localClaudeIds: g.localClaudeIds.filter((i) => i !== tab.id),
            };
          }
          return { ...g, claudeOpen: false };
        }
        if (tab.mode === 'codex') {
          if (tab.id !== '1') {
            return {
              ...g,
              serverCodexIds: g.serverCodexIds.filter((i) => i !== tab.id),
              localCodexIds: g.localCodexIds.filter((i) => i !== tab.id),
            };
          }
          return { ...g, codexOpen: false };
        }
        if (tab.mode === 'opencode') {
          if (tab.id !== '1') {
            return {
              ...g,
              serverOpencodeIds: g.serverOpencodeIds.filter((i) => i !== tab.id),
              localOpencodeIds: g.localOpencodeIds.filter((i) => i !== tab.id),
            };
          }
          return { ...g, opencodeOpen: false };
        }
        if (tab.mode === 'pi') {
          if (tab.id !== '1') {
            return {
              ...g,
              serverPiIds: g.serverPiIds.filter((i) => i !== tab.id),
              localPiIds: g.localPiIds.filter((i) => i !== tab.id),
            };
          }
          return { ...g, piOpen: false };
        }
        if (tab.mode === 'vscode') {
          closeVscodeTab(tab.path);
          setVscodeUrls((m) => {
            const n = { ...m };
            delete n[tab.path];
            return n;
          });
          return { ...g, vscodeOpen: false };
        }
        if (tab.mode === 'browser') {
          const pk = previewKey(tab.path, tab.id);
          rememberBrowserMeta(pk, null);
          // main tears down the view AND any docked devtools with it
          void window.strado?.preview?.('close', pk);
          setDevtoolsMode((prev) => ({ ...prev, [pk]: null }));
          setPreviewIds((prev) => {
            const next = { ...prev };
            delete next[pk];
            return next;
          });
          if (tab.id === '1') {
            rememberBrowserTab(tab.path, false);
            return { ...g, browserOpen: false };
          }
          const nextIds = g.browserIds.filter((i) => i !== tab.id);
          rememberBrowserTabIds(tab.path, nextIds);
          return { ...g, browserIds: nextIds };
        }
        if (tab.mode === 'kb') {
          rememberKbTab(tab.path, false);
          return { ...g, kbOpen: false };
        }
        return {
          ...g,
          serverShellIds: g.serverShellIds.filter((i) => i !== tab.id),
          localShellIds: g.localShellIds.filter((i) => i !== tab.id),
        };
      }),
    );
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex h-full w-full overflow-hidden bg-zinc-950 outline-none"
    >
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-1.5 text-sm text-zinc-200">
          {sidebarCollapsed && (
            <button
              aria-label="Open sidebar"
              title="Open sidebar (⌘B)"
              onClick={() => onExpandSidebar?.()}
              className="-ml-1 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            >
              »
            </button>
          )}
          {/* tabs scroll inside this container; the status/action controls sit
              at the row's end — one row, maximum vertical space for panes */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map(({ tab, label: tabLabel, icon, hint }) => {
            const isActive =
              sameTab(active, tab);
            const renamable =
              tab.mode === 'shell' || tab.mode === 'claude' || tab.mode === 'codex'
              || tab.mode === 'opencode' || tab.mode === 'pi';
            const isRenaming =
              renamable && renaming?.path === tab.path && renaming?.mode === tab.mode && renaming?.id === tab.id;
            const commitRename = () => {
              if (!renaming) return;
              renameSession(renaming.path, renaming.mode, renaming.id, renaming.value);
              setRenaming(null);
            };
            const tKey = `${tab.mode}:${tab.id}`;
            return (
              <span
                key={tKey}
                ref={(el) => {
                  if (el) tabElsRef.current.set(tKey, el);
                  else tabElsRef.current.delete(tKey);
                }}
                onPointerDown={(e) => { if (!isRenaming) tabPointerDown(e, tKey); }}
                onPointerMove={tabPointerMove}
                onPointerUp={tabPointerUp}
                onPointerCancel={tabPointerUp}
                onClickCapture={(e) => {
                  // a completed drag must not also activate the tab
                  if (justDraggedRef.current) {
                    justDraggedRef.current = false;
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                className={`group flex shrink-0 select-none items-center rounded-md pr-1 text-xs transition-colors ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
                style={{ touchAction: 'none' }}
              >
                {isRenaming ? (
                  <span className="flex items-center gap-1.5 py-1 pl-2 pr-1">
                    {icon}
                    <input
                      autoFocus
                      value={renaming.value}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation(); // typing must not trigger tab hotkeys
                        if (e.key === 'Enter') commitRename();
                        else if (e.key === 'Escape') setRenaming(null);
                      }}
                      aria-label="Rename tab"
                      className="w-24 rounded border border-zinc-700 bg-zinc-950 px-1 py-0 text-xs text-zinc-100 outline-none focus:border-zinc-500"
                    />
                  </span>
                ) : (
                  <button
                    onClick={() => activateTab(tab)}
                    onDoubleClick={
                      renamable
                        ? () => setRenaming({ path: tab.path, mode: tab.mode as NamedSessionMode, id: tab.id, value: tabLabel })
                        : undefined
                    }
                    title={[hint, renamable ? 'Double-click to rename' : null].filter(Boolean).join(' · ') || undefined}
                    className="flex items-center gap-1.5 py-1 pl-2 pr-1"
                  >
                    {icon}
                    {tabLabel}
                  </button>
                )}
                <button
                  data-tab-close
                  onClick={() => requestCloseTab(tab)}
                  title={`Close ${tabLabel} session`}
                  aria-label={`Close ${tabLabel} session`}
                  className={`rounded p-0.5 text-zinc-600 hover:text-red-300 ${
                    isActive ? '' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  ✕
                </button>
              </span>
            );
          })}
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setAddMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }));
            }}
            title="New session"
            aria-label="New session"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          >
            <PlusIcon />
          </button>
          </div>
          {(() => {
            const p = procs[active.path] ?? { status: 'idle' as const };
            const busy = p.status === 'running' || p.status === 'starting';
            // On a runner the port belongs to the runner's loopback, so name both
            // ends: the local port is the one that actually opens in a browser,
            // and it usually differs (3000 is normally taken here already).
            const detail = remote
              ? remoteForward.forward
                ? `localhost:${remoteForward.forward.localPort} → ${remote.runnerId}:${remoteForward.forward.remotePort}`
                : remoteForward.error
                  ? `port ${remotePreviewPort} not forwarded — ${remoteForward.error}`
                  : remoteForward.pending
                    ? `forwarding port ${remotePreviewPort}…`
                    : ''
              : p.detectedUrl ?? (p.port ? `port ${p.port}` : '');
            const row = rowsRef.current.get(active.path) ?? (active.path === worktree.path ? worktree : undefined);
            const repo = row?.repoId ? reposById[row.repoId] : undefined;
            const profiles = repo?.envProfiles ?? [];
            const jiraIssue = row?.meta?.ticketId ? tickets.issues[ticketRef(row.meta.ticketProvider, row.meta.ticketId)] : undefined;
            const spent = formatActiveTime(row?.activitySeconds);
            const origEstimate = jiraIssue?.estimate && !/^0[mhd]$/.test(jiraIssue.estimate) ? jiraIssue.estimate : null;
            return (
              <>
                {showTime && (spent || origEstimate) && (
                  <span
                    className="ml-3 shrink-0 self-start font-mono text-[11px]"
                    title="Active time / original estimate"
                  >
                    {spent && <span className="text-zinc-300">{spent}</span>}
                    {origEstimate && (
                      <span className="text-zinc-600">{spent ? ' / ' : 'est '}{origEstimate}</span>
                    )}
                  </span>
                )}
                {showStatus && (row?.meta || jiraIssue) && (
                  <span className="ml-3 shrink-0 self-start">
                    {jiraIssue ? (
                      <TicketStatusSelect issue={jiraIssue} />
                    ) : (
                      <WorkflowStatusSelect
                        value={
                          statusSel[active.path] === undefined
                            ? row?.meta?.workflowStatus ?? null
                            : statusSel[active.path]!
                        }
                        onChange={(s) => {
                          setStatusSel((prev) => ({ ...prev, [active.path]: s }));
                          api.worktrees.patch(localWsId, active.path, { workflowStatus: s }).catch(() => undefined);
                        }}
                      />
                    )}
                  </span>
                )}
                {profiles.length > 0 && (
                  <select
                    value={
                      envSel[active.path] ??
                      row?.meta?.activeEnvProfile ??
                      repo?.defaultEnvProfile ??
                      profiles[0]?.name ??
                      ''
                    }
                    onChange={(e) => {
                      const profile = e.target.value;
                      if (busy && !confirm(`Switch env to "${profile}"? This will restart the running process.`)) {
                        return;
                      }
                      setEnvSel((prev) => ({ ...prev, [active.path]: profile }));
                      api.worktrees.setEnvProfile(localWsId, active.path, profile).catch(() => undefined);
                    }}
                    title="Env profile (switching restarts the running process)"
                    aria-label="Env profile"
                    className="h-[26px] shrink-0 self-start rounded border border-zinc-800 bg-zinc-950 px-1.5 text-[11px] uppercase tracking-wide text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                  >
                    {profiles.map((pr) => (
                      <option key={pr.name} value={pr.name}>
                        {pr.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className={`flex shrink-0 items-center gap-1.5 self-start rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                    p.status === 'running'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                      : p.status === 'starting'
                        ? 'animate-pulse border-amber-500/30 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-100'
                  }`}
                  onClick={() => {
                    const call = busy
                      ? api.worktrees.stop(localWsId, active.path)
                      : api.worktrees.start(localWsId, active.path);
                    call.catch(() => undefined); // SSE reflects the real outcome
                  }}
                  title={`${busy ? 'Stop' : 'Start'} dev server — ${p.status}${detail ? ` (${detail})` : ''}`}
                  aria-label={busy ? 'Stop dev server' : 'Start dev server'}
                >
                  {busy ? <StopIcon /> : <PlayIcon />}
                  <span>{p.status === 'starting' ? 'Starting' : busy ? 'Stop' : 'Run'}</span>
                </button>
              </>
            );
          })()}
          {/* Logs, diff and the changes rail all read LOCAL git and process
              state. For a worktree on a runner they would silently show
              nothing, so they are absent rather than inert — the same rule the
              capability flag applies to VS Code and Browser. */}
          {!remote && (
            <>
              <button
                className={`flex shrink-0 items-center gap-1.5 self-start rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                  showLogs
                    ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                    : 'border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-100'
                }`}
                onClick={() => setShowLogs((v) => !v)}
                title="Logs"
                aria-label="Logs"
                aria-pressed={showLogs}
              >
                <LogsIcon />
                <span>Logs</span>
              </button>
              <button
                className={`flex shrink-0 items-center gap-1.5 self-start rounded-md px-2.5 py-1 hover:bg-zinc-900 ${
                  changesOpen ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-100'
                }`}
                onClick={() => setChangesOpen((v) => !v)}
                title="Changes (⌘L)"
                aria-label="Changes"
                aria-pressed={changesOpen}
              >
                <span className="font-mono text-[11px] tabular-nums">
                  <span className="text-emerald-400">+{activeDiff?.additions ?? 0}</span>{' '}
                  <span className="text-red-300">-{activeDiff?.deletions ?? 0}</span>
                </span>
              </button>
            </>
          )}
          {/* Which machine, always visible. Without it a remote hub is
              indistinguishable from a local one. */}
          {remote && (
            <span
              className="shrink-0 self-start rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
              title={`${worktree.path} on ${remote.runnerName}`}
            >
              {remote.runnerName}
            </span>
          )}
          {runningServers}
        </div>
        {dtMenu && (
          <>
            <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setDtMenu(null); }} />
            <div
              role="menu"
              aria-label="DevTools dock"
              className="fixed z-40 w-44 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
              style={{ left: dtMenu.x, top: dtMenu.y }}
            >
              {([
                { label: 'Dock to bottom', mode: 'bottom' as const },
                { label: 'Dock to right', mode: 'right' as const },
                { label: 'Open as window', mode: 'window' as const },
                ...(devtoolsMode[dtMenu.path] ? [{ label: 'Close DevTools', mode: 'close' as const }] : []),
              ]).map((o) => (
                <button
                  key={o.label}
                  role="menuitem"
                  onClick={() => {
                    const path = dtMenu.path;
                    setDtMenu(null);
                    devtoolsAction(path, o.mode);
                  }}
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>
        )}
        {switcher && (() => {
          const preview = (data?: { lines?: string[]; img?: string; url?: string }, icon?: React.ReactNode) => (
            <div className="flex h-32 items-center justify-center overflow-hidden rounded-md bg-zinc-950">
              {data?.img ? (
                <img src={data.img} alt="" className="h-full w-full object-cover" />
              ) : data?.lines?.length ? (
                // terminal miniature: render at 2× logical size and scale
                // down, so full lines fit instead of a zoomed-in crop
                <div className="h-full w-full overflow-hidden px-1.5 py-1">
                  <pre
                    className="origin-top-left scale-50 whitespace-pre text-left font-mono text-[9px] leading-[13px] text-zinc-400"
                    style={{ width: '200%', height: '200%' }}
                  >
                    {data.lines.join('\n')}
                  </pre>
                </div>
              ) : data?.url ? (
                <div className="break-all px-3 text-center font-mono text-[10px] text-zinc-500">{data.url}</div>
              ) : (
                <span className="text-zinc-700">{icon}</span>
              )}
            </div>
          );
          const cards = activeGroup
            ? switcherTabs(activeGroup).map((t, i) => ({
                key: `${t.tab.mode}:${t.tab.id}`,
                sel: i === switcher.index,
                data: switchCards[`${t.tab.mode}:${t.tab.id}`],
                icon: t.icon,
                label: (
                  <>
                    {t.icon}
                    <span>{t.label}</span>
                  </>
                ),
              }))
            : [];
          if (cards.length === 0) return null;
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="flex max-w-[92vw] items-stretch gap-3 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/95 p-4 shadow-2xl">
                {cards.map((c, i) => (
                  <div
                    key={c.key}
                    onClick={() => {
                      setSwitcher((prev) => (prev ? { ...prev, index: i } : prev));
                      // state update lands before the ref-based commit runs
                      window.setTimeout(() => commitRef.current(), 0);
                    }}
                    className={`w-72 shrink-0 cursor-pointer rounded-lg p-2 ${c.sel ? 'bg-zinc-800 ring-1 ring-zinc-600' : 'bg-zinc-900/60'}`}
                  >
                    {preview(c.data, c.icon)}
                    <div
                      className={`mt-2 flex items-center justify-center gap-1.5 text-xs ${c.sel ? 'text-zinc-100' : 'text-zinc-500'}`}
                    >
                      {c.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
        {bwMenu && (() => {
          const path = bwMenu.path; // a preview key: worktree path, or path\0browser:id
          const currentUrl = browserUrl[path] ?? defaultPreviewUrl(path.split('\0')[0]!);
          const act = (fn: () => void) => () => {
            setBwMenu(null);
            fn();
          };
          const ITEM =
            'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100';
          return (
            <>
              <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setBwMenu(null); }} />
              <div
                role="menu"
                aria-label="Browser actions"
                className="fixed z-40 w-52 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
                style={{ left: bwMenu.x, top: bwMenu.y }}
              >
                <button
                  role="menuitem"
                  className={ITEM}
                  onClick={act(() => {
                    void window.strado?.preview?.('screenshot', path).then((r) => {
                      if (typeof r === 'string') flashNote(path, 'Saved to Downloads & clipboard');
                    });
                  })}
                >
                  <CameraIcon className="shrink-0 text-zinc-500" />
                  <span>Take Screenshot</span>
                </button>
                <button
                  role="menuitem"
                  className={ITEM}
                  onClick={act(() => void window.strado?.preview?.('hard-reload', path))}
                >
                  <ReloadIcon className="shrink-0 text-zinc-500" />
                  <span>Hard Reload</span>
                </button>
                <button
                  role="menuitem"
                  className={ITEM}
                  onClick={act(() => {
                    void navigator.clipboard.writeText(currentUrl);
                    flashNote(path, 'URL copied');
                  })}
                >
                  <CopyIcon className="shrink-0 text-zinc-500" />
                  <span>Copy URL</span>
                </button>
                <button
                  role="menuitem"
                  className={ITEM}
                  onClick={act(() => void window.strado?.preview?.('open-external', path))}
                >
                  <ExternalIcon className="shrink-0 text-zinc-500" />
                  <span>Open in Browser</span>
                </button>
                <div className="my-1 border-t border-zinc-900" />
                <button
                  role="menuitem"
                  className={ITEM}
                  onClick={act(() => {
                    void window.strado?.preview?.('clear-history', path);
                    flashNote(path, 'History cleared');
                  })}
                >
                  <ClockIcon className="shrink-0 text-zinc-500" />
                  <span>Clear Browsing History</span>
                </button>
                <button
                  role="menuitem"
                  className={ITEM}
                  onClick={act(() => {
                    void window.strado?.preview?.('clear-cookies', path);
                    flashNote(path, 'Cookies cleared');
                  })}
                >
                  <TrashIcon className="shrink-0 text-zinc-500" />
                  <span>Clear Cookies</span>
                </button>
                <button
                  role="menuitem"
                  className={ITEM}
                  onClick={act(() => {
                    void window.strado?.preview?.('clear-data', path);
                    flashNote(path, 'Site data cleared');
                  })}
                >
                  <TrashIcon className="shrink-0 text-zinc-500" />
                  <span>Clear All Data</span>
                </button>
              </div>
            </>
          );
        })()}
        {addMenu && (
          <>
            <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setAddMenu(null); }} />
            <div
              role="menu"
              aria-label="New session"
              className="fixed z-40 w-44 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
              style={{ left: addMenu.x, top: addMenu.y }}
            >
              {([
                { label: 'Claude', icon: <ClaudeIcon className="text-zinc-500" />, run: () => addAgent('claude') },
                { label: 'Codex', icon: <CodexIcon className="text-zinc-500" />, run: () => addAgent('codex') },
                {
                  label: 'OpenCode',
                  icon: <OpencodeIcon className="text-zinc-500" />,
                  run: () => addAgent('opencode'),
                  disabled: opencodeInstalled === false,
                  hint: 'OpenCode needs to be installed to use',
                },
                {
                  label: 'Pi',
                  icon: <PiIcon className="text-zinc-500" />,
                  run: () => addAgent('pi'),
                  disabled: piInstalled === false,
                  hint: 'Pi needs to be installed to use',
                },
                { label: 'Shell', icon: <ShellIcon className="text-zinc-500" />, run: addShell },
                ...(caps.embeds
                  ? [{ label: 'VS Code', icon: <VsCodeIcon className="text-zinc-500" />, run: () => openMode('vscode') }]
                  : []),
                { label: 'Knowledge Base', icon: <BookIcon className="text-zinc-500" />, run: () => openMode('kb') },
                // No per-runner "Shell on <runner>" row: runner worktrees show
                // up in the sidebar like local ones, so a shell opened from
                // THAT worktree already lands on the runner, in the right repo.
                // The old row had to guess a repo (first worktree it found).
                ...(browserEmbeds
                  ? [{ label: 'Browser', icon: <GlobeIcon className="text-zinc-500" />, run: addBrowser }]
                  : []),
              ] as { label: string; icon: React.ReactNode; run: () => void; disabled?: boolean; hint?: string; badge?: string }[]).map((o) => (
                <button
                  key={o.label}
                  role="menuitem"
                  disabled={o.disabled}
                  aria-disabled={o.disabled || undefined}
                  title={o.disabled ? o.hint : undefined}
                  onClick={() => {
                    if (o.disabled) return;
                    setAddMenu(null);
                    o.run();
                  }}
                  className={
                    o.disabled
                      ? 'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs text-zinc-600 cursor-not-allowed'
                      : 'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100'
                  }
                >
                  {o.icon}
                  {o.label}
                  {o.disabled && <span className="ml-auto text-[10px] text-zinc-600">{o.badge ?? 'install'}</span>}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="relative min-h-0 flex-1">
          {/* VS Code frames stay MOUNTED (css-hidden) while other tabs are
              active: unmounting would kill the web workbench, and with it the
              Claude IDE bridge's active-file/selection context. One frame per
              worktree that has (or had) a VS Code tab open this session. */}
          {groups
            .filter((g) => g.vscodeOpen && vscodeUrls[g.path])
            .map((g) => {
              const shown = active.mode === 'vscode' && active.path === g.path;
              return (
                <iframe
                  key={g.path}
                  src={`${vscodeUrls[g.path] ?? ''}?folder=${encodeURIComponent(g.path)}`}
                  title={shown ? 'VS Code' : `VS Code — ${g.path}`}
                  className={shown ? 'h-full w-full border-0 bg-zinc-950' : 'hidden'}
                  allow="clipboard-read; clipboard-write"
                />
              );
            })}
          {active.mode === 'vscode' && !vscodeUrls[active.path] && (
            vscodeError ? (
              <div className="p-4 text-sm text-zinc-500">VS Code web failed to start: {vscodeError}</div>
            ) : (
              // same loading treatment as the terminal tabs — the server holds
              // the URL back while serve-web downloads/boots the workbench, so
              // this overlay covers the whole warm-up
              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-4">
                <span className="animate-pulse text-zinc-400"><VsCodeIcon size={36} /></span>
                <span className="text-sm text-zinc-500">Starting VS Code…</span>
              </div>
            )
          )}
          {/* Browser previews: toolbar + placeholder per group; the page
              itself is a main-process WebContentsView glued to the
              placeholder. Panes mount only for the visible tab — the view
              survives hidden in main, so switching tabs never reloads. */}
          {isElectron &&
            groups
              .flatMap((g) => [...(g.browserOpen ? ['1'] : []), ...g.browserIds.filter((i) => i !== '1')].map((bid) => ({ g, bid })))
              .map(({ g, bid }) => {
                const pk = previewKey(g.path, bid);
                const shown = active.mode === 'browser' && active.path === g.path && active.id === bid;
                const url = browserUrl[pk] ?? defaultPreviewUrl(g.path);
                // renderer overlays paint UNDER native views — detach the
                // panes while any menu or in-hub dialog is open
                const overlayUp = !!(modalOpen || dtMenu || bwMenu || addMenu || switcher || showLogs || showDiff || mrReview);
                const navigate = (raw: string) => {
                  const q = raw.trim();
                  if (!q) return;
                  // URL-ish goes to the address, anything else to search
                  const urlish =
                    /^https?:\/\//.test(q) ||
                    /^localhost(:\d+)?([/?#]|$)/.test(q) ||
                    /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(q) ||
                    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(q);
                  const next = /^https?:\/\//.test(q)
                    ? q
                    : urlish
                      ? `http://${q}`
                      : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
                  setBrowserUrl((p) => ({ ...p, [pk]: next }));
                  setBrowserDraft((p) => ({ ...p, [pk]: next }));
                  rememberBrowserUrl(pk, next);
                  void window.strado?.preview?.('navigate', pk, { url: next });
                };
                const BWBTN =
                  'shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-40';
                return (
                  <div key={`bw:${pk}`} className={shown ? 'flex h-full w-full flex-col' : 'hidden'}>
                    <div className="flex items-center gap-0.5 border-b border-zinc-900 px-2 py-1">
                      <button
                        onClick={() => void window.strado?.preview?.('back', pk)}
                        disabled={!bwNav[pk]?.canBack}
                        title="Back"
                        aria-label="Back"
                        className={BWBTN}
                      >
                        <ArrowLeftIcon />
                      </button>
                      <button
                        onClick={() => void window.strado?.preview?.('forward', pk)}
                        disabled={!bwNav[pk]?.canForward}
                        title="Forward"
                        aria-label="Forward"
                        className={BWBTN}
                      >
                        <ArrowRightIcon />
                      </button>
                      <button
                        onClick={() => void window.strado?.preview?.('reload', pk)}
                        title="Reload"
                        aria-label="Reload preview"
                        className={BWBTN}
                      >
                        <ReloadIcon />
                      </button>
                      <span className="mx-1.5 h-4 w-px shrink-0 bg-zinc-800" />
                      <form
                        className="min-w-0 flex-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          navigate(browserDraft[pk] ?? url);
                        }}
                      >
                        <input
                          value={browserDraft[pk] ?? url}
                          onChange={(e) => setBrowserDraft((p) => ({ ...p, [pk]: e.target.value }))}
                          aria-label="Preview URL"
                          placeholder="Enter URL or search…"
                          spellCheck={false}
                          className="h-7 w-full bg-transparent px-1 font-mono text-xs text-zinc-300 outline-none placeholder:text-zinc-600"
                        />
                      </form>
                      {bwNote[pk] && (
                        <span className="shrink-0 px-2 text-[11px] text-zinc-500">{bwNote[pk]}</span>
                      )}
                      <span className="mx-1.5 h-4 w-px shrink-0 bg-zinc-800" />
                      <button
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setDtMenu((m) =>
                            m?.path === pk ? null : { x: r.right - 176, y: r.bottom + 4, path: pk },
                          );
                        }}
                        title="DevTools"
                        aria-label="DevTools"
                        className={BWBTN}
                      >
                        <ScreenIcon />
                      </button>
                      <button
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setBwMenu((m) =>
                            m?.path === pk ? null : { x: r.right - 208, y: r.bottom + 4, path: pk },
                          );
                        }}
                        title="Browser actions"
                        aria-label="Browser actions"
                        className={BWBTN}
                      >
                        ⋯
                      </button>
                    </div>
                    {browserLoad[pk]?.loading && (
                      <div className="h-0.5 w-full overflow-hidden bg-zinc-900">
                        <div className="h-full w-1/3 animate-pulse bg-sky-500" />
                      </div>
                    )}
                    {browserLoad[pk]?.error && (
                      <div className="border-b border-zinc-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                        {browserLoad[pk]!.error}
                      </div>
                    )}
                    <div className={`flex min-h-0 flex-1 ${devtoolsMode[pk] === 'right' ? 'flex-row' : 'flex-col'}`}>
                      {shown && window.strado?.preview && (
                        <BrowserPreviewPane
                          path={pk}
                          initialUrl={url}
                          suppressed={overlayUp}
                          onReady={(wcId) => setPreviewIds((prev) => ({ ...prev, [pk]: wcId }))}
                        />
                      )}
                      {shown && !window.strado?.preview && (
                        <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-500">
                          Browser preview needs the updated desktop shell — quit the app fully (Cmd+Q) and run `npm run desktop` again.
                        </div>
                      )}
                      {devtoolsMode[pk] && previewIds[pk] !== undefined && (
                        <>
                          {shown && (
                            <div
                              role="separator"
                              aria-label="Resize DevTools"
                              title="Drag to resize DevTools"
                              onPointerDown={(e) => startDevtoolsResize(e, devtoolsMode[pk]!, pk)}
                              className={
                                devtoolsMode[pk] === 'right'
                                  ? `w-1 shrink-0 cursor-col-resize hover:bg-blue-500 ${resizing ? 'bg-blue-500' : 'bg-zinc-800'}`
                                  : `h-1 shrink-0 cursor-row-resize hover:bg-blue-500 ${resizing ? 'bg-blue-500' : 'bg-zinc-800'}`
                              }
                            />
                          )}
                          <DevtoolsDockPane
                            side={devtoolsMode[pk]!}
                            fraction={devtoolsSize[devtoolsMode[pk]!]}
                            targetId={previewIds[pk]!}
                            suppressed={!shown || overlayUp}
                            onFail={() => setDevtoolsMode((prev) => ({ ...prev, [pk]: null }))}
                          />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
          {groups
            .filter((g) => g.kbOpen)
            .map((g) => {
              const shown = active.mode === 'kb' && active.path === g.path;
              // Kept mounted so the selected doc and scroll position survive
              // tab switching — it holds no server session, only local state.
              return (
                <div key={`kb-${g.path}`} data-testid={`kb-pane-${g.path}`} className={shown ? 'h-full w-full' : 'hidden'}>
                  <KnowledgeBasePanel
                    wsId={wsId}
                    worktreePath={g.path}
                    active={shown}
                    onOpenInVsCode={(rel) => {
                      navigator.clipboard?.writeText(rel).catch(() => undefined);
                      openMode('vscode');
                    }}
                  />
                </div>
              );
            })}
        <div
          data-testid="xterm-pane"
          className={active.mode === 'vscode' || active.mode === 'browser' || active.mode === 'kb' ? 'hidden' : 'relative h-full w-full'}
        >
          {paneTree && renderPane(paneTree, [])}
        </div>
        {mrReview && (
          // stopPropagation: clicks in the modal (including its backdrop-close
          // click) must not bubble to the terminal overlay's onClick and close
          // the panel underneath.
          <div onClick={(e) => e.stopPropagation()}>
            <MrReviewModal worktree={worktree} mr={mrReview} onClose={() => setMrReview(null)} />
          </div>
        )}
        </div>
      </div>
      <ChangesRail
        worktree={worktree}
        open={changesOpen}
        onToggle={() => setChangesOpen((v) => false)}
        onOpenFile={() => setShowDiff(true)}
        onReviewAll={() => setShowDiff(true)}
        onOpenMr={setMrReview}
        refreshKey={changesRefresh}
      />
      {showLogs && (
        // stopPropagation: clicks in the drawer must not bubble to the
        // terminal overlay's onClick and close the panel.
        <div onClick={(e) => e.stopPropagation()}>
          <LogPanel
            worktree={
              rowsRef.current.get(active.path) ??
              (active.path === worktree.path
                ? worktree
                : ({ path: active.path, process: {} } as unknown as Worktree))
            }
            onClose={() => setShowLogs(false)}
          />
        </div>
      )}
      {showDiff && (
        // stopPropagation: a click on the diff backdrop must not bubble to the
        // terminal overlay's onClick and close both layers.
        <div onClick={(e) => e.stopPropagation()}>
          <DiffView
            worktree={
              rowsRef.current.get(active.path) ??
              (active.path === worktree.path ? worktree : ({ path: active.path } as Worktree))
            }
            onClose={() => setShowDiff(false)}
          />
        </div>
      )}
    </div>
  );
}
