import { createContext, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Focus, StationDto } from '../../api';
import { useIntercom } from '../../contexts/IntercomContext';
import { useJarvisActionHandler, useUiHub } from '../../contexts/UiControlContext';
import type { JarvisAppPort, JarvisNavPort } from '../../lib/jarvis/execute';
import { api } from '../../api';
import { runJarvisAction } from './windowAction';
import { storedBrowserTabs } from './storedHub';
import { latestLine, markSeen, newestReply } from './badges';
import { FOCUS_LATEST_CLASS } from '../sidebar/FocusList';
import { readShellNames } from '../../hooks/shellNames';
import { buildModelContext } from '../../lib/jarvis/model';
import { jarvisServerPort } from '../../lib/jarvis/serverPort';
import type { TabRef } from '../../lib/jarvis/types';
import { readWorktreeLru } from '../../lib/worktreeLru';
import type { RepoConfig, Workspace, Worktree } from '../../types';
import { buildParseContext } from '../jarvis/jarvisContext';
import { resolveCard, type ResolvedCard } from './cards';
import { FocusJarvisView, type JarvisStart } from './FocusJarvisView';
import { useFocusJarvis, type FocusJarvis } from './useFocusJarvis';
import { refreshFocuses } from '../../hooks/useFocuses';
import type { ChatEntry } from '../../types';

/** Actions that change the Focus or the worktrees on the server, which push nothing to the window. */
const CHANGES_TREE = new Set(['worktree.create', 'focus.edit']);
export const changesTree = (e: ChatEntry): boolean => e.type === 'action' && e.ok && CHANGES_TREE.has(e.action);

export type OpenCard = (r: Extract<ResolvedCard, { open: true }>) => void;

type Host = { focus: Focus; chat: FocusJarvis; resolve: (c: Parameters<typeof resolveCard>[0]) => ResolvedCard; agents: { label: string; agentId: string }[]; worktrees: { label: string; worktreePath: string }[] };
const HostContext = createContext<Host | null>(null);

/** One Jarvis chat per window, for the active Focus, shared by its sidebar
 * card and its main view. Sends carry this window's context, built exactly
 * as the ⌘K bar builds it. */
