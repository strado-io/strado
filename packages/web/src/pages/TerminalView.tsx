import { GitPill, useGitStatus } from '../components/GitPill';
import { noteHubTabs } from '../lib/navHistory';
import { OpenSidebarButton } from '../components/SidebarToggle';
import { isRunTab, runIdOfTab, runTabId } from '../lib/runTab';
import { RunButton, type RunEntry, type RunStatus } from '../components/runCommands/RunButton';
import { RunCommandsDialog, runCommandsError } from '../components/runCommands/RunCommandsDialog';
/** A run tab's label: "run" for the default command's, "run: <name>" for another's; null for any other tab. */
function runTabLabel(g: Pick<Group, 'runNames'>, id: string): string | null {
  const runId = runIdOfTab(id);
  if (runId === null) return null;
  return runId ? `run: ${g.runNames?.[runId] ?? runId}` : 'run';
}
/** Process states in which the run tab is restored: live, or crashed (its output one click away). */
const RUN_TAB_STATES = new Set(['starting', 'running', 'stopping', 'crashed']);
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { FileAskContext, RepoConfig, WorkflowStatus, Worktree } from '../types';
import { useWorkspace } from '../hooks/useWorkspace';
import { track } from '../telemetry';
import { api, type StationDto, type UiCommandAck, type UiTabRef } from '../api';
import { subscribeWorktrees } from '../eventStream';
import { useCapabilities } from '../hooks/capabilities';
import { readClosedAgents, rememberClosedAgent } from '../hooks/agentTabs';
import { readDiffTabs, rememberDiffTab } from '../hooks/diffTabs';
import { migrateEditorTabs, readFilesTabs, rememberFilesTab } from '../hooks/filesTabs';
import {
  forgetKbTabState, readKbTabIds, readKbTabs, rememberKbSelection,
  rememberKbTab, rememberKbTabIds,
} from '../hooks/kbTabs';
import { renameSession, sessionNameKey, shellNameKey, useShellNames, type NamedSessionMode } from '../hooks/shellNames';
import {
  browserTabLabel, previewKey, readBrowserMeta, readBrowserTabIds, readBrowserTabs,
  migrateGuessedBrowserUrls, rememberBrowserMeta, rememberBrowserTab, rememberBrowserTabIds,
  rememberBrowserUrl,
} from '../hooks/browserTabs';
import { DiffView } from './DiffView';
import { FilesTab } from '../components/files/FilesTab';
import { FilePicker, primeFileList } from '../components/files/FilePicker';
import { FileAskDialog } from '../components/files/FileAskDialog';
import { jarvisServerPort } from '../lib/jarvis/serverPort';
import { RUN_IN_SHELL_EVENT, type RunInShellRequest } from '../lib/runInShell';
import { WorkflowStatusSelect } from '../components/WorkflowStatusSelect';
import { TicketStatusSelect } from '../components/TicketStatusSelect';
import { filePickerKey, filesSearchKey } from '../components/TerminalSearchBar';
import { SavePromptHost, SavePromptProvided, askSaveChanges } from '../components/files/savePrompt';
import { discardBuffer, dirtyFiles, saveAll } from '../components/files/buffers';
import { formatActiveTime } from '../components/WorktreeRow';
import { KnowledgeBasePanel } from '../components/KnowledgeBasePanel';
import {
  ArrowLeftIcon, ArrowRightIcon, BookIcon, CameraIcon, ClaudeIcon, ClockIcon,
  CodexIcon, CopyIcon, ExternalIcon, FolderIcon, GitIcon, GlobeIcon, OpencodeIcon, PiIcon,
  PlayIcon, PlusIcon, ReloadIcon, ScreenIcon, ShellIcon, StopIcon, TrashIcon,
} from '../components/hub/icons';
import { PROC_COLOR, type ProcState } from '../components/hub/shared';
import { TabStrip, TabTile, animateTabOut } from '../components/hub/TabStrip';
import { stateOf as stationState } from '../lib/dock/stations';
import { useTickets, ticketRef } from '../hooks/tickets';
import { applyTabOrder, readActiveTab, readTabOrder, rememberActiveTab, rememberTabOrder, tabKeyOf } from '../hooks/tabOrder';
import { agentTabStatus, shellHostedAgent } from '../hooks/agentTabStatus';
import {
  dockLeaf, hasLeaf, leafKeys, placeLeaf, pruneLeaves, readPaneLayouts, rememberPaneLayouts,
  removeLeaf, replaceLeaf, splitLeaf, withRatio, carryNames, groupName, withGroupName, type PaneDockSide, type PaneNode,
} from '../hooks/paneLayout';
import { localizeRemoteUrl, useRemoteForward } from '../hooks/remoteForward';
import { PaneCard } from '../components/hub/PaneCard';
import { FLOAT_MIN, clampFloat, nextFloatBox, readPaneFloats, rememberPaneFloats, type PaneFloat } from '../hooks/paneFloats';
import { KIND_ICON } from '../components/hub/TabTile';
import { PaneLayout, animatePaneOut } from '../components/hub/PaneLayout';
import { OpenSurface, type NewSessionOption } from '../components/hub/OpenSurface';
import { useHubDisplayPreferences } from '../hooks/useHubDisplayPreferences';
import { XtermPane, type PtyTab, type RemoteTarget } from '../components/XtermPane';
import { readRemoteShells, rememberRemoteShells, type RemoteShell } from '../hooks/remoteShells';
import { useActivityBeacon } from '../hooks/useActivityBeacon';
import { openInEditor as openEditor, useEditors } from '../hooks/editors';
import { OpenInEditorButton, type OpenWith } from '../components/hub/OpenInEditorButton';
import { useIntercom } from '../contexts/IntercomContext';
import { useUiHubBridge, type JarvisHubContext } from '../contexts/UiControlContext';
import type { JarvisHubPort } from '../lib/jarvis/execute';
import type { TabInfo as JTabInfo, TabRef as JTabRef } from '../lib/jarvis/types';
import { hubKeyOf, nextBrowserId, type ParsedUiCommand, type UiPlace } from '../lib/uiCommands';

const isMacPlatform = () => window.strado?.platform === 'darwin' || /Mac/i.test(navigator.platform);

type Tab = {
  path: string;
  mode: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi' | 'browser' | 'kb' | 'diff' | 'files';
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
  /** Run tabs' command names, by runId (the default's tab is just "run"). */
  runNames?: Record<string, string>;
  repoName: string;
  label: string;
  claudeOpen: boolean;
  codexOpen: boolean;
  opencodeOpen: boolean;
  piOpen: boolean;
  // Electron-only embedded preview (webview) of the worktree's dev server.
  browserOpen: boolean;
  // Extra Browser tabs beyond 1 (client-side, persisted in localStorage).
  browserIds: string[];
  // Client-side, like browserOpen: the Knowledge Base tab has no server
  // session — it just renders the worktree's markdown files.
  kbOpen: boolean;
  // Extra independently stateful document tabs beyond Knowledge Base 1.
  kbIds: string[];
  // Client-side too: the Changes tab (the diff view as a tab, local git only).
  diffOpen: boolean;
  // Client-side too: the Files tab (folders and files, read-only). Local or
  // a runner's worktree: it reads through the runner's API.
  filesOpen: boolean;
  claudeStatus?: 'idle' | 'working' | 'waiting';
  // Per-session status for multi-session worktrees; id '1' falls back to the
  // aggregate field when absent (older servers).
  claudeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  // Claude tab ids the server parked (process stopped, tab kept; the next
  // keystroke resumes the conversation).
  parkedClaudeIds?: string[];
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
// Saved tabs from before the embedded VS Code was removed become Files tabs.
migrateEditorTabs();
// An agent command may not move or split a pane the human touched this recently.
const HUMAN_ACTIVE_MS = 5_000;
const SHELL_HOST_ICON = { claude: ClaudeIcon, codex: CodexIcon, opencode: OpencodeIcon, pi: PiIcon };
const SHELL_HOST_LABEL = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };

// Parked: no process behind the tab, so dimmer than idle.
const PARKED_ICON = 'text-zinc-500 opacity-40';
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

