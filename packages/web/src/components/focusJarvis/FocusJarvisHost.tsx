import { createContext, useContext, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Focus, StationDto } from '../../api';
import { useIntercom } from '../../contexts/IntercomContext';
import { useJarvisActionHandler, useUiHub } from '../../contexts/UiControlContext';
import type { JarvisAppPort, JarvisNavPort } from '../../lib/jarvis/execute';
import { runJarvisAction } from './windowAction';
import { readShellNames } from '../../hooks/shellNames';
import { buildModelContext } from '../../lib/jarvis/model';
import { jarvisServerPort } from '../../lib/jarvis/serverPort';
import type { TabRef } from '../../lib/jarvis/types';
import { readWorktreeLru } from '../../lib/worktreeLru';
import type { RepoConfig, Workspace, Worktree } from '../../types';
import { buildParseContext } from '../jarvis/jarvisContext';
import { resolveCard, type ResolvedCard } from './cards';
import { FocusJarvisView } from './FocusJarvisView';
import { JarvisSidebarCard, latestLine } from './JarvisSidebarCard';
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
export function FocusJarvisProvider({ wsId, focus, focuses, worktrees, repos, workspaces, stations, lastActedOn, app, onTreeChanged, children }: {
  wsId: string;
  focus: Focus | null;
  focuses: Focus[];
  worktrees: Worktree[];
  repos: RepoConfig[];
  workspaces: Workspace[];
  stations: StationDto[];
  lastActedOn: MutableRefObject<TabRef | null>;
  /** The app's pages and Focus edits (focus.edit); Jarvis never navigates. */
  app?: JarvisAppPort;
  /** Reload the worktree list: a Jarvis action made one on the server. */
  onTreeChanged?: () => void;
  children: ReactNode;
}) {
  const hub = useUiHub();
  const { peers } = useIntercom();
  const latest = useRef({ focuses, worktrees, repos, workspaces, stations, peers });
  latest.current = { focuses, worktrees, repos, workspaces, stations, peers };
  const parseContext = () => {
    const l = latest.current;
    const h = hub();
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
    });
  };
  const getContext = () => buildModelContext(parseContext());
  // The turn's tool calls come back to this window as `jarvis.action`: run
  // them here, in the background, with whatever hub is on screen (if any).
  useJarvisActionHandler((action) => runJarvisAction(action, {
    context: parseContext,
    ports: () => ({
      hub: hub()?.jarvis ?? null,
      server: jarvisServerPort(wsId),
      nav: NO_NAV,
      ...(app ? { app } : {}),
    }),
  }));
  // A new worktree or a Focus edit lands in the sidebar now, not on the next reload.
  const chat = useFocusJarvis(wsId, focus?.id ?? null, getContext, (entry) => {
    if (!changesTree(entry)) return;
    void refreshFocuses(wsId);
    onTreeChanged?.();
  });
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

const refuseNav = () => { throw new Error('Jarvis does not move the window'); };
const NO_NAV: JarvisNavPort = { worktree: refuseNav, focus: refuseNav, workspace: refuseNav, repo: refuseNav, addRepo: refuseNav, newWorktree: refuseNav };

/** The ✦ Jarvis card for the sidebar's Focus section; nothing without a Focus. */
export function FocusJarvisCard({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  const host = useContext(HostContext);
  if (!host) return null;
  return <JarvisSidebarCard meta={host.chat.meta} latest={latestLine(host.chat.entries)} active={active} onOpen={onSelect} />;
}

/** The chat in the main area. */
export function FocusJarvisMain({ onOpenCard }: { onOpenCard: OpenCard }) {
  const host = useContext(HostContext);
  if (!host) return null;
  return <MainView host={host} onOpenCard={onOpenCard} />;
}

function MainView({ host, onOpenCard }: { host: Host; onOpenCard: OpenCard }) {
  const { chat } = host;
  const [error, setError] = useState<string | null>(null);
  const report = (p: Promise<void>) => { setError(null); p.catch((e: Error) => setError(e.message)); };
  return (
    <FocusJarvisView focusName={host.focus.name} entries={chat.entries} meta={chat.meta} hasOlder={chat.hasOlder}
      resolve={host.resolve} onOpenCard={onOpenCard} error={error}
      onApprove={(id, yes) => report(chat.approve(id, yes))}
      onSend={(text) => report(chat.send(text))}
      onStop={() => report(chat.stop())}
      onLoadOlder={() => report(chat.loadOlder())}
      agents={host.agents} worktrees={host.worktrees} />
  );
}