export function FocusJarvisProvider({ wsId, focus, focuses, worktrees, repos, workspaces, stations, lastActedOn, onTreeChanged, chatOpen = false, children }: {
  wsId: string;
  focus: Focus | null;
  focuses: Focus[];
  worktrees: Worktree[];
  repos: RepoConfig[];
  workspaces: Workspace[];
  stations: StationDto[];
  lastActedOn: MutableRefObject<TabRef | null>;
  /** Reload the worktree list: a Jarvis action made one on the server. */
  onTreeChanged?: () => void;
  /** The chat is on screen (its cards' live state is worth polling for). */
  chatOpen?: boolean;
  children: ReactNode;
}) {
  const hub = useUiHub();
  const { peers, refresh: refreshPeers } = useIntercom();
  const latest = useRef({ focuses, worktrees, repos, workspaces, stations, peers });
  latest.current = { focuses, worktrees, repos, workspaces, stations, peers };
  /** The context Jarvis sees; `paths` are the Focus worktrees whose stored
   * Browser tabs it lists (the active Focus's, or an action's scope). */
  const parseContext = (paths?: string[]) => {
    const l = latest.current;
    const h = hub();
    const members = paths ?? (focus?.members ?? []).filter((m) => m.startsWith('local:')).map((m) => m.slice('local:'.length));
    return buildParseContext({
      hub: h ? { path: h.path, context: h.jarvis?.context() ?? null } : null,
      peers: l.peers,
      lastActedOn: lastActedOn.current,
      worktrees: l.worktrees,
      lru: readWorktreeLru(),
      focuses: l.focuses,
      activeFocusId: focus?.id ?? null,
      shellNames: readShellNames(),
      workspaces: l.workspaces,
      activeWorkspaceId: wsId,
      repos: l.repos,
      scripts: h ? jarvisServerPort(wsId).cachedScripts(h.path) : null,
      stations: l.stations,
      storedBrowsers: members.flatMap((p) => storedBrowserTabs(p).map((b) => ({ worktreePath: p, sessionId: b.id, label: b.label }))),
    });
  };
  const getContext = () => buildModelContext(parseContext());
  // The turn's tool calls come back to this window as `jarvis.action`: run
  // them here, in the background, with whatever hub is on screen (if any).
  // The action names its turn's Focus; the window may be showing another one.
  useJarvisActionHandler((action) => runJarvisAction(action, {
    context: () => parseContext(action.scope),
    ports: () => ({
      hub: hub()?.jarvis ?? null,
      server: jarvisServerPort(wsId),
      nav: NO_NAV,
      app: jarvisApp(wsId),
    }),
  }));
  // A new worktree or a Focus edit lands in the sidebar now, not on the next reload.
  const chat = useFocusJarvis(wsId, focus?.id ?? null, getContext, (entry) => {
    if (!changesTree(entry)) return;
    void refreshFocuses(wsId);
    onTreeChanged?.();
  });
  // Nothing pushes when a starting tab hits Claude's folder-trust question
  // (peer.attention): poll the peers while the chat is open and a card's tab
  // is still starting — each card for STARTING_POLL_CAP_MS at most (W5).
  const startingIds = chat.entries
    .filter((e) => e.type === 'action' && e.card
      && (() => { const r = resolveCard(e.card, { worktrees, repos, peers }); return r.open && r.status === 'starting'; })())
    .map((e) => e.id);
  const startingKey = startingIds.join(',');
  const startedAt = useRef(new Map<string, number>());
  useEffect(() => {
    const ids = startingKey ? startingKey.split(',') : [];
    trackStarting(startedAt.current, ids, Date.now());
    if (!chatOpen || ids.length === 0) return;
    const timer = setInterval(() => {
      if (!ids.some((id) => Date.now() - startedAt.current.get(id)! < STARTING_POLL_CAP_MS)) { clearInterval(timer); return; }
      void refreshPeers().catch(() => {});
    }, STARTING_POLL_MS);
    return () => clearInterval(timer);
  }, [chatOpen, startingKey, refreshPeers]);
  // While the chat is on screen, its replies are read (the sidebar's ✦ for this Focus).
  const newest = newestReply(chat.entries);
  useEffect(() => {
    if (chatOpen && focus && newest) markSeen(focus.id, newest);
  }, [chatOpen, focus, newest]);
  const value = useMemo<Host | null>(() => {
    if (!focus) return null;
    const inFocus = worktrees.filter((w) => focus.members.includes(`local:${w.path}`));
    const paths = new Set(inFocus.map((w) => w.path));
    return {
      focus,
      chat,
      resolve: (card) => resolveCard(card, { worktrees, repos, peers }),
      agents: peers.filter((p) => p.live && paths.has(p.worktreePath)).map((p) => ({ label: p.alias || p.agentId.split('@')[0]!, agentId: p.agentId })),
      worktrees: inFocus.map((w) => ({ label: w.meta?.ticketId || w.branch || w.path.split('/').pop() || w.path, worktreePath: w.path })),
    };
  }, [focus, chat, worktrees, repos, peers]);
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

const STARTING_POLL_MS = 2_000;
const STARTING_POLL_CAP_MS = 120_000;

/** When each starting card was first seen starting: new ones from `now`, and
 * any no longer starting (up, closed, another Focus's) dropped, so the map
 * only ever holds the cards on screen that are starting. */
export function trackStarting(startedAt: Map<string, number>, ids: string[], now: number): void {
  const live = new Set(ids);
  for (const id of [...startedAt.keys()]) if (!live.has(id)) startedAt.delete(id);
  for (const id of ids) if (!startedAt.has(id)) startedAt.set(id, now);
}

const refuseApp = () => { throw new Error('Jarvis does not move the window'); };
/** W3: Jarvis's Focus edits go straight to the server and refresh the list;
 * unlike the ⌘K box's, a create never activates the new Focus, so the window
 * stays on this chat. Pages and settings are not Jarvis's (refused). */
export function jarvisApp(wsId: string): JarvisAppPort {
  return {
    page: refuseApp,
    settings: refuseApp,
    set: async () => refuseApp(),
    focus: async ({ op, focusId, name, worktreePaths }) => {
      const members = worktreePaths.map((path) => `local:${path}`);
      const id = () => { if (!focusId) throw new Error('Which Focus?'); return focusId; };
      try {
        if (op === 'create') {
          if (!name?.trim()) throw new Error('A new Focus needs a name');
          return { focusId: (await api.focuses.create(wsId, { name: name.trim(), members })).id };
        }
        if (op === 'rename') {
          if (!name?.trim()) throw new Error('Rename it to what?');
          await api.focuses.update(wsId, id(), { name: name.trim() });
        } else if (op === 'delete') await api.focuses.remove(wsId, id());
        else if (op === 'add') await api.focuses.update(wsId, id(), { addMembers: members });
        else await api.focuses.update(wsId, id(), { removeMembers: members });
      } finally {
        void refreshFocuses(wsId);
      }
    },
  };
}
export const ERRORS = {
  send: "Couldn't send that. Your message is still in the box.",
  approve: "Couldn't record your answer. The card shows where it stands now.",
  stop: "Couldn't stop Jarvis.",
  older: "Couldn't load earlier messages.",
} as const;

const refuseNav = () => { throw new Error('Jarvis does not move the window'); };
const NO_NAV: JarvisNavPort = { worktree: refuseNav, focus: refuseNav, workspace: refuseNav, repo: refuseNav, addRepo: refuseNav, newWorktree: refuseNav };

/** The open Focus's header status: ⚠ amber while an approval waits, a
 * pulsing Jarvis-orange dot while it works, nothing at rest. */
export function FocusJarvisStatus() {
  const host = useContext(HostContext);
  if (!host) return null;
  const meta = host.chat.meta;
  if ((meta?.pendingApprovals ?? 0) > 0) {
    return <span role="img" aria-label="needs approval" title="Jarvis is waiting for your approval" className="shrink-0 text-[11px] text-amber-400">⚠</span>;
  }
  if (meta?.running) {
    return <span role="img" aria-label="working" title="Jarvis is working" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#e8906f]" />;
  }
  return null;
}

/** The open Focus's header, line two: Jarvis's latest reply; nothing until
 * Jarvis has said something. */
export function FocusJarvisLatest() {
  const host = useContext(HostContext);
  if (!host) return null;
  const line = latestLine(host.chat.entries);
  if (!line) return null;
  return <div data-testid="focus-latest" className={FOCUS_LATEST_CLASS}>{line}</div>;
}

/** The chat in the main area. */
export function FocusJarvisMain({ onOpenCard, start }: { onOpenCard: OpenCard; start?: JarvisStart }) {
  const host = useContext(HostContext);
  if (!host) return null;
  return <MainView host={host} onOpenCard={onOpenCard} start={start} />;
}

function MainView({ host, onOpenCard, start }: { host: Host; onOpenCard: OpenCard; start?: JarvisStart }) {
  const { chat } = host;
  const [error, setError] = useState<string | null>(null);
  // W2: fixed words per operation; the server's own text never reaches the page.
  const report = (p: Promise<void>, words: string, after?: () => void): Promise<void> => {
    setError(null);
    return p.catch((err: unknown) => { setError(words); after?.(); throw err; });
  };
  const quiet = (p: Promise<void>) => { p.catch(() => {}); };
  return (
    <FocusJarvisView focusName={host.focus.name} entries={chat.entries} meta={chat.meta} hasOlder={chat.hasOlder}
      resolve={host.resolve} onOpenCard={onOpenCard} error={error}
      // A refused answer (409: decided elsewhere, or superseded) shows the card as the server has it.
      onApprove={(id, yes) => report(chat.approve(id, yes), ERRORS.approve, chat.reload)}
      // The composer keeps the draft when this rejects (W7).
      onSend={(text) => report(chat.send(text), ERRORS.send)}
      onStop={() => quiet(report(chat.stop(), ERRORS.stop))}
      onLoadOlder={() => quiet(report(chat.loadOlder(), ERRORS.older))}
      agents={host.agents} worktrees={host.worktrees} start={start} />
  );
}