/** Numbered sessions in order; a named one (the run tab) after them. */
function sortIds(ids: Iterable<string>): string[] {
  const n = (x: string) => (/^\d+$/.test(x) ? Number(x) : Infinity);
  return [...new Set(ids)].sort((a, b) => n(a) - n(b) || a.localeCompare(b));
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
  if (broken) return <GlobeIcon className={KIND_ICON.browser} />;
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
  kbTitles: Record<string, string> = {},
  // Shells whose pty lives on a runner. They sit in this worktree's strip
  // alongside local ones — that adjacency is the whole point of the feature.
  remoteShells: RemoteShell[] = [],
  // The Browser preview is rendered by the LOCAL desktop (a WebContentsView
  // pointing at the forwarded 127.0.0.1 URL), not by the worktree's server, so
  // it IS available for a remote worktree.
  browserEmbeds = true,
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
    parked: string[] = [],
  ) => {
    const ids = [...(open ? ['1'] : []), ...sortIds([...server, ...local]).filter((id) => id !== '1')];
    return ids.map((id) => {
      const status = agentTabStatus(id, byId, aggregate) ?? 'idle';
      const isParked = parked.includes(id);
      return {
        tab: { path: g.path, mode, id },
        label: shellNames[sessionNameKey(g.path, mode, id)] ?? (id === '1' ? label : `${label} ${id}`),
        icon: <Icon className={isParked ? PARKED_ICON : status === 'idle' ? KIND_ICON[mode] : AGENT_ICON[status] ?? KIND_ICON[mode]} />,
        hint: isParked ? 'Parked to free memory, press a key in the tab to resume' : undefined,
      };
    });
  };
  const entries = [
    ...agentTabs('claude', g.claudeOpen, g.serverClaudeIds, g.localClaudeIds, 'Claude', g.claudeStatusById, g.claudeStatus, ClaudeIcon, g.parkedClaudeIds),
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
        label: shellNames[shellNameKey(g.path, id)] ?? runTabLabel(g, id) ?? (id === '1' ? 'Shell' : `Shell ${id}`),
        icon: <Icon className={hosted ? AGENT_ICON[hosted.status] ?? KIND_ICON[hosted.mode] : KIND_ICON.shell} />,
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
      icon: <ShellIcon className={KIND_ICON.shell} />,
    })),
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
          <GlobeIcon className={KIND_ICON.browser} />
        ),
      };
    }),
    ...[...(g.kbOpen ? ['1'] : []), ...g.kbIds.filter((id) => id !== '1')].map((id) => {
      const key = `${g.path}\0kb:${id}`;
      return {
          tab: { path: g.path, mode: 'kb' as const, id },
          label: kbTitles[key] ?? (id === '1' ? 'Knowledge Base' : `Knowledge Base ${id}`),
          icon: <BookIcon className={KIND_ICON.kb} />,
        };
    }),
    ...(g.diffOpen && !g.remote
      ? [{ tab: { path: g.path, mode: 'diff' as const, id: '1' }, label: 'Changes', icon: <GitIcon className={KIND_ICON.diff} /> }]
      : []),
    ...(g.filesOpen
      ? [{ tab: { path: g.path, mode: 'files' as const, id: '1' }, label: 'Files', icon: <FolderIcon className={KIND_ICON.files} size={14} /> }]
      : []),
  ];
  // A remote group's pty tabs all target the runner. The Browser tab is a LOCAL
  // desktop surface (it renders the forwarded 127.0.0.1 URL), and KB/Changes/
  // Files are client-side — so none of those get the runner target; only pty
  // modes do.
  const withTarget = g.remote
    ? entries.map((e) =>
        e.tab.mode === 'browser' || e.tab.mode === 'kb' || e.tab.mode === 'diff' || e.tab.mode === 'files'
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
  immediateSuppress = false,
  onReady,
}: {
  path: string;
  initialUrl: string;
  suppressed: boolean;
  /** Tab drags must park the native view before the pointer crosses it. */
  immediateSuppress?: boolean;
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
      if (immediateSuppress) {
        void bridge.preview('hide', path);
        return () => { stale = true; };
      }
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
  }, [suppressed, immediateSuppress, path]);
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
  onExpandSidebar,
  openSeq = 0,
  openSoft = false,
  onActiveTab,
  modalOpen = false,
  mission,
}: {
  worktree: Worktree;
  onClose: () => void;
  /** undefined = a generic open (sidebar row, palette) — restore the tab the
   *  user was on last time; an explicit mode always wins */
  mode?: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi' | 'browser' | 'kb' | 'diff' | 'files';
  sessionId?: string;
  /** Bumps on every explicit open request from the parent (for example, a
   *  notification). `mode`/`sessionId` are read once at mount, so this is what
   *  tells an ALREADY-open hub to switch to the requested tab — including when
   *  the same session is re-selected after manual navigation. */
  openSeq?: number;
  /** The open request only switches to a tab that is still open, never
   *  reopens one (⌘[ / ⌘] going back to a place, lib/navHistory). */
  openSoft?: boolean;
  /** The tab on screen changed: a place for ⌘[ / ⌘]. */
  onActiveTab?: (tab: { path: string; mode: string; id: string }) => void;
  onExpandSidebar?: () => void;
  /** A renderer modal outside this hub is open. WebContentsViews always paint
   *  above renderer HTML, so the preview and DevTools must be detached. */
  modalOpen?: boolean;
  /** Mission Control in the tab bar: the stations (a tab wears its agent's state). */
  mission?: {
    stations: StationDto[];
  };
}) {
  const { workspace } = useWorkspace();
  // The worktree's branch and ahead/behind, for the Git pill and the Changes pane's title.
  const [gitStatus] = useGitStatus(workspace.id, worktree.path, !worktree.remote);
  // Bumped by the Git pill's "Git tree": the Changes view shows its tree.
  const [diffTreeSeq, setDiffTreeSeq] = useState(0);
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
  // forwarded 127.0.0.1 URL), so it stays available for a REMOTE worktree.
  // Keyed on the desktop's
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
    if (t.mode === 'kb') {
      return t.id === '1'
        ? readKbTabs().has(w.path)
        : (readKbTabIds()[w.path] ?? []).includes(t.id);
    }
    if (t.mode === 'browser') return isElectron && readBrowserTabs().has(w.path);
    if (t.mode === 'diff') return !w.remote && readDiffTabs().has(w.path);
    if (t.mode === 'files') return readFilesTabs().has(w.path);
    return false;
  };
  const [{ mode, sessionId }] = useState(() => {
    if (modeProp !== undefined) return { mode: modeProp, sessionId: sessionIdProp };
    const saved = readActiveTab(worktree.path);
    if (saved && savedTabAvailable(saved, worktree)) return { mode: saved.mode, sessionId: saved.id };
    // Default entry tab: a shell — never silently spawn an agent.
    return { mode: 'shell' as const, sessionId: '1' };
  });
  // A worktree can contain multiple independent split groups. Only actual
  // split trees are stored; a normal full-size tab remains implicit.
  const [paneLayouts, setPaneLayouts] = useState<Record<string, PaneNode[]>>(readPaneLayouts);
  const paneLayoutsRef = useRef(paneLayouts);
  paneLayoutsRef.current = paneLayouts;
  const setLayouts = (path: string, nodes: PaneNode[]) => {
    // A rewritten layout keeps its group's name (see carryNames).
    const splits = carryNames(paneLayoutsRef.current[path] ?? [], nodes.filter((node) => node.kind === 'split'));
    setPaneLayouts((prev) => {
      const next = { ...prev };
      if (splits.length > 0) next[path] = splits;
      else delete next[path];
      return next;
    });
    rememberPaneLayouts(path, splits);
  };
  // Floating panes, per worktree: tabs lifted out of the layout into cards over it.
  const [paneFloats, setPaneFloats] = useState<Record<string, PaneFloat[]>>(readPaneFloats);
  const paneFloatsRef = useRef(paneFloats);
  paneFloatsRef.current = paneFloats;
  const setFloats = (path: string, list: PaneFloat[]) => {
    paneFloatsRef.current = { ...paneFloatsRef.current, [path]: list };
    setPaneFloats((prev) => {
      const next = { ...prev };
      if (list.length > 0) next[path] = list;
      else delete next[path];
      return next;
    });
    rememberPaneFloats(path, list);
  };

  useEffect(() => {
    if (mode === 'kb' && sessionId === '1') rememberKbTab(worktree.path, true);
    if (mode === 'diff') rememberDiffTab(worktree.path, true);
    if (mode === 'files') rememberFilesTab(worktree.path, true);
  }, [mode, sessionId, worktree.path]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const rootRef = useRef<HTMLDivElement>(null);

  // In a remote hub every pty session is on the runner, so the target belongs
  // on the tab from the very first render — otherwise the initial pane opens a
  // LOCAL socket for a path this machine doesn't have, and its identity won't
  // match the tabs the strip builds.
  const remoteFor = (path: string) => (remote ? { ...remote, path } : null);
  const [active, setActive] = useState<Tab>(
    mode === 'browser' || mode === 'kb' || mode === 'diff' || mode === 'files'
      ? { path: worktree.path, mode, id: mode === 'diff' || mode === 'files' ? '1' : sessionId }
      : { path: worktree.path, mode, id: sessionId, remote: remoteFor(worktree.path) },
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  const intercom = useIntercom();
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
  // Cmd+L opens the Changes tab (ref for the same reason).
  const openChangesRef = useRef<() => void>(() => undefined);
  // Cmd+P: go to a file in the active worktree (ref for the same reason).
  const openFilePickerRef = useRef<() => void>(() => undefined);
  // Cmd+Shift+F: search the worktree's files from any tab (ref for the same reason).
  const openFilesSearchRef = useRef<() => void>(() => undefined);
  const openWorktreeInEditorRef = useRef<() => void>(() => undefined);
  // Each Files tab's open file and cursor line (FilesTab reports it), for Open in editor.
  const activeFileRef = useRef(new Map<string, { path: string; line: number } | null>());
  const lastNonDiffRef = useRef<Tab | null>(null);
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

  // Viewing counts: the active tab heartbeats
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
    browserOpen: isElectron && readBrowserTabs().has(worktree.path),
    browserIds: isElectron ? readBrowserTabIds()[worktree.path] ?? [] : [],
    kbOpen: (mode === 'kb' && sessionId === '1') || readKbTabs().has(worktree.path),
    kbIds: sortIds([
      ...(readKbTabIds()[worktree.path] ?? []),
      ...(mode === 'kb' && sessionId !== '1' ? [sessionId] : []),
    ]),
    diffOpen: !worktree.remote && (mode === 'diff' || readDiffTabs().has(worktree.path)),
    filesOpen: mode === 'files' || readFilesTabs().has(worktree.path),
    claudeStatus: worktree.claudeStatus,
    claudeStatusById: worktree.claudeStatusById,
    parkedClaudeIds: worktree.parkedClaudeSessions,
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
      proxyUrl: worktree.process?.proxyUrl,
      exitCode: worktree.process?.exitCode,
      tab: worktree.process?.tab ?? null,
    },
  }));
  // The run tab comes back (after a reload, or a Run from elsewhere) once per
  // worktree while the server has one live or crashed; a tab the user closed
  // stays closed until the next Run.
  // The other run commands' processes (not the default's: that is `procs`), by worktree then runId.
  const [runs, setRuns] = useState<Record<string, Record<string, ProcState & { name?: string }>>>({});
  const runTabShownRef = useRef(new Set<string>());
  const runShownKey = (path: string, runId: string) => `${path}\0${runId}`;
  useEffect(() => {
    const restore = (path: string, runId: string, p: { tab?: 'run' | null; status: string; name?: string }) => {
      const key = runShownKey(path, runId);
      if (p.tab !== 'run' || !RUN_TAB_STATES.has(p.status) || runTabShownRef.current.has(key)) return;
      if (!groups.some((g) => g.path === path)) return;
      runTabShownRef.current.add(key);
      addRunTab(path, runId || undefined, p.name);
    };
    for (const [path, p] of Object.entries(procs)) restore(path, '', p);
    for (const [path, byId] of Object.entries(runs)) for (const [runId, p] of Object.entries(byId)) restore(path, runId, p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procs, runs, groups]);

  // Repo configs (run commands).
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
  // The run-command editor, for a repo ("+ Add run command…").
  const [runEditor, setRunEditor] = useState<{ repoId: string } | null>(null);
  // Why the last Run/Stop click did nothing — the request failed (no start
  // command, say). Per worktree; cleared by the next click or by the server
  // reporting a start.
  const [runError, setRunError] = useState<{ path: string; message: string } | null>(null);
  // Workflow-status changes made from this panel (optimistic, per worktree).
  const [statusSel, setStatusSel] = useState<Record<string, WorkflowStatus | null>>({});

  // Meta for every known worktree so SSE can add super tabs for worktrees
  // that gain sessions after mount.
  const rowMetaRef = useRef(new Map<string, { repoName: string; label: string }>());
  // Full rows so the in-modal diff can target any group's worktree.
  const rowsRef = useRef(new Map<string, Worktree>());
  // Preview URL per worktree; seeded from the running dev server when opened.
  const [browserUrl, setBrowserUrl] = useState<Record<string, string>>(migrateGuessedBrowserUrls);
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
  const [kbTitles, setKbTitles] = useState<Record<string, string>>({});
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
      } else if (ev.type === 'focus') {
        const marker = '\0browser:';
        const i = ev.key.lastIndexOf(marker);
        const path = i === -1 ? ev.key : ev.key.slice(0, i);
        const id = i === -1 ? '1' : ev.key.slice(i + marker.length);
        if (path === worktree.path) setActive({ path, mode: 'browser', id });
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
    // An explicit override is always intentional. Otherwise only navigate
    // automatically when Strado knows a dev server is running; guessing port
    // 3000 (or a configured-but-idle port) produces a hostile error page.
    const proc = path === worktree.path
      ? procs[path]
      : row?.process as { status?: string; detectedUrl?: string | null; proxyUrl?: string | null; port?: number | null } | undefined;
    const livePort = proc?.status === 'running' ? (proc.port ?? row?.meta?.port) : null;
    // The proxy hostname resolves on the runner, not here: remote keeps the
    // forwarded private port.
    const raw = row?.meta?.previewUrl ?? (remote ? null : proc?.proxyUrl) ?? proc?.detectedUrl ?? (livePort ? `http://localhost:${livePort}` : '');
    if (!raw) return '';
    if (!remote) return raw;
    // Everything above names a port on the RUNNER's loopback. Pointing a browser
    // at it here would open whatever is on that port on THIS machine. Resolve
    // through the forward or show nothing.
    return localizeRemoteUrl(raw, remoteForward.forward) ?? '';
  };
  const resolvedBrowserUrl = (key: string, path: string) => {
    const saved = browserUrl[key];
    const fallback = defaultPreviewUrl(path);
    if (!saved || saved === 'about:blank') return fallback;
    return saved;
  };
  // A Browser tab can open before a local dev server or remote forward exists.
  // Once a real default becomes available, heal every untouched blank tab.
  // Historical builds persisted `about:blank`, so treat that as blank too.
  useEffect(() => {
    const g = groups.find((x) => x.path === worktree.path);
    if (!g) return;
    const url = defaultPreviewUrl(worktree.path);
    if (!url) return;
    for (const id of [...(g.browserOpen ? ['1'] : []), ...g.browserIds.filter((i) => i !== '1')]) {
      const pk = previewKey(worktree.path, id);
      const cur = browserUrl[pk];
      if (cur && cur !== 'about:blank') continue;
      if (cur === url) continue;
      setBrowserUrl((p) => ({ ...p, [pk]: url }));
      rememberBrowserUrl(pk, url);
      void window.strado?.preview?.('navigate', pk, { url });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, remoteForward.forward, groups, browserUrl, procs[worktree.path]?.status, procs[worktree.path]?.port, procs[worktree.path]?.detectedUrl, procs[worktree.path]?.proxyUrl]);
  // Custom shell-tab names (double-click a shell tab to rename; shell only —
  // agent/browser tabs keep their fixed labels). `renaming` holds the
  // tab being edited plus the draft text for the inline input.
  const shellNames = useShellNames();
  // Remote shells per worktree path, restored from storage so a reopened window
  // finds the sessions still running on the runner.
  const [remoteShells, setRemoteShells] = useState<Record<string, RemoteShell[]>>(() => readRemoteShells());
  const [renaming, setRenaming] = useState<{ path: string; mode: NamedSessionMode; id: string; value: string } | null>(null);
  // "+" on the session-tab row: pick which session type to open.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  // The agent-usage popover lives in the toolbar; like the menus it must
  // detach the native Browser view, which otherwise paints over it.
  const addMenuRef = useRef(false);
  addMenuRef.current = addMenu !== null;
  // "More" menu popover holding the per-worktree header controls.
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
        setRuns((prev) => {
          const next = { ...prev };
          for (const row of rows) {
            const others = (row.runs ?? []).filter((r) => r.runId && r.runId !== row.process?.runId);
            if (others.length > 0) next[row.path] = Object.fromEntries(others.map((r) => [r.runId!, { status: r.status, port: r.port, detectedUrl: r.detectedUrl, exitCode: r.exitCode, tab: r.tab ?? null, name: r.name }]));
          }
          return next;
        });
        setProcs((prev) => {
          const next = { ...prev };
          for (const row of rows) {
            next[row.path] = {
              status: row.process?.status ?? 'idle',
              port: row.process?.port,
              detectedUrl: row.process?.detectedUrl,
              proxyUrl: row.process?.proxyUrl,
              exitCode: row.process?.exitCode,
              tab: row.process?.tab ?? null,
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
                parkedClaudeIds: row.parkedClaudeSessions ?? g.parkedClaudeIds,
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
            const storedBrowser = isElectron && readBrowserTabs().has(row.path);
            const storedKb = readKbTabs().has(row.path);
            const storedKbIds = readKbTabIds()[row.path] ?? [];
            const storedDiff = !remote && readDiffTabs().has(row.path);
            const storedFiles = readFilesTabs().has(row.path);
            const live =
              row.hasClaudeSession || row.hasCodexSession || row.hasOpencodeSession || row.hasPiSession ||
              storedBrowser || storedDiff || storedFiles ||
              storedKb || storedKbIds.length > 0 || (row.shellSessions?.length ?? 0) > 0;
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
              browserOpen: storedBrowser,
              browserIds: isElectron ? readBrowserTabIds()[row.path] ?? [] : [],
              kbOpen: storedKb,
              kbIds: storedKbIds,
              diffOpen: storedDiff,
              filesOpen: storedFiles,
              claudeStatus: row.claudeStatus,
              claudeStatusById: row.claudeStatusById,
              parkedClaudeIds: row.parkedClaudeSessions,
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
      const proc = evt.data.process as { status?: string; port?: number | null; detectedUrl?: string | null; proxyUrl?: string | null; exitCode?: number | null; tab?: 'run' | null } | undefined;
      // Another run command's process (the default's comes as `process`).
      const run = (evt.data as { run?: ProcState & { runId?: string; name?: string } }).run;
      if (run?.runId) {
        setRuns((prev) => ({ ...prev, [path]: { ...prev[path], [run.runId!]: { ...prev[path]?.[run.runId!], ...run } } }));
      }
      if (proc) {
        setProcs((prev) => ({
          ...prev,
          [path]: { status: 'idle', ...prev[path], ...proc },
        }));
        // The server took the start: whatever the last click complained about is moot.
        if (proc.status === 'starting' || proc.status === 'running') {
          setRunError((cur) => (cur?.path === path ? null : cur));
        }
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
            browserOpen: false,
            browserIds: [],
            kbOpen: false,
            kbIds: [],
            diffOpen: false,
            filesOpen: false,
            claudeStatus: evt.data.claudeStatus,
            claudeStatusById: evt.data.claudeStatusById,
            parkedClaudeIds: Array.isArray(evt.data.parkedClaudeSessions) ? (evt.data.parkedClaudeSessions as string[]) : undefined,
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
        if (Array.isArray(evt.data.parkedClaudeSessions)) {
          ng.parkedClaudeIds = evt.data.parkedClaudeSessions as string[];
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
    });
   }, [worktree.path, remote]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc peels popovers (the add-session menu). The hub itself is left via
      // Back / sidebar, not Esc.
      if (addMenuRef.current) setAddMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);



  // Phase 2: the hub is scoped to one worktree — render only its own group.
  // Cross-worktree groups may still exist in `groups` (SSE), but they never
  // surface in the UI now that the super-tab row is gone.
  const ordered = useMemo(() => {
    const own = groups.find((g) => g.path === worktree.path);
    return own ? [own] : [];
  }, [groups, worktree.path]);

  const activeGroup = ordered.find((g) => g.path === active.path) ?? null;
  const tabs = activeGroup ? groupTabs(activeGroup, shellNames, browserMeta, kbTitles, remoteShells[activeGroup.path] ?? [], browserEmbeds) : [];

  // ---------- split panes (Cmd+D / Cmd+Shift+D) ----------
  const isPtyMode = (m: Tab['mode']): m is PtyTab['mode'] =>
    m !== 'browser' && m !== 'kb' && m !== 'diff' && m !== 'files';
  // Resolve against the actual strip rather than reparsing the key. Besides
  // keeping remote runner identity exact, this lets Browser and Knowledge Base
  // leaves participate in the same layout tree as PTY sessions.
  const keyToTab = (path: string, key: string): Tab | null =>
    path === worktree.path
      ? tabs.find((entry) => tabKeyOf(entry.tab) === key)?.tab ?? null
      : null;
  const [newPaneKey, setNewPaneKey] = useState<string | null>(null);
  const newPaneSeqRef = useRef(0);
  const pendingSurfaceRef = useRef<{ placeholder: string; path: string } | null>(null);
  const layouts = paneLayouts[worktree.path] ?? [];
  const splitGroups = layouts.map((node, layoutIndex) => ({
    node,
    layoutIndex,
    tabs: tabs.filter((entry) => hasLeaf(node, tabKeyOf(entry.tab))),
  }));
  const splitTabKeys = new Set(splitGroups.flatMap((group) => group.tabs.map((entry) => tabKeyOf(entry.tab))));
  // Each layout is one conceptual tab group, its members kept together where
  // its first one already sat: splitting never moves tabs around the strip.
  const displayedTabs = layouts.length > 0
    ? tabs.flatMap((entry) => {
        const key = tabKeyOf(entry.tab);
        if (!splitTabKeys.has(key)) return [entry];
        const group = splitGroups.find((g) => g.tabs.some((t) => tabKeyOf(t.tab) === key))!;
        return tabKeyOf(group.tabs[0]!.tab) === key ? group.tabs : [];
      })
    : tabs;
  // The rendered tree: an explicit split layout when its tab group is active,
  // or the active dockable tab as an implicit single pane. A tab removed from a
  // split is deliberately outside `layout`, so selecting it gives it the full
  // surface while the remaining tiled layout stays available from its tabs.
  // Floating tabs draw over the tiled area; when the active tab is one, the
  // tiled area keeps showing what was under it (the last tiled tab you were on).
  const floats = (paneFloats[worktree.path] ?? []).filter((f) => tabs.some((t) => tabKeyOf(t.tab) === f.key));
  const floatKeys = new Set(floats.map((f) => f.key));
  const focusedKey = tabKeyOf(active);
  const lastTiledRef = useRef<string | null>(null);
  const tiledOk = (key: string | null): key is string => !!key && !floatKeys.has(key) && tabs.some((t) => tabKeyOf(t.tab) === key);
  const activePaneKey = !floatKeys.has(focusedKey) ? focusedKey
    : tiledOk(lastTiledRef.current) ? lastTiledRef.current
    : tabs.map((t) => tabKeyOf(t.tab)).find((key) => !floatKeys.has(key)) ?? '';
  if (!floatKeys.has(focusedKey)) lastTiledRef.current = focusedKey;
  const activeLayoutIndex = layouts.findIndex((candidate) => hasLeaf(candidate, activePaneKey));
  // A choice made in an empty pane: until the layout effect below swaps the new
  // tab in, draw it there already. Otherwise it renders full-size for a frame
  // (a whole-surface terminal, then the split animating in all over again).
  const pending = pendingSurfaceRef.current;
  const pendingIndex = activeLayoutIndex < 0 && pending?.path === worktree.path && active.path === worktree.path
    ? layouts.findIndex((candidate) => hasLeaf(candidate, pending.placeholder)) : -1;
  const layout = activeLayoutIndex >= 0 ? layouts[activeLayoutIndex]!
    : pendingIndex >= 0 ? replaceLeaf(layouts[pendingIndex]!, pending!.placeholder, activePaneKey) : null;
  const paneTree: PaneNode = layout ?? { kind: 'leaf', key: activePaneKey };
  // Mount a PTY surface the first time its tab/group is shown, then retain it
  // until the tab closes. The flat persistent layer below prevents switching
  // groups from tearing down xterm and reconnecting its WebSocket.
  const mountedPtyKeysRef = useRef(new Set<string>());
  const livePtyKeys = new Set(
    tabs.filter(({ tab }) => isPtyMode(tab.mode)).map(({ tab }) => tabKeyOf(tab)),
  );
  for (const key of mountedPtyKeysRef.current) {
    if (!livePtyKeys.has(key)) mountedPtyKeysRef.current.delete(key);
  }
  // Every pane on screen: the tiled tree's, then the floating ones.
  const viewKeys = [...leafKeys(paneTree), ...floatKeys];
  const inView = (key: string) => hasLeaf(paneTree, key) || floatKeys.has(key);
  for (const key of viewKeys) {
    const tab = keyToTab(worktree.path, key);
    if (tab && isPtyMode(tab.mode)) mountedPtyKeysRef.current.add(key);
  }

  const commitLayoutAt = (layoutIndex: number, node: PaneNode | null) => {
    const next = [...(paneLayoutsRef.current[worktree.path] ?? [])];
    if (layoutIndex >= 0) {
      if (node?.kind === 'split') next[layoutIndex] = node;
      else next.splice(layoutIndex, 1);
    } else if (node?.kind === 'split') {
      next.push(node);
    }
    setLayouts(worktree.path, next);
  };

  // A tab already in the tiled layout restores that layout and focuses its
  // pane. A normal/undocked tab opens full-size without destroying the layout.
  const activateTab = (tab: Tab) => {
    setActive(tab);
  };

  // Split the focused pane, spawning a fresh session of the same mode into
  // the new half (right for row, below for col).
  const splitPaneAt = (at: Tab, dir: 'row' | 'col') => {
    if (!isPtyMode(at.mode) || at.path !== worktree.path) return;
    const newTab = allocSession(at.mode);
    if (!newTab) return;
    commitLayoutAt(activeLayoutIndex, splitLeaf(paneTree, tabKeyOf(at), tabKeyOf(newTab), dir));
    setActive(newTab);
  };
  const splitPane = (dir: 'row' | 'col') => splitPaneAt(active, dir);
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
        const current = prev[worktree.path];
        const cur = current?.[activeLayoutIndex];
        if (!current || !cur) return prev;
        const next = [...current];
        next[activeLayoutIndex] = withRatio(cur, addr, ratio);
        return { ...prev, [worktree.path]: next };
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      // ratios changed live in state; persist the final tree once
      rememberPaneLayouts(worktree.path, paneLayoutsRef.current[worktree.path] ?? []);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  // Each leaf's card (drop targets measure it) and its body (live surfaces are placed over it).
  const paneLeafElsRef = useRef(new Map<string, HTMLDivElement>());
  const paneBodyElsRef = useRef(new Map<string, HTMLDivElement>());
  const paneSurfaceRef = useRef<HTMLDivElement>(null);
  const [paneRects, setPaneRects] = useState<Record<string, {
    left: number;
    top: number;
    width: number;
    height: number;
  }>>({});

  const openPaneAsFullTab = (tab: Tab) => {
    const current = paneLayoutsRef.current[worktree.path] ?? [];
    const index = current.findIndex((candidate) => hasLeaf(candidate, tabKeyOf(tab)));
    if (index >= 0) {
      commitLayoutAt(index, removeLeaf(current[index]!, tabKeyOf(tab)));
    }
    setActive(tab);
  };

  // A card's Split right/down makes an empty pane on that side at once (a
  // `new:` placeholder leaf) holding "Open a surface", the + menu's kinds.
  // A choice runs exactly as the + menu would; the tab it makes active then
  // takes the placeholder's place. Esc / ✕ / focus leaving drop the pane.
  const withoutLeaf = (nodes: PaneNode[], key: string) => nodes
    .map((node) => (hasLeaf(node, key) ? removeLeaf(node, key) : node))
    .filter((node): node is PaneNode => node?.kind === 'split');
  const openEmptyPane = (anchor: Tab, dir: 'row' | 'col') => {
    const current = newPaneKey ? withoutLeaf(paneLayoutsRef.current[worktree.path] ?? [], newPaneKey) : paneLayoutsRef.current[worktree.path] ?? [];
    const key = `new:${++newPaneSeqRef.current}`;
    const anchorKey = tabKeyOf(anchor);
    const index = current.findIndex((l) => hasLeaf(l, anchorKey));
    const base: PaneNode = index >= 0 ? current[index]! : { kind: 'leaf', key: anchorKey };
    const placed = splitLeaf(base, anchorKey, key, dir);
    setLayouts(worktree.path, index >= 0 ? current.map((l, i) => (i === index ? placed : l)) : [...current, placed]);
    setNewPaneKey(key);
    if (!sameTab(active, anchor)) setActive(anchor);
  };
  const cancelEmptyPane = () => {
    if (!newPaneKey) return;
    setLayouts(worktree.path, withoutLeaf(paneLayoutsRef.current[worktree.path] ?? [], newPaneKey));
    setNewPaneKey(null);
  };
  useLayoutEffect(() => {
    const p = pendingSurfaceRef.current;
    if (!p) return;
    pendingSurfaceRef.current = null;
    if (active.path !== p.path) return;
    const key = tabKeyOf(active);
    // Lifted out of wherever it already sat (a one-per-worktree tab), then
    // put where the empty pane is.
    const current = withoutLeaf(paneLayoutsRef.current[p.path] ?? [], key);
    setLayouts(p.path, current.map((l) => (hasLeaf(l, p.placeholder) ? replaceLeaf(l, p.placeholder, key) : l)));
    setNewPaneKey(null);
    // Only the tab the choice activated, in this same commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const openSurface = (option: NewSessionOption) => {
    if (!newPaneKey) return;
    pendingSurfaceRef.current = { placeholder: newPaneKey, path: worktree.path };
    option.run();
    // Nothing became active (the choice opened nothing): forget the intent.
    // A task, not a microtask: React commits the choice's updates first.
    window.setTimeout(() => { pendingSurfaceRef.current = null; }, 0);
  };

  // Tab groups: a split layout is ONE tab in the strip. Clicking it shows the
  // layout (its focused member, else its first); renaming names the group;
  // closing closes every member, each with its own busy confirm.
  const requestCloseTabRef = useRef<(tab: Tab) => Promise<void>>(async () => {});
  // Each group tab's member keys (a click on the group touches all of them).
  const groupKeysRef = useRef(new Map<number, string[]>());
  const stripGroups = splitGroups
    .filter((group) => group.tabs.length > 1)
    .map((group) => ({
      layoutIndex: group.layoutIndex,
      keys: group.tabs.map((entry) => tabKeyOf(entry.tab)),
      name: groupName(group.node),
      active: group.layoutIndex === activeLayoutIndex,
    }));
  groupKeysRef.current = new Map(stripGroups.map((g) => [g.layoutIndex, g.keys]));
  const activateGroup = (layoutIndex: number) => {
    const group = splitGroups.find((g) => g.layoutIndex === layoutIndex);
    if (!group || group.layoutIndex === activeLayoutIndex) return;
    const first = group.tabs[0];
    if (first) activateTab(first.tab);
  };
  const renameGroup = (layoutIndex: number, name: string | null) => {
    const current = paneLayoutsRef.current[worktree.path] ?? [];
    if (!current[layoutIndex]) return;
    setLayouts(worktree.path, current.map((node, i) => (i === layoutIndex ? withGroupName(node, name) : node)));
  };
  const closeGroup = async (layoutIndex: number) => {
    const members = splitGroups.find((g) => g.layoutIndex === layoutIndex)?.tabs.map((entry) => entry.tab) ?? [];
    for (const tab of members) await requestCloseTabRef.current(tab);
  };

  const renderLeaf = (key: string, floating = false): React.ReactNode => {
    if (key === newPaneKey) {
      return (
        <PaneCard
          key={key}
          paneKey={key}
          title="New pane"
          icon={<PlusIcon className="text-zinc-500" />}
          focused
          docked
          hostRef={(el) => {
            if (el) paneLeafElsRef.current.set(key, el);
            else paneLeafElsRef.current.delete(key);
          }}
          bodyRef={() => {}}
          onActivate={() => {}}
          onClose={cancelEmptyPane}
        >
          <div
            className="h-full w-full"
            onBlur={(e) => {
              // Focus moved to something else in the hub: the pane was abandoned.
              const to = e.relatedTarget as Node | null;
              if (to && !e.currentTarget.contains(to)) cancelEmptyPane();
            }}
          >
            <OpenSurface options={newSessionOptions()} onPick={openSurface} onCancel={cancelEmptyPane} />
          </div>
        </PaneCard>
      );
    }
    const tab = keyToTab(worktree.path, key);
    if (!tab) return null;
    const entry = tabs.find((t) => tabKeyOf(t.tab) === key);
    const label = entry?.label ?? key;
    const docked = !floating && !!layout && hasLeaf(layout, key);
    const canSplit = !floating && tab.path === worktree.path;
    return (
      <PaneCard
        key={key}
        paneKey={key}
        title={label}
        subtitle={tab.mode === 'diff' && tab.path === worktree.path
          ? [worktree.meta?.ticketId || worktree.path.split('/').pop(), gitStatus?.branch].filter(Boolean).join(' · ')
          : undefined}
        icon={<TabTile mode={tab.mode} icon={entry?.icon} />}
        focused={!newPaneKey && sameTab(active, tab)}
        docked={docked}
        floating={floating}
        hostRef={(el) => {
          if (el) paneLeafElsRef.current.set(key, el);
          else paneLeafElsRef.current.delete(key);
        }}
        bodyRef={(el) => {
          if (el) paneBodyElsRef.current.set(key, el);
          else paneBodyElsRef.current.delete(key);
        }}
        onActivate={() => { if (!sameTab(active, tab)) setActive(tab); }}
        onSplitRight={canSplit ? () => openEmptyPane(tab, 'row') : undefined}
        onSplitDown={canSplit ? () => openEmptyPane(tab, 'col') : undefined}
        onFullTab={docked ? () => openPaneAsFullTab(tab) : undefined}
        onFloat={canSplit ? () => floatPane(tab) : undefined}
        onDock={floating ? () => dockFloat(key) : undefined}
        onHeaderPointerDown={floating ? (e) => startFloatDrag(e, key, 'move') : undefined}
        onClose={() => { void requestCloseTab(tab); }}
      />
    );
  };

  // Browser and Knowledge Base stay mounted in their existing persistent
  // layer, then align over their tree leaf. This is essential for Browser's
  // native WebContentsView bounds and prevents the KB's selected document,
  // filter and scroll state from resetting whenever layout focus changes.
  const paneTreeSignature = JSON.stringify([paneTree, floats]);
  // Re-measure now (a floating pane let go after a drag moved it).
  const remeasureRef = useRef<() => void>(() => {});
  useEffect(() => {
    const surface = paneSurfaceRef.current;
    if (!surface) {
      setPaneRects((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    const apply = () => {
      const outer = surface.getBoundingClientRect();
      const next: typeof paneRects = {};
      for (const key of viewKeys) {
        const el = paneBodyElsRef.current.get(key) ?? paneLeafElsRef.current.get(key);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        next[key] = {
          left: rect.left - outer.left,
          top: rect.top - outer.top,
          width: rect.width,
          height: rect.height,
        };
      }
      setPaneRects((prev) => {
        const keys = Object.keys(next);
        if (
          keys.length === Object.keys(prev).length &&
          keys.every((key) => {
            const a = prev[key];
            const b = next[key]!;
            return !!a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
          })
        ) return prev;
        return next;
      });
    };
    // A resize lands in the same frame: the observer runs after layout and
    // before paint, so measuring there and rendering synchronously paints the
    // panes on their slots. Deferred a frame, they trailed every resize (the
    // sidebar sliding shook the Changes pane, then it snapped into place).
    const sync = () => flushSync(apply);
    remeasureRef.current = sync;
    apply();
    const ro = new ResizeObserver(sync);
    ro.observe(surface);
    for (const key of viewKeys) {
      const el = paneBodyElsRef.current.get(key) ?? paneLeafElsRef.current.get(key);
      if (el) ro.observe(el);
    }
    window.addEventListener('resize', sync);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
    };
    // paneTreeSignature captures leaf membership, nesting and live ratios.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneTreeSignature]);

  const dockedSurfaceStyle = (key: string): React.CSSProperties | undefined => {
    const rect = paneRects[key];
    return rect
      ? { position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : undefined;
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
    const base = groupTabs(g, shellNames, browserMeta, kbTitles, remoteShells[g.path] ?? [], browserEmbeds);
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
    // Cmd+Arrow cycles the worktree's tabs. Cmd+Opt+Arrow is focus-group
    // cycling, handled by the dashboard (useFocusShortcut).
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
      // Cmd+L opens (or jumps to) the worktree's Changes tab (diff + its MR). Ctrl+L deliberately
      // falls through so shells keep their clear-screen binding.
      if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'l') {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        openChangesRef.current();
        return;
      }
      // Cmd+P (Ctrl+P off a Mac): go to a file in the active worktree, in the
      // Files tab. Only with focus in the hub (never forwarded from an embed).
      if (filePickerKey(e, isMacPlatform())) {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        openFilePickerRef.current();
        return;
      }
      // Cmd+Shift+F (Ctrl+Shift+F off a Mac): search the worktree's files,
      // from any tab (a terminal, an agent, Files itself), as in VS Code. A
      // dialog keeps its keys. Cmd+F stays each pane's own find.
      if (filesSearchKey(e, isMacPlatform())) {
        if ((e.target as Element | null)?.closest?.('[role="dialog"], [aria-modal="true"]')) return;
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        openFilesSearchRef.current();
        return;
      }
      // Cmd+O (Cmd+Shift+O too) opens the active tab in the person's editor:
      // a Files tab's open file at its cursor, else the worktree. A dialog (the
      // palette's agent cards open with ⌘O) keeps its own.
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'o') {
        if ((e.target as Element | null)?.closest?.('[role="dialog"], [aria-modal="true"]')) return;
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        openWorktreeInEditorRef.current();
        return;
      }
      // Cmd+W closes the active tab (terminal/shell/agent focus lands here;
      // Browser focus arrives via the 'close-tab' IPC combo below).
      if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'w') {
        // Inside the Files tab with a file tab open, ⌘W closes that file tab
        // (its own handler); the hub's tab stays.
        if ((e.target as Element | null)?.closest?.('[data-files-tab][data-file-tab-open]')) return;
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
      // Renderer-focused only, on purpose: an embed keeps its own Cmd+D.
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'd') {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        splitPaneRef.current(e.shiftKey ? 'col' : 'row');
        return;
      }
      // Cmd+Opt+Arrow belongs to focus-group cycling (useFocusShortcut).
      if (!e.metaKey || e.altKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
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
    // chords pressed inside an embed (the Browser preview view)
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
        openChangesRef.current();
        return;
      }
      if (combo === 'files-search') {
        openFilesSearchRef.current();
        return;
      }
      const dir = combo === 'tab-next' ? 1 : combo === 'tab-prev' ? -1 : null;
      if (dir === null) return; // palette, group-* (focus groups), etc. — handled elsewhere
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
        const url = resolvedBrowserUrl(pk, path);
        setSwitchCards((p) => ({ ...p, [cardKey]: { url } }));
        void window.strado?.preview?.('thumb', pk).then((r) => {
          if (alive && typeof r === 'string' && r.startsWith('data:')) {
            setSwitchCards((p) => ({ ...p, [cardKey]: { url, img: r } }));
          }
        });
      } else if (t.mode !== 'kb' && t.mode !== 'diff' && t.mode !== 'files') {
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
      for (const t of groupTabs(activeGroup, shellNames, browserMeta, kbTitles, remoteShells[activeGroup.path] ?? [], browserEmbeds)) {
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
  // Sessions die from anywhere (✕, kill, server exit): drop their panes; a
  // tree collapsing to a single leaf clears the stored layout.
  const tabKeysJoined = tabs.map((t) => tabKeyOf(t.tab)).join(',');
  useEffect(() => {
    if (layouts.length === 0) return;
    const valid = new Set(tabKeysJoined.split(',').filter(Boolean));
    if (newPaneKey) valid.add(newPaneKey);
    if (!layouts.some((candidate) => leafKeys(candidate).some((key) => !valid.has(key)))) return;
    const pruned = layouts
      .map((candidate) => pruneLeaves(candidate, valid))
      .filter((candidate): candidate is PaneNode => candidate?.kind === 'split');
    setLayouts(worktree.path, pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts, tabKeysJoined, worktree.path, newPaneKey]);
  const tabElsRef = useRef(new Map<string, HTMLElement>());
  const TAB_GAP = 2; // gap-0.5 in the strip
  const tabDragRef = useRef<null | {
    key: string;
    el: HTMLElement;
    startX: number;
    startY: number;
    pointerId: number;
    started: boolean;
    fromIdx: number;
    insertIdx: number; // insertion index among the OTHER tabs (0..others.length)
    slots: { key: string; el: HTMLElement; center: number; width: number }[];
  }>(null);
  const justDraggedRef = useRef(false);
  const [tabDragging, setTabDragging] = useState(false);
  const [paneDrop, setPaneDrop] = useState<null | {
    draggedKey: string;
    targetKey: string;
    side: PaneDockSide;
    rect: { left: number; top: number; width: number; height: number };
  }>(null);
  const paneDropRef = useRef(paneDrop);
  paneDropRef.current = paneDrop;

  const clearTabDragStyles = (d: NonNullable<typeof tabDragRef.current>) => {
    for (const s of d.slots) {
      s.el.style.transition = '';
      s.el.style.transform = '';
      s.el.style.zIndex = '';
      s.el.style.position = '';
      s.el.style.boxShadow = '';
      s.el.style.cursor = '';
    }
  };

  const paneDropAt = (draggedKey: string, x: number, y: number) => {
    const dragged = keyToTab(worktree.path, draggedKey);
    if (!dragged) return null;
    for (const [targetKey, el] of paneLeafElsRef.current) {
      if (targetKey === draggedKey || floatKeys.has(targetKey)) continue;
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      const distances: Array<[PaneDockSide, number]> = [
        ['left', x - rect.left],
        ['right', rect.right - x],
        ['top', y - rect.top],
        ['bottom', rect.bottom - y],
      ];
      distances.sort((a, b) => a[1] - b[1]);
      return {
        draggedKey,
        targetKey,
        side: distances[0]![0],
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    }
    return null;
  };

  // Docks a dragged tab (or floating pane) on a side of the pane under it.
  const dockAt = (drop: NonNullable<ReturnType<typeof paneDropAt>>) => {
    const current = paneLayoutsRef.current[worktree.path] ?? [];
    const targetIndex = current.findIndex((candidate) => hasLeaf(candidate, drop.targetKey));
    const sourceIndex = current.findIndex((candidate) => hasLeaf(candidate, drop.draggedKey));
    const targetBase = targetIndex >= 0
      ? current[targetIndex]!
      : { kind: 'leaf', key: drop.targetKey } satisfies PaneNode;
    const docked = dockLeaf(targetBase, drop.draggedKey, drop.targetKey, drop.side);
    if (docked === targetBase) return;
    const next: PaneNode[] = [];
    current.forEach((candidate, index) => {
      if (index === targetIndex) next.push(docked);
      else if (index === sourceIndex) {
        const pruned = removeLeaf(candidate, drop.draggedKey);
        if (pruned?.kind === 'split') next.push(pruned);
      } else next.push(candidate);
    });
    if (targetIndex < 0) next.push(docked);
    setLayouts(worktree.path, next);
    const tab = keyToTab(worktree.path, drop.draggedKey);
    if (tab) setActive(tab);
  };

  // ── Floating panes ──────────────────────────────────────────────────────
  const floatPopRef = useRef<string | null>(null);
  const floatPane = (tab: Tab) => {
    const key = tabKeyOf(tab);
    const current = paneLayoutsRef.current[worktree.path] ?? [];
    const index = current.findIndex((l) => hasLeaf(l, key));
    if (index >= 0) {
      // What stays tiled is what the area shows: the pane beside it.
      const rest = removeLeaf(current[index]!, key);
      if (rest) lastTiledRef.current = leafKeys(rest)[0] ?? null;
      setLayouts(worktree.path, withoutLeaf(current, key));
    } else if (lastTiledRef.current === key) {
      lastTiledRef.current = null;
    }
    const list = (paneFloatsRef.current[worktree.path] ?? []).filter((f) => f.key !== key);
    setFloats(worktree.path, [...list, nextFloatBox(key, list)]);
    floatPopRef.current = key;
    setActive(tab);
  };
  const dockFloat = (key: string) => {
    setFloats(worktree.path, (paneFloatsRef.current[worktree.path] ?? []).filter((f) => f.key !== key));
  };
  // A floating pane just appeared: it rises into place, card and live surface together.
  useEffect(() => {
    const key = floatPopRef.current;
    if (!key || !paneRects[key]) return;
    floatPopRef.current = null;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const els = [
      document.querySelector<HTMLElement>(`[data-float-key="${CSS.escape(key)}"]`),
      ...document.querySelectorAll<HTMLElement>(`[data-surface-key="${CSS.escape(key)}"]`),
    ];
    for (const el of els) {
      el?.animate?.(
        [{ opacity: 0, transform: 'translateY(10px) scale(0.96)' }, { opacity: 1, transform: 'none' }],
        { duration: 260, easing: 'linear(0, 0.2 6%, 0.51 13%, 0.78 21%, 0.95 29%, 1.03 37%, 1.04 44%, 1.025 52%, 1.008 62%, 0.999 74%, 1)' },
      );
    }
  }, [paneRects]);
  // Move a floating pane by its header, or resize it by its corner. The card
  // and its live surface move together by transform (no re-render per frame);
  // the box is committed on release. Over another pane, the dock preview shows
  // and letting go docks it there.
  const startFloatDrag = (e: React.PointerEvent<HTMLElement>, key: string, mode: 'move' | 'resize') => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const card = document.querySelector<HTMLElement>(`[data-float-key="${CSS.escape(key)}"]`);
    const area = card?.parentElement?.getBoundingClientRect();
    const box = (paneFloatsRef.current[worktree.path] ?? []).find((f) => f.key === key);
    if (!card || !area || !box) return;
    e.preventDefault();
    const handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
    const surfaces = [
      ...document.querySelectorAll<HTMLElement>(`[data-surface-key="${CSS.escape(key)}"]`),
      ...document.querySelectorAll<HTMLElement>(`[data-float-grip="${CSS.escape(key)}"]`),
    ];
    const start = { x: e.clientX, y: e.clientY };
    const startPx = { w: box.w * area.width, h: box.h * area.height };
    // React owns the card's width/height (percentages): put back exactly what was there.
    const own = { w: card.style.width, h: card.style.height };
    let drop: ReturnType<typeof paneDropAt> = null;
    let dx = 0;
    let dy = 0;
    const onMove = (ev: PointerEvent) => {
      dx = ev.clientX - start.x;
      dy = ev.clientY - start.y;
      if (mode === 'move') {
        for (const el of [card, ...surfaces]) el.style.transform = `translate(${dx}px, ${dy}px)`;
        // Docks only near a pane's edge: a floating pane always sits over
        // some pane, and moving it must not dock it.
        const hit = paneDropAt(key, ev.clientX, ev.clientY);
        const r = hit?.rect;
        const edge = !r ? Infinity
          : hit.side === 'left' ? ev.clientX - r.left : hit.side === 'right' ? r.left + r.width - ev.clientX
          : hit.side === 'top' ? ev.clientY - r.top : r.top + r.height - ev.clientY;
        const span = hit && (hit.side === 'left' || hit.side === 'right') ? r!.width : r?.height ?? 0;
        const next = edge <= Math.min(72, span * 0.22) ? hit : null;
        if (next?.targetKey !== drop?.targetKey || next?.side !== drop?.side) {
          drop = next;
          setPaneDrop(next);
        }
      } else {
        card.style.width = `${Math.max(FLOAT_MIN.w, startPx.w + dx)}px`;
        card.style.height = `${Math.max(FLOAT_MIN.h, startPx.h + dy)}px`;
      }
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      for (const el of [card, ...surfaces]) el.style.transform = '';
      card.style.width = own.w;
      card.style.height = own.h;
      setPaneDrop(null);
      if (mode === 'move' && drop) {
        dockFloat(key);
        dockAt(drop);
        return;
      }
      const list = paneFloatsRef.current[worktree.path] ?? [];
      const moved = mode === 'move'
        ? { ...box, x: box.x + dx / area.width, y: box.y + dy / area.height }
        : { ...box, w: Math.max(FLOAT_MIN.w, startPx.w + dx) / area.width, h: Math.max(FLOAT_MIN.h, startPx.h + dy) / area.height };
      setFloats(worktree.path, list.map((f) => (f.key === key ? clampFloat(moved) : f)));
      requestAnimationFrame(() => remeasureRef.current());
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };
  // A floating tab that closed takes its float with it.
  useEffect(() => {
    if (tabs.length === 0) return;
    const list = paneFloatsRef.current[worktree.path] ?? [];
    const live = list.filter((f) => tabs.some((t) => tabKeyOf(t.tab) === f.key));
    if (live.length !== list.length) setFloats(worktree.path, live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, worktree.path]);

  const tabPointerDown = (e: React.PointerEvent<HTMLElement>, tKey: string) => {
    if (e.button !== 0 || !activeGroup) return;
    // close button / rename input keep their own gestures
    if ((e.target as HTMLElement).closest('[data-tab-close], input')) return;
    const slots = displayedTabs
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
      key: tKey, el: e.currentTarget, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId,
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
    const dy = e.clientY - d.startY;
    if (!d.started) {
      if (Math.hypot(dx, dy) < 4) return; // click, not a drag
      d.started = true;
      setTabDragging(true);
      try { d.el.setPointerCapture(d.pointerId); } catch { /* pointer gone */ }
      d.el.style.zIndex = '10';
      d.el.style.position = 'relative';
      d.el.style.transition = 'none';
      d.el.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)';
      d.el.style.cursor = 'grabbing';
    }
    const drop = paneDropAt(d.key, e.clientX, e.clientY);
    paneDropRef.current = drop;
    setPaneDrop(drop);
    if (drop || Math.abs(dy) > 10) {
      d.el.style.transform = `translate(${dx}px, ${dy}px)`;
      d.slots.filter((_, i) => i !== d.fromIdx).forEach((s) => {
        s.el.style.transition = 'transform 160ms ease';
        s.el.style.transform = '';
      });
      return;
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

  const tabPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = tabDragRef.current;
    tabDragRef.current = null;
    if (!d || !d.started) return;
    justDraggedRef.current = true;
    // The browser's click after this pointerup is what the guard eats. When
    // the drop folds the dragged tab into a group tab, that click never reaches
    // a tab, so the guard must not outlive this gesture: it would swallow the
    // next real click on another tab.
    window.setTimeout(() => { justDraggedRef.current = false; }, 0);
    // Resolve once more at the release coordinates. This prevents a stale
    // preview from docking after the pointer leaves a pane between the final
    // move event and pointerup.
    const drop = paneDropAt(d.key, e.clientX, e.clientY);
    paneDropRef.current = null;
    setPaneDrop(null);
    setTabDragging(false);
    if (drop) {
      dockAt(drop);
      clearTabDragStyles(d);
      bumpTabOrder();
      return;
    }
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
      clearTabDragStyles(d);
      bumpTabOrder();
    };
    window.setTimeout(finish, 160);
  };

  const tabPointerCancel = () => {
    const d = tabDragRef.current;
    tabDragRef.current = null;
    paneDropRef.current = null;
    setPaneDrop(null);
    setTabDragging(false);
    if (d) clearTabDragStyles(d);
  };

  // If the active tab disappears (closed elsewhere / via SSE), fall back to
  // another tab in the same group, then any group, and close the panel only
  // when no session remains anywhere.
  useEffect(() => {
    const exists = tabs.some(
      (t) => t.tab.path === active.path && t.tab.mode === active.mode && t.tab.id === active.id,
    );
    if (exists) return;
    const fallback = tabs[0] ?? ordered.flatMap((g) => groupTabs(g, shellNames, browserMeta, kbTitles, remoteShells[g.path] ?? [], browserEmbeds))[0];
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

  // The run tab: the shell session the dev server runs in. Open it (as a
  // local tab until the server lists it) and focus it, reusing it if open.
  // A run command's tab (`runId` absent = the default's), listed until the user closes it.
  const addRunTab = (path: string, runId?: string, name?: string) => {
    const id = runTabId(runId);
    setGroups((prev) => prev.map((x) => {
      if (x.path !== path) return x;
      const runNames = runId && name ? { ...x.runNames, [runId]: name } : x.runNames;
      return x.localShellIds.includes(id) ? { ...x, runNames } : { ...x, runNames, localShellIds: sortIds([...x.localShellIds, id]) };
    }));
    return id;
  };
  const openRunTab = (path: string, runId?: string, name?: string) => {
    runTabShownRef.current.add(runShownKey(path, runId ?? ''));
    activateTab({ path, mode: 'shell', id: addRunTab(path, runId, name) });
  };
  addShellRef.current = addShell;

  // Settings' Install buttons: a new Shell tab here, the command typed into it
  // in plain sight (requestRunInShell). Retried while the new shell comes up;
  // if it never takes the command, the command is copied for a paste.
  const runInShellRef = useRef<(req: RunInShellRequest) => void>(() => undefined);
  runInShellRef.current = ({ worktreePath, command }) => {
    if (worktreePath !== worktree.path) return;
    const tab = allocSession('shell');
    if (!tab) return;
    activateTab(tab);
    // A runner's shell is typed into only by the person: the command is copied for a paste there.
    if (remote) {
      navigator.clipboard?.writeText(command).catch(() => undefined);
      setHubHint(`Copied the install command — paste it into this shell on ${remote.runnerName}`);
      return;
    }
    const target = { worktreePath, mode: 'shell' as const, sessionId: tab.id };
    const until = Date.now() + 15_000;
    const attempt = async (): Promise<void> => {
      try {
        await jarvisServerPort(localWsId).run(target, command);
      } catch (err) {
        if (/no live tab|not live/i.test(String((err as Error)?.message ?? err)) && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 250));
          return attempt();
        }
        throw err;
      }
    };
    attempt().catch(() => {
      navigator.clipboard?.writeText(command).catch(() => undefined);
      setHubHint("Couldn't type the command — it's copied; paste it into the shell");
    });
  };
  useEffect(() => {
    const onRun = (e: Event) => {
      const d = (e as CustomEvent<RunInShellRequest>).detail;
      if (d && typeof d.worktreePath === 'string' && typeof d.command === 'string') runInShellRef.current(d);
    };
    window.addEventListener(RUN_IN_SHELL_EVENT, onRun);
    return () => window.removeEventListener(RUN_IN_SHELL_EVENT, onRun);
  }, []);

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
      if (prev[pk] !== undefined) return prev;
      const url = defaultPreviewUrl(g.path);
      if (!url) return prev;
      rememberBrowserUrl(pk, url);
      return { ...prev, [pk]: url };
    });
    setActive({ path: g.path, mode: 'browser', id });
  };

  // Each Knowledge Base tab owns an independent selected document and tree
  // state. The first uses id 1 for backward compatibility; later tabs use the
  // same lowest-free-id scheme as Browser and terminal sessions.
  const addKb = (initialDocument?: string) => {
    const g = activeGroup;
    if (!g) return;
    const used = [...(g.kbOpen ? ['1'] : []), ...g.kbIds];
    let n = 1;
    while (used.includes(String(n))) n++;
    const id = String(n);
    if (id === '1') {
      rememberKbTab(g.path, true);
      setGroups((prev) => prev.map((x) => (x.path === g.path ? { ...x, kbOpen: true } : x)));
    } else {
      const nextIds = sortIds([...g.kbIds, id]);
      rememberKbTabIds(g.path, nextIds);
      setGroups((prev) => prev.map((x) => (x.path === g.path ? { ...x, kbIds: nextIds } : x)));
    }
    if (initialDocument) rememberKbSelection(g.path, id, initialDocument);
    setActive({ path: g.path, mode: 'kb', id });
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

  // The kinds the hub can open, in the new-session (+) menu's order with its
  // rules; a card's split menu offers the same list.
  const newSessionOptions = (): NewSessionOption[] => [
    { mode: 'claude', label: 'Claude', icon: <ClaudeIcon />, run: () => addAgent('claude') },
    { mode: 'codex', label: 'Codex', icon: <CodexIcon />, run: () => addAgent('codex') },
    {
      mode: 'opencode',
      label: 'OpenCode',
      icon: <OpencodeIcon />,
      run: () => addAgent('opencode'),
      disabled: opencodeInstalled === false,
      hint: 'OpenCode needs to be installed to use',
    },
    {
      mode: 'pi',
      label: 'Pi',
      icon: <PiIcon />,
      run: () => addAgent('pi'),
      disabled: piInstalled === false,
      hint: 'Pi needs to be installed to use',
    },
    { mode: 'shell', label: 'Shell', icon: <ShellIcon />, run: addShell },
    { mode: 'kb', label: 'Knowledge Base', icon: <BookIcon />, run: () => addKb() },
    // The diff reads LOCAL git state; a runner worktree has none here.
    ...(!remote ? [{ mode: 'diff', label: 'Changes', icon: <GitIcon />, run: () => openMode('diff') }] : []),
    { mode: 'files', label: 'Files', icon: <FolderIcon size={14} />, run: () => openMode('files') },
    // No per-runner "Shell on <runner>" row: runner worktrees show
    // up in the sidebar like local ones, so a shell opened from
    // THAT worktree already lands on the runner, in the right repo.
    // The old row had to guess a repo (first worktree it found).
    ...(browserEmbeds
      ? [{ mode: 'browser', label: 'Browser', icon: <GlobeIcon />, run: addBrowser }]
      : []),
  ];

  // Header quick-launch: open (or jump to) a Claude/Codex/Files tab for the
  // ACTIVE worktree without leaving the panel. Marking the group open and
  // activating the tab is enough — the terminal WS spawns the pty on connect.
  const openMode = (
    m: 'claude' | 'codex' | 'opencode' | 'pi' | 'browser' | 'kb' | 'diff' | 'files',
    opts?: { path?: string; id?: string },
  ) => {
    const path = opts?.path ?? active.path;
    const id = m === 'diff' || m === 'files' ? '1' : opts?.id ?? '1';
    // Re-opening an agent lifts the user-closed suppression so SSE session
    // detection can drive the tab again.
    if (m === 'claude' || m === 'codex' || m === 'opencode' || m === 'pi') {
      closedAgentsRef.current![m].delete(path);
      rememberClosedAgent(m, path, false);
      killedRemoteRef.current.delete(remoteKillKey(path, m, id));
    }
    if (m === 'diff') rememberDiffTab(path, true);
    if (m === 'files') rememberFilesTab(path, true);
    if (m === 'kb') {
      if (id === '1') rememberKbTab(path, true);
      else {
        const nextIds = sortIds([...(readKbTabIds()[path] ?? []), id]);
        rememberKbTabIds(path, nextIds);
      }
    }
    if (m === 'browser') {
      rememberBrowserTab(path, true);
      setBrowserUrl((prev) => {
        if (prev[path] !== undefined) return prev;
        const url = defaultPreviewUrl(path);
        if (!url) return prev;
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
              browserOpen: g.browserOpen || m === 'browser',
              kbOpen: g.kbOpen || (m === 'kb' && id === '1'),
              kbIds: m === 'kb' && id !== '1' ? sortIds([...g.kbIds, id]) : g.kbIds,
              diffOpen: g.diffOpen || m === 'diff',
              filesOpen: g.filesOpen || m === 'files',
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
      remote: m === 'browser' || m === 'kb' || m === 'diff' || m === 'files' ? null : remoteFor(path),
    });
  };


  // The +/- button and Cmd+L: the worktree's diff as a tab (local git only).
  // Again from the Changes tab goes back to the tab you came from.
  if (active.mode !== 'diff') lastNonDiffRef.current = active;
  const openChanges = () => {
    if (remote) return;
    const back = lastNonDiffRef.current;
    if (activeRef.current.mode === 'diff' && back && tabs.some((t) => sameTab(t.tab, back))) {
      activateTab(back);
      return;
    }
    openMode('diff', { path: worktree.path });
  };
  openChangesRef.current = openChanges;

  // ---------- Files tab: open at a file (⌘P, a path in terminal output) ----------
  // Where each worktree's Files tab should go next; the nonce re-opens the
  // same file (and line) after the user browsed away.
  const [filesOpenPath, setFilesOpenPath] = useState<Record<string, { path: string; line?: number; nonce: number }>>({});
  const openFile = (worktreePath: string, path: string, line?: number) => {
    setFilesOpenPath((prev) => ({
      ...prev,
      [worktreePath]: { path, ...(line ? { line } : {}), nonce: (prev[worktreePath]?.nonce ?? 0) + 1 },
    }));
    openMode('files', { path: worktreePath });
  };
  // ⌘⇧F: the active worktree's Files tab (opened if it isn't), its search panel up.
  const [filesSearch, setFilesSearch] = useState<Record<string, number>>({});
  openFilesSearchRef.current = () => {
    const worktreePath = activeRef.current.path;
    setFilesSearch((prev) => ({ ...prev, [worktreePath]: (prev[worktreePath] ?? 0) + 1 }));
    openMode('files', { path: worktreePath });
  };
  // "Open in editor": the person's own desktop editor, on this machine only (a
  // runner worktree, or a UI a runner box serves, has no desktop editor, so
  // there is no button for one).
  // The editor is named, so it is the one the button says (not a preferred
  // one that has since been uninstalled).
  const { answer: editorAnswer, chosen: editor } = useEditors();
  const openInEditor = remote || localCaps.runner ? undefined : (worktreePath: string, path?: string, line?: number, use = editor?.id) => {
    openEditor(localWsId, { worktreePath, ...(path ? { path } : {}), ...(line ? { line } : {}), ...(use ? { editor: use } : {}) }).catch(() => {
      setHubHint('Couldn’t open the editor. Pick one in Settings › Files.');
    });
  };
  /** The header's Open in editor: a Files tab opens its file at the cursor;
   *  any other tab, the worktree. Finder shows the file's folder. */
  const openTabInEditor = (tab: Tab, use: OpenWith | undefined = editor?.id) => {
    if (!openInEditor) return;
    const file = tab.mode === 'files' ? activeFileRef.current.get(tab.path) ?? null : null;
    if (use === 'finder') {
      const dir = file ? file.path.split('/').slice(0, -1).join('/') : '';
      openInEditor(tab.path, dir || undefined, undefined, 'system');
      return;
    }
    openInEditor(tab.path, file?.path, file?.line, use);
  };
  openWorktreeInEditorRef.current = () => openTabInEditor(activeRef.current);
  // A runner's worktree reads its files through the runner; wsId is then unused.
  // `name` lets the Files tab say which machine an install belongs on.
  const filesTarget = remote ? { runnerId: remote.runnerId, remoteWsId: remote.wsId, name: remote.runnerName } : undefined;
  const listFiles = (worktreePath: string) => api.files.list(wsId, worktreePath, filesTarget);
  // ⌘P opens with results at once: this worktree's list is fetched when the
  // hub opens, after it has settled (idle), not when the picker asks.
  useEffect(() => {
    const prime = () => primeFileList(`${remote?.runnerId ?? 'local'}:${worktree.path}`, () => listFiles(worktree.path));
    const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const handle = idle ? idle(prime, { timeout: 3000 }) : window.setTimeout(prime, 1500);
    return () => { (window as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle); window.clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree.path, remote?.runnerId]);
  // Each worktree's file list, so only paths that exist become links in its
  // terminals. Fetched on the first hover over terminal output, then again
  // when older than a minute (agents add files as they work).
  const knownFilesRef = useRef(new Map<string, { files: Set<string> | null; at: number }>());
  const knownFiles = (worktreePath: string): Set<string> | undefined => {
    const cached = knownFilesRef.current.get(worktreePath);
    if (!cached || Date.now() - cached.at > 60_000) {
      knownFilesRef.current.set(worktreePath, { files: cached?.files ?? null, at: Date.now() });
      listFiles(worktreePath).then(
        (r) => knownFilesRef.current.set(worktreePath, { files: new Set(r.files), at: Date.now() }),
        () => undefined,
      );
    }
    return cached?.files ?? undefined;
  };
  const [filePicker, setFilePicker] = useState<string | null>(null);
  openFilePickerRef.current = () => setFilePicker(activeRef.current.path);
  const [fileAsk, setFileAsk] = useState<FileAskContext | null>(null);
  const [hubHint, setHubHint] = useState<string | null>(null);
  useEffect(() => {
    if (!hubHint) return;
    const t = window.setTimeout(() => setHubHint(null), 5000);
    return () => window.clearTimeout(t);
  }, [hubHint]);

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
    if (openSoft && !tabsRef.current.some((e) => e.tab.mode === modeProp && e.tab.id === sessionIdProp)) return;
    if (modeProp === 'shell') {
      setActive({ path: worktree.path, mode: 'shell', id: sessionIdProp, remote: remoteFor(worktree.path) });
    } else {
      openMode(modeProp, { path: worktree.path, id: sessionIdProp });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSeq]);

  // ---------- app control: agents placing tabs (UiControlContext) ----------
  // Commands arrive async and may wait for a just-spawned session to reach the
  // strip, so everything they read goes through refs, not this render's values.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // ⌘[ / ⌘]: the tab on screen is a place; a closed tab stops being one.
  useEffect(() => {
    onActiveTab?.({ path: active.path, mode: active.mode, id: active.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.path, active.mode, active.id]);
  const openTabsKey = tabs.map((e) => `${e.tab.mode}:${e.tab.id}`).join(',');
  useEffect(() => {
    noteHubTabs(worktree.path, tabsRef.current.map((e) => ({ mode: e.tab.mode, id: e.tab.id })));
  }, [openTabsKey, worktree.path]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const hasTab = (key: string) => tabsRef.current.some((entry) => tabKeyOf(entry.tab) === key);
  // A just-spawned session reaches the strip on worktree.updated; wait for it
  // up to the command's deadline (UiControlContext's per-command budget).
  const waitForTab = async (key: string, deadline: number): Promise<boolean> => {
    while (!hasTab(key)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };
  // A session the server spawned for an agent may not be in the strip yet (or
  // the user closed that agent earlier): an explicit request brings it in.
  const adoptSession = (mode: PtyTab['mode'], id: string) => {
    const path = worktree.path;
    if (mode !== 'shell' && id === '1') {
      closedAgentsRef.current![mode].delete(path);
      rememberClosedAgent(mode, path, false);
      const flag = `${mode}Open` as const;
      setGroups((prev) => prev.map((g) => (g.path === path ? { ...g, [flag]: true } : g)));
      return;
    }
    if (mode === 'shell' && id === '1') return;
    const localKey = ({ shell: 'localShellIds', claude: 'localClaudeIds', codex: 'localCodexIds', opencode: 'localOpencodeIds', pi: 'localPiIds' } as const)[mode];
    setGroups((prev) => prev.map((g) => (g.path === path && !g[localKey].includes(id) ? { ...g, [localKey]: sortIds([...g[localKey], id]) } : g)));
  };
  // Beside the anchor when it is one of this worktree's tabs, else beside the
  // focused pane (`anchor_not_visible`). `tab` leaves the layout alone: a pane
  // shows one tab, so "same pane" is just a new tab in the strip.
  const resolveAnchor = (key: string, place: UiPlace): { anchorKey: string | null; anchorOk: boolean } => {
    const anchor = place.anchor && place.anchor.worktreePath === worktree.path ? hubKeyOf(place.anchor) : null;
    const anchorOk = !!anchor && anchor !== key && hasTab(anchor);
    const current = activeRef.current;
    const fallback = current.path === worktree.path && tabKeyOf(current) !== key ? tabKeyOf(current) : null;
    return { anchorKey: anchorOk ? anchor : fallback, anchorOk };
  };
  const placeTab = (tab: Tab, place: UiPlace): UiCommandAck => {
    const key = tabKeyOf(tab);
    const { anchorKey, anchorOk } = resolveAnchor(key, place);
    if (place.split !== 'tab' && anchorKey) {
      setLayouts(worktree.path, placeLeaf(paneLayoutsRef.current[worktree.path] ?? [], key, anchorKey, place.split));
    }
    if (place.focus) setActive(tab);
    return anchorOk || !place.anchor ? { applied: true } : { applied: true, reason: 'anchor_not_visible' };
  };
  // A new Browser tab in this worktree at `url`; null if it never reached the strip.
  const openBrowserTab = async (url: string, deadline: number): Promise<Tab | null> => {
    if (!browserEmbeds) return null;
    const g = groupsRef.current.find((x) => x.path === worktree.path);
    if (!g) return null;
    const id = nextBrowserId(g.browserOpen, g.browserIds);
    const pk = previewKey(g.path, id);
    rememberBrowserUrl(pk, url);
    setBrowserUrl((prev) => ({ ...prev, [pk]: url }));
    if (id === '1') {
      rememberBrowserTab(g.path, true);
      setGroups((prev) => prev.map((x) => (x.path === g.path ? { ...x, browserOpen: true } : x)));
    } else {
      const nextIds = sortIds([...g.browserIds, id]);
      rememberBrowserTabIds(g.path, nextIds);
      setGroups((prev) => prev.map((x) => (x.path === g.path ? { ...x, browserIds: nextIds } : x)));
    }
    const tab: Tab = { path: g.path, mode: 'browser', id };
    return (await waitForTab(tabKeyOf(tab), deadline)) ? tab : null;
  };

  // Human always wins: panes (or strip tabs) the user clicked lately are off
  // limits to agent commands for a few seconds. Typing doesn't count — typing
  // into an agent's terminal is usually what asked it to open a tab beside
  // itself. (Jarvis, the human's own box, is not subject to this.)
  const humanAtRef = useRef(new Map<string, number>());
  // Typing does count for Jarvis, the human's own box: a model plan acting on
  // the tab you're typing in asks first.
  const typedAtRef = useRef(new Map<string, number>());
  useEffect(() => {
    const noteIn = (map: Map<string, number>) => (event: Event) => {
      const el = (event.target as Element | null)?.closest?.('[data-pane-key],[data-tab-key],[data-group-index]');
      const key = el?.getAttribute('data-pane-key') ?? el?.getAttribute('data-tab-key');
      if (key) map.set(key, Date.now());
      // A group tab stands for all its members.
      const group = el?.getAttribute('data-group-index');
      if (group != null) for (const k of groupKeysRef.current.get(Number(group)) ?? []) map.set(k, Date.now());
    };
    const onPointer = noteIn(humanAtRef.current);
    const onKey = noteIn(typedAtRef.current);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  const recent = (map: Map<string, number>, k: string | null) => k !== null && Date.now() - (map.get(k) ?? -Infinity) < HUMAN_ACTIVE_MS;
  const humanActive = (...keys: (string | null)[]) => keys.some((k) => recent(humanAtRef.current, k));
  const inUse = (key: string) => recent(humanAtRef.current, key) || recent(typedAtRef.current, key);

  const applyUiCommand = async (cmd: ParsedUiCommand, deadline: number): Promise<UiCommandAck> => {
    if (cmd.op === 'place') {
      const key = hubKeyOf(cmd.tab);
      if (humanActive(key, cmd.split === 'tab' && !cmd.focus ? null : resolveAnchor(key, cmd).anchorKey)) {
        return { applied: false, reason: 'human_active' };
      }
      adoptSession(cmd.tab.mode, cmd.tab.sessionId);
      if (!(await waitForTab(hubKeyOf(cmd.tab), deadline))) return { applied: false, reason: 'tab_not_found' };
      return placeTab({ path: worktree.path, mode: cmd.tab.mode, id: cmd.tab.sessionId, remote: null }, cmd);
    }
    if (!browserEmbeds) return { applied: false, reason: 'no_browser' };
    if (cmd.place && cmd.place.split !== 'tab' && humanActive(resolveAnchor('', cmd.place).anchorKey)) {
      return { applied: false, reason: 'human_active' };
    }
    const tab = await openBrowserTab(cmd.url, deadline);
    if (!tab) return { applied: false, reason: 'tab_not_found' };
    // No placement asked (the agent passed place:null): just add the tab to
    // the strip — never steal the user's focus unasked.
    const ack = placeTab(tab, cmd.place ?? { split: 'tab', anchor: null, focus: false });
    return { ...ack, result: { tabId: tab.id } };
  };
  // A runner's worktree isn't addressable by this server: no bridge.
  // ---------- Jarvis (⌘K box): the human's own layout ops ----------
  // Same primitives as agent commands, minus the human_active guard, plus a
  // snapshot for Undo and the strip as parse context.
  // Each tab's hub instance: new when a slot (session number) reappears after
  // closing, so a confirm left open can't land on the tab that replaced it.
  const instancesRef = useRef(new Map<string, string>());
  const nextInstanceRef = useRef(0);
  const instanceOf = (key: string) => {
    let id = instancesRef.current.get(key);
    if (!id) { id = `h${++nextInstanceRef.current}`; instancesRef.current.set(key, id); }
    return id;
  };
  useEffect(() => {
    const live = new Set(tabKeysJoined.split(',').filter(Boolean));
    for (const key of [...instancesRef.current.keys()]) if (!live.has(key)) instancesRef.current.delete(key);
    for (const key of live) instanceOf(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKeysJoined]);
  const toTab = (ref: JTabRef): Tab => ({ path: ref.worktreePath, mode: ref.mode, id: ref.sessionId, remote: ref.mode === 'browser' ? undefined : null });
  const refOfTab = (tab: Tab): JTabRef | null =>
    tab.remote || (!isPtyMode(tab.mode) && tab.mode !== 'browser') ? null : { worktreePath: tab.path, mode: tab.mode as JTabRef['mode'], sessionId: tab.id };
  type HubSnapshot = { panes: PaneNode[]; active: Tab };
  const jarvisHub: JarvisHubPort & { context(): JarvisHubContext } = {
    path: worktree.path,
    // Layout only: tabs a plan opened are undone by their own ops (closeLocal).
    snapshot: (): HubSnapshot => ({ panes: paneLayoutsRef.current[worktree.path] ?? [], active: activeRef.current }),
    restore: (raw) => {
      const snap = raw as HubSnapshot;
      setLayouts(worktree.path, snap.panes);
      if (hasTab(tabKeyOf(snap.active))) setActive(snap.active);
    },
    place: async (ref, place, deadline) => {
      if (ref.worktreePath !== worktree.path) return { ok: false, reason: 'That tab is in another worktree' };
      if (ref.mode !== 'browser') adoptSession(ref.mode, ref.sessionId);
      const tab = toTab(ref);
      if (!(await waitForTab(tabKeyOf(tab), deadline))) return { ok: false, reason: 'The new tab did not show up' };
      placeTab(tab, { split: place.split, anchor: place.anchor as UiTabRef | null, focus: place.focus });
      return { ok: true };
    },
    focus: (ref) => {
      const tab = toTab(ref);
      if (ref.worktreePath !== worktree.path || !hasTab(tabKeyOf(tab))) return false;
      setActive(tab);
      return true;
    },
    openBrowser: async (url, place, deadline) => {
      const tab = await openBrowserTab(url, deadline);
      if (!tab) return null;
      // The human asked to open it: show it unless a placement says otherwise.
      placeTab(tab, place ? { split: place.split, anchor: place.anchor as UiTabRef | null, focus: place.focus } : { split: 'tab', anchor: null, focus: true });
      return { worktreePath: tab.path, mode: 'browser', sessionId: tab.id };
    },
    closeLocal: (ref) => {
      const tab = toTab(ref);
      if (ref.worktreePath === worktree.path && hasTab(tabKeyOf(tab))) closeTab(tab);
    },
    context: () => {
      const g = groupsRef.current.find((x) => x.path === worktree.path);
      // Working, or waiting on the user (a permission prompt, a question): closing loses either.
      const isLiveWork = (st: string | undefined) => st === 'working' || st === 'waiting';
      const statusOf = (mode: string, id: string) => {
        const byId = g?.[`${mode}StatusById` as 'claudeStatusById'];
        return byId?.[id] ?? (id === '1' ? g?.[`${mode}Status` as 'claudeStatus'] : undefined);
      };
      const infos: JTabInfo[] = [];
      for (const entry of tabsRef.current) {
        const ref = refOfTab(entry.tab);
        // humanActive: the box itself isn't held off (it IS the human), but a
        // model plan touching a tab the user just clicked asks first.
        if (ref) infos.push({ ...ref, label: entry.label, busy: ref.mode !== 'shell' && ref.mode !== 'browser' && isLiveWork(statusOf(ref.mode, ref.sessionId)), instance: instanceOf(tabKeyOf(entry.tab)), ...(inUse(tabKeyOf(entry.tab)) ? { humanActive: true } : {}) });
      }
      return { tabs: infos, focused: refOfTab(activeRef.current) };
    },
  };

  const notifyUi = useUiHubBridge(remote ? null : {
    jarvis: jarvisHub,
    path: worktree.path,
    visible: () => leafKeys(paneTree)
      .map((key) => keyToTab(worktree.path, key))
      .filter((tab): tab is Tab & { mode: PtyTab['mode'] } => !!tab && !tab.remote && isPtyMode(tab.mode))
      .map((tab): UiTabRef => ({ worktreePath: tab.path, mode: tab.mode, sessionId: tab.id })),
    layout: () => ({ activeTab: tabKeyOf(active), tabs: tabs.map((entry) => tabKeyOf(entry.tab)), panes: layouts }),
    apply: applyUiCommand,
  });
  useEffect(() => { notifyUi(); }, [notifyUi, activePaneKey, layouts]);

  // Warn before closing a tab with work in progress: a shell with a running
  // command, or an agent that's actively working. Confirmed close falls
  // through to closeTab.
  const requestCloseTab = async (tab: Tab) => {
    // The Files tab with unsaved edits: Save / Don't save / Cancel.
    if (tab.mode === 'files' && !tab.remote) {
      const edited = dirtyFiles(tab.path);
      if (edited.length > 0) {
        const choice = await askSaveChanges(edited);
        if (choice === 'cancel') return;
        if (choice === 'discard') for (const p of edited) discardBuffer(tab.path, p);
        else if (!(await saveAll(tab.path, edited))) return; // refused or failed: the Files tab stays, its bar up
      }
    }
    // The run tab only detaches (the dev server keeps running): nothing to ask.
    if (tab.mode === 'shell' && !isRunTab(tab.id)) {
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
    // Its tab shrinks out of the strip and, in a split, its pane shuts as the neighbour grows.
    const key = tabKeyOf(tab);
    const surface = document.querySelector<HTMLElement>(`[data-testid="terminal-surface-${CSS.escape(key)}"]`);
    const leaving = [animateTabOut(key), animatePaneOut(paneLeafElsRef.current.get(key), surface)].filter((p) => !!p);
    const undos = leaving.length ? await Promise.all(leaving) : [];
    closeTab(tab);
    // The commit that removes it drops the animations (PaneLayout); this is
    // only for a tab that stayed after all. Not sooner: undone before React
    // removes it, the pane flashes back for a frame.
    if (undos.length) window.setTimeout(() => undos.forEach((undo) => undo()), 500);
  };
  closeActiveTabRef.current = () => {
    void requestCloseTab(activeRef.current);
  };
  requestCloseTabRef.current = requestCloseTab;

  // Browser tabs are client-side state mirrored in localStorage.
  // Settings → Sessions closes them by writing storage; run the normal close
  // for any tab here that storage no longer lists, so the strip updates live.
  const closeTabRef = useRef<(tab: Tab) => void>(() => {});
  const groupsForSyncRef = useRef(groups);
  groupsForSyncRef.current = groups;
  useEffect(() => {
    const sync = () => {
      const g = groupsForSyncRef.current.find((x) => x.path === worktree.path);
      if (!g) return;
      if (isElectron) {
        if (g.browserOpen && !readBrowserTabs().has(g.path)) {
          closeTabRef.current({ path: g.path, mode: 'browser', id: '1' });
        }
        const stored = new Set(readBrowserTabIds()[g.path] ?? []);
        for (const id of g.browserIds) {
          if (id !== '1' && !stored.has(id)) closeTabRef.current({ path: g.path, mode: 'browser', id });
        }
      }
    };
    window.addEventListener('strado:browser-tabs', sync);
    return () => {
      window.removeEventListener('strado:browser-tabs', sync);
    };
  }, [worktree.path]);

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
      const currentLayouts = paneLayoutsRef.current[worktree.path] ?? [];
      const containingIndex = currentLayouts.findIndex((candidate) => hasLeaf(candidate, tabKeyOf(tab)));
      if (containingIndex >= 0) {
        const pruned = removeLeaf(currentLayouts[containingIndex]!, tabKeyOf(tab));
        commitLayoutAt(containingIndex, pruned);
        if (pruned && sameTab(active, tab)) {
          const next = keyToTab(worktree.path, leafKeys(pruned)[0]!);
          if (next) setActive(next);
        }
      }
      return;
    }
    // Browser / Knowledge Base / Changes / Files are client-side tabs — nothing
    // to kill server-side.
    // A run tab: its idle post-run shell ends; a live run only detaches (the
    // server refuses with 409 'running' and the dev server keeps running).
    const runTab = tab.mode === 'shell' && isRunTab(tab.id) && !tab.remote;
    if (runTab) api.worktrees.closeRunTab(localWsId, tab.path, runIdOfTab(tab.id) || undefined).catch(() => undefined);
    if (tab.mode !== 'browser' && tab.mode !== 'kb' && tab.mode !== 'diff' && tab.mode !== 'files' && !runTab) {
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
    const currentLayouts = paneLayoutsRef.current[worktree.path] ?? [];
    const containingIndex = tab.path === worktree.path
      ? currentLayouts.findIndex((candidate) => hasLeaf(candidate, tabKeyOf(tab)))
      : -1;
    if (containingIndex >= 0) {
      const pruned = removeLeaf(currentLayouts[containingIndex]!, tabKeyOf(tab));
      commitLayoutAt(containingIndex, pruned);
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
        if (tab.mode === 'diff') {
          rememberDiffTab(tab.path, false);
          return { ...g, diffOpen: false };
        }
        if (tab.mode === 'files') {
          rememberFilesTab(tab.path, false);
          return { ...g, filesOpen: false };
        }
        if (tab.mode === 'kb') {
          forgetKbTabState(tab.path, tab.id);
          if (tab.id === '1') {
            rememberKbTab(tab.path, false);
            return { ...g, kbOpen: false };
          }
          const nextIds = g.kbIds.filter((id) => id !== tab.id);
          rememberKbTabIds(tab.path, nextIds);
          return { ...g, kbIds: nextIds };
        }
        return {
          ...g,
          serverShellIds: g.serverShellIds.filter((i) => i !== tab.id),
          localShellIds: g.localShellIds.filter((i) => i !== tab.id),
        };
      }),
    );
  };
  closeTabRef.current = closeTab;
  // The station (intercom agent) behind a tab: same worktree, kind and session. A runner's shells have none here.
  const stationOfTab = (tab: Tab): StationDto | undefined =>
    tab.remote ? undefined : mission?.stations.find((st) => st.worktreePath === tab.path && st.mode === tab.mode && st.sessionId === tab.id);

  return (
    <SavePromptProvided.Provider value>
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex h-full w-full overflow-hidden bg-zinc-950 outline-none"
    >
      {paneDrop && (() => {
        const { rect, side } = paneDrop;
        const style: React.CSSProperties = {
          position: 'fixed',
          left: side === 'right' ? rect.left + rect.width / 2 : rect.left,
          top: side === 'bottom' ? rect.top + rect.height / 2 : rect.top,
          width: side === 'left' || side === 'right' ? rect.width / 2 : rect.width,
          height: side === 'top' || side === 'bottom' ? rect.height / 2 : rect.height,
        };
        return (
          <div
            data-testid="pane-drop-preview"
            data-dock-side={side}
            className="pointer-events-none z-[100] flex items-center justify-center border-2 border-sky-400 bg-sky-500/20 text-xs font-medium capitalize text-sky-100 shadow-[inset_0_0_32px_rgba(14,165,233,0.12)]"
            style={style}
          >
            Dock {side}
          </div>
        );
      })()}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="app-drag flex items-center gap-2 border-b border-zinc-900 px-3 py-1.5 text-sm text-zinc-200">
          <OpenSidebarButton onClick={onExpandSidebar} />
          {/* tabs scroll inside this container; the status/action controls sit
              at the row's end — one row, maximum vertical space for panes */}
          <TabStrip
            tabs={displayedTabs}
            isActive={(tab) => sameTab(active, tab)}
            splitGroups={splitGroups.map((group) => ({ layoutIndex: group.layoutIndex, keys: group.tabs.map((entry) => tabKeyOf(entry.tab)) }))}
            groups={stripGroups}
            onActivateGroup={activateGroup}
            onCloseGroup={(i) => { void closeGroup(i); }}
            onRenameGroup={renameGroup}
            renaming={renaming}
            onRenaming={setRenaming}
            onRename={(r) => renameSession(r.path, r.mode, r.id, r.value)}
            tabEl={(key, el) => { if (el) tabElsRef.current.set(key, el); else tabElsRef.current.delete(key); }}
            pointer={{ down: tabPointerDown, move: tabPointerMove, up: tabPointerUp, cancel: tabPointerCancel }}
            justDraggedRef={justDraggedRef}
            onActivate={activateTab}
            onClose={(tab) => { void requestCloseTab(tab); }}
            onAdd={(r) => setAddMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }))}
            stateOf={mission ? (tab) => { const st = stationOfTab(tab); return st ? stationState(st) : null; } : undefined}
          />
          {(() => {
            // The default run command's process (the header's main Run).
            const p = procs[active.path] ?? { status: 'idle' as const };
            const crashed = p.status === 'crashed';
            const runNote = runError?.path === active.path
              ? runError.message
              : crashed
                ? `exit code ${p.exitCode ?? '?'}`
                : null;
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
              : p.proxyUrl ?? p.detectedUrl ?? (p.port ? `port ${p.port}` : '');
            const row = rowsRef.current.get(active.path) ?? (active.path === worktree.path ? worktree : undefined);
            const repo = row?.repoId ? reposById[row.repoId] : undefined;
            // The repo's run commands (the first is the default; its state is `p`), else one unnamed default.
            const commands = repo?.runCommands ?? [];
            const runEntries: RunEntry[] = commands.length > 0
              ? commands.map((c, i) => {
                const st = i === 0 ? p : runs[active.path]?.[c.id];
                return { id: c.id, name: c.name, status: (st?.status ?? 'idle') as RunStatus, port: st?.port ?? null };
              })
              : [{ id: '', name: '', status: p.status as RunStatus, port: p.port ?? null }];
            const jiraIssue = row?.meta?.ticketId ? tickets.issues[ticketRef(row.meta.ticketProvider, row.meta.ticketId)] : undefined;
            const spent = formatActiveTime(row?.activitySeconds);
            const origEstimate = jiraIssue?.estimate && !/^0[mhd]$/.test(jiraIssue.estimate) ? jiraIssue.estimate : null;
            return (
              <>
                {showTime && (spent || origEstimate) && (
                  <span
                    className="ml-3 shrink-0 self-center font-mono text-[11px]"
                    title="Active time / original estimate"
                  >
                    {spent && <span className="text-zinc-300">{spent}</span>}
                    {origEstimate && (
                      <span className="text-zinc-600">{spent ? ' / ' : 'est '}{origEstimate}</span>
                    )}
                  </span>
                )}
                {showStatus && (row?.meta || jiraIssue) && (
                  <span className="ml-3 shrink-0 self-center">
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
                {openInEditor && editorAnswer && editor && (
                  <OpenInEditorButton editors={editorAnswer.editors} chosen={editor} onOpen={(e) => openTabInEditor(active, e)} />
                )}
                <RunButton
                  entries={runEntries}
                  defaultId={runEntries[0]?.id ?? null}
                  menu={!remote}
                  detail={detail}
                  onStart={(id) => {
                    const path = active.path;
                    const cmd = runEntries.find((x) => x.id === id);
                    const runId = id === runEntries[0]?.id ? undefined : id;
                    setRunError((cur) => (cur?.path === path ? null : cur));
                    void (async () => {
                      try {
                        try {
                          await (runId ? api.worktrees.start(localWsId, path, runId) : api.worktrees.start(localWsId, path));
                        } catch (err) {
                          // Its run tab is a shell again and the user is running something there: ask.
                          if ((err as { details?: { reason?: string } }).details?.reason !== 'run_tab_busy') throw err;
                          if (!confirm('The run tab is running something. Stop it and run?')) return;
                          await api.worktrees.start(localWsId, path, runId, { force: true });
                        }
                        // A start runs in its run tab: bring it up once the server has made it.
                        if (!remote) openRunTab(path, runId, cmd?.name);
                      } catch (err) {
                        // SSE carries the process states; a refused request has no
                        // SSE and would otherwise be a click that did nothing.
                        setRunError({ path, message: (err as Error).message || 'request failed' });
                      }
                    })();
                  }}
                  onStop={(id) => {
                    const path = active.path;
                    setRunError((cur) => (cur?.path === path ? null : cur));
                    (id === runEntries[0]?.id ? api.worktrees.stop(localWsId, path) : api.worktrees.stop(localWsId, path, id))
                      .catch((err: unknown) => setRunError({ path, message: (err as Error).message || 'request failed' }));
                  }}
                  onOpenTab={(id) => openRunTab(active.path, id === runEntries[0]?.id ? undefined : id, runEntries.find((x) => x.id === id)?.name)}
                  onAdd={() => { if (repo) setRunEditor({ repoId: repo.id }); else setRunError({ path: active.path, message: 'This worktree has no repo to add run commands to' }); }}
                />
                {runNote && (
                  <span
                    role="alert"
                    title={runNote}
                    className="flex max-w-[260px] shrink-0 items-center gap-1.5 self-center text-[11px] text-red-300"
                  >
                    <span className="truncate">{runNote}</span>
                    {crashed && !remote && (
                      <button
                        type="button"
                        onClick={() => openRunTab(active.path)}
                        className="shrink-0 rounded border border-red-500/30 px-1 text-[10px] text-red-200 hover:bg-red-500/10"
                      >Open run tab</button>
                    )}
                  </span>
                )}
              </>
            );
          })()}
          {/* Diff and the changes rail read LOCAL git state. For a worktree on a runner they would silently show
              nothing, so they are absent rather than inert — the same rule the
              capability flag applies to the Browser. */}
          {!remote && (
            <>
              {/* Git without opening Changes: branch, counts, push/pull, Create PR (GitPill). */}
              <GitPill
                wsId={wsId}
                worktree={worktree}
                status={gitStatus}
                additions={activeDiff?.additions ?? 0}
                deletions={activeDiff?.deletions ?? 0}
                active={active.mode === 'diff'}
                onOpenChanges={openChanges}
                onOpenTree={() => { setDiffTreeSeq((n) => n + 1); if (active.mode !== 'diff') openChanges(); }}
              />
            </>
          )}
          {/* Which machine, always visible. Without it a remote hub is
              indistinguishable from a local one. */}
          {remote && (
            <span
              className="shrink-0 self-center rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
              title={`${worktree.path} on ${remote.runnerName}`}
            >
              {remote.runnerName}
            </span>
          )}
        </div>
        {dtMenu && (
          <>
            <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setDtMenu(null); }} />
            <div
              role="menu"
              aria-label="DevTools dock"
              className="surface-pop fixed z-40 w-44 rounded-lg p-1"
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
              <div className="surface-pop flex max-w-[92vw] items-stretch gap-3 overflow-x-auto rounded-xl p-4">
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
          const currentUrl = resolvedBrowserUrl(path, path.split('\0')[0]!);
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
                className="surface-pop fixed z-40 w-52 rounded-lg p-1"
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
              className="surface-pop fixed z-40 w-44 rounded-lg p-1"
              style={{ left: addMenu.x, top: addMenu.y }}
            >
              {newSessionOptions().map((o) => (
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
                  <span className="text-zinc-500">{o.icon}</span>
                  {o.label}
                  {o.disabled && <span className="ml-auto text-[10px] text-zinc-600">{o.badge ?? 'install'}</span>}
                </button>
              ))}
            </div>
          </>
        )}
        <div ref={paneSurfaceRef} className="relative min-h-0 flex-1">
          {/* PTY tabs are mounted lazily on first view and then kept alive in
              this flat layer. The pane tree supplies geometry only, so moving
              between full tabs or split groups never destroys xterm/history
              or reconnects the terminal WebSocket. */}
          {tabs
            .filter(({ tab }) => isPtyMode(tab.mode) && mountedPtyKeysRef.current.has(tabKeyOf(tab)))
            .map(({ tab }) => {
              const paneKey = tabKeyOf(tab);
              const shown = inView(paneKey);
              const placement = dockedSurfaceStyle(paneKey);
              const placed = shown && !!placement;
              const focused = placed && sameTab(active, tab);
              return (
                <div
                  key={`pty:${paneKey}`}
                  data-testid={`terminal-surface-${paneKey}`}
                  data-surface-key={paneKey}
                  className={placed ? `${floatKeys.has(paneKey) ? 'z-30' : 'z-10'} overflow-hidden bg-pane-card` : 'hidden'}
                  style={placement}
                >
                  <XtermPane
                    wsId={wsId}
                    tab={tab as PtyTab}
                    focused={focused}
                    visible={placed}
                    onFocus={() => { if (!focused) setActive(tab); }}
                    onOpenFile={({ path, line }) => openFile(tab.path, path, line)}
                    knownFiles={() => knownFiles(tab.path)}
                  />
                </div>
              );
            })}
          {/* Browser previews: toolbar + placeholder per group; the page
              itself is a main-process WebContentsView glued to the
              placeholder. Panes mount only for the visible tab — the view
              survives hidden in main, so switching tabs never reloads. */}
          {isElectron &&
            groups
              .flatMap((g) => [...(g.browserOpen ? ['1'] : []), ...g.browserIds.filter((i) => i !== '1')].map((bid) => ({ g, bid })))
              .map(({ g, bid }) => {
                const pk = previewKey(g.path, bid);
                const paneKey = tabKeyOf({ mode: 'browser', id: bid });
                const shown = g.path === worktree.path && inView(paneKey);
                const placement = dockedSurfaceStyle(paneKey);
                const placed = shown && !!placement;
                const url = resolvedBrowserUrl(pk, g.path);
                // renderer overlays paint UNDER native views — detach the
                // panes while any menu or in-hub dialog is open
                const overlayUp = !!(modalOpen || dtMenu || bwMenu || addMenu || switcher || tabDragging || paneDrop || filePicker || fileAsk);
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
                  <div
                    key={`bw:${pk}`}
                    data-testid={`browser-pane-${bid}`}
                    data-surface-key={paneKey}
                  className={placed ? `${floatKeys.has(paneKey) ? 'z-30' : 'z-10'} flex flex-col overflow-hidden bg-pane-card` : 'hidden'}
                    style={placement}
                    onPointerDownCapture={() => {
                      if (!sameTab(active, { path: g.path, mode: 'browser', id: bid })) {
                        setActive({ path: g.path, mode: 'browser', id: bid });
                      }
                    }}
                  >
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
                        disabled={!url}
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
                        disabled={!url}
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
                    {url && browserLoad[pk]?.loading && (
                      <div className="h-0.5 w-full overflow-hidden bg-zinc-900">
                        <div className="h-full w-1/3 animate-pulse bg-sky-500" />
                      </div>
                    )}
                    {url && browserLoad[pk]?.error && (
                      <div className="border-b border-zinc-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                        {browserLoad[pk]!.error}
                      </div>
                    )}
                    <div className={`flex min-h-0 flex-1 ${devtoolsMode[pk] === 'right' ? 'flex-row' : 'flex-col'}`}>
                      {placed && url && window.strado?.preview && (
                        <BrowserPreviewPane
                          path={pk}
                          initialUrl={url}
                          suppressed={overlayUp}
                          immediateSuppress={tabDragging}
                          onReady={(wcId) => setPreviewIds((prev) => ({ ...prev, [pk]: wcId }))}
                        />
                      )}
                      {placed && !url && (
                        <div
                          data-testid={`browser-start-${bid}`}
                          className="flex flex-1 flex-col items-center justify-center gap-2 bg-zinc-950 px-6 text-center"
                        >
                          <span className="text-sky-400/70"><GlobeIcon /></span>
                          <p className="text-sm text-zinc-300">Open a preview</p>
                          <p className="max-w-sm text-xs leading-relaxed text-zinc-600">
                            Enter a URL above, or start this worktree&apos;s dev server with Run.
                          </p>
                        </div>
                      )}
                      {placed && url && !window.strado?.preview && (
                        <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-500">
                          Browser preview needs the updated desktop shell — quit the app fully (Cmd+Q) and run `npm run desktop` again.
                        </div>
                      )}
                      {devtoolsMode[pk] && previewIds[pk] !== undefined && (
                        <>
                          {placed && (
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
                            suppressed={!placed || overlayUp}
                            onFail={() => setDevtoolsMode((prev) => ({ ...prev, [pk]: null }))}
                          />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
          {groups
            .flatMap((g) => [...(g.kbOpen ? ['1'] : []), ...g.kbIds.filter((id) => id !== '1')].map((id) => ({ g, id })))
            .map(({ g, id }) => {
              const paneKey = tabKeyOf({ mode: 'kb', id });
              const shown = g.path === worktree.path && inView(paneKey);
              const placement = dockedSurfaceStyle(paneKey);
              const placed = shown && !!placement;
              // Kept mounted so the selected doc and scroll position survive
              // tab switching — it holds no server session, only local state.
              return (
                <div
                  key={`kb-${g.path}-${id}`}
                  data-testid={id === '1' ? `kb-pane-${g.path}` : `kb-pane-${g.path}-${id}`}
                  data-surface-key={paneKey}
                  className={placed ? `${floatKeys.has(paneKey) ? 'z-30' : 'z-10'} overflow-hidden bg-pane-card` : 'hidden'}
                  style={placement}
                  onPointerDownCapture={() => {
                    if (!sameTab(active, { path: g.path, mode: 'kb', id })) {
                      setActive({ path: g.path, mode: 'kb', id });
                    }
                  }}
                >
                  <KnowledgeBasePanel
                    wsId={wsId}
                    worktreePath={g.path}
                    instanceId={id}
                    active={placed}
                    onSelectedPath={(rel) => {
                      const titleKey = `${g.path}\0kb:${id}`;
                      const label = rel?.split('/').pop();
                      setKbTitles((prev) => {
                        if (label ? prev[titleKey] === label : !(titleKey in prev)) return prev;
                        const next = { ...prev };
                        if (label) next[titleKey] = label;
                        else delete next[titleKey];
                        return next;
                      });
                    }}
                    onOpenInNewTab={(rel) => addKb(rel)}
                    onOpenInFiles={(rel) => openFile(g.path, rel)}
                  />
                </div>
              );
            })}
          {groups
            .filter((g) => g.diffOpen && !g.remote)
            .map((g) => {
              const paneKey = tabKeyOf({ mode: 'diff', id: '1' });
              const shown = g.path === worktree.path && inView(paneKey);
              const placement = dockedSurfaceStyle(paneKey);
              const placed = shown && !!placement;
              // Kept mounted like the KB: the selected file and scroll survive tab switches.
              return (
                <div
                  key={`diff-${g.path}`}
                  data-testid={`diff-pane-${g.path}`}
                  data-surface-key={paneKey}
                  className={placed ? `${floatKeys.has(paneKey) ? 'z-30' : 'z-10'} overflow-hidden bg-pane-card` : 'hidden'}
                  style={placement}
                  onPointerDownCapture={() => {
                    if (!sameTab(active, { path: g.path, mode: 'diff', id: '1' })) setActive({ path: g.path, mode: 'diff', id: '1' });
                  }}
                >
                  <DiffView
                    embedded
                    treeSeq={g.path === worktree.path ? diffTreeSeq : 0}
                    active={placed && sameTab(active, { path: g.path, mode: 'diff', id: '1' })}
                    worktree={rowsRef.current.get(g.path) ?? (g.path === worktree.path ? worktree : ({ path: g.path } as Worktree))}
                  />
                </div>
              );
            })}
          {groups
            .filter((g) => g.filesOpen)
            .map((g) => {
              const paneKey = tabKeyOf({ mode: 'files', id: '1' });
              const shown = g.path === worktree.path && inView(paneKey);
              const placement = dockedSurfaceStyle(paneKey);
              const placed = shown && !!placement;
              // Kept mounted like Changes: the open folders, file and scroll survive tab switches.
              return (
                <div
                  key={`files-${g.path}`}
                  data-testid={`files-pane-${g.path}`}
                  data-surface-key={paneKey}
                  className={placed ? `${floatKeys.has(paneKey) ? 'z-30' : 'z-10'} overflow-hidden bg-pane-card` : 'hidden'}
                  style={placement}
                  onPointerDownCapture={() => {
                    if (!sameTab(active, { path: g.path, mode: 'files', id: '1' })) setActive({ path: g.path, mode: 'files', id: '1' });
                  }}
                >
                  <FilesTab
                    wsId={wsId}
                    worktreePath={g.path}
                    remote={filesTarget}
                    openPath={filesOpenPath[g.path]}
                    searchRequest={filesSearch[g.path]}
                    onAskAgent={setFileAsk}
                    onActiveFile={(f) => activeFileRef.current.set(g.path, f)}
                  />
                </div>
              );
            })}
        <div data-testid="xterm-pane" className="relative h-full w-full p-2">
          <PaneLayout node={paneTree} renderLeaf={renderLeaf} onDividerPointerDown={startDividerDrag} />
          {floats.map((f) => (
            <div
              key={`float:${f.key}`}
              data-float-key={f.key}
              className="absolute z-20"
              style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
            >
              {renderLeaf(f.key, true)}
            </div>
          ))}
          {/* Each float's resize corner, above its live surface (which sits over the card). */}
          {floats.map((f) => (
            <div
              key={`float-grip:${f.key}`}
              data-float-grip={f.key}
              aria-label="Resize floating pane"
              onPointerDown={(e) => startFloatDrag(e, f.key, 'resize')}
              className="absolute z-40 -ml-4 -mt-4 h-4 w-4 cursor-nwse-resize"
              style={{ left: `${(f.x + f.w) * 100}%`, top: `${(f.y + f.h) * 100}%` }}
            />
          ))}
        </div>
        </div>
      </div>
      {filePicker && (
        <FilePicker
          load={() => listFiles(filePicker)}
          cacheKey={`${remote?.runnerId ?? 'local'}:${filePicker}`}
          onPick={(path, line) => { setFilePicker(null); openFile(filePicker, path, line); }}
          onClose={() => setFilePicker(null)}
        />
      )}
      {fileAsk && (
        <FileAskDialog
          ctx={fileAsk}
          peers={intercom.peers}
          send={async (agentId, question, context) => {
            await jarvisServerPort(localWsId).message(agentId, question, { ask: true, context });
          }}
          onClose={() => setFileAsk(null)}
        />
      )}
      {hubHint && (
        <div role="status" className="surface-pop fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-lg px-3 py-2 text-[12px] text-zinc-200">
          {hubHint}
        </div>
      )}
      {runEditor && reposById[runEditor.repoId] && (
        <RunCommandsDialog
          repoName={reposById[runEditor.repoId]!.name}
          commands={reposById[runEditor.repoId]!.runCommands ?? []}
          startAdding
          onClose={() => setRunEditor(null)}
          onSave={async (list) => {
            const repoId = runEditor.repoId;
            try {
              const saved = await api.repos.setRunCommands(localWsId, repoId, list);
              setReposById((prev) => (prev[repoId] ? { ...prev, [repoId]: { ...prev[repoId]!, runCommands: saved } } : prev));
            } catch (err) {
              throw new Error(runCommandsError(err));
            }
          }}
        />
      )}
      <SavePromptHost />
    </div>
    </SavePromptProvided.Provider>
  );
}
