// The Jarvis parser's view of this window, assembled from the hub (its strip,
// focus, layout version), the agent registry (who each tab is) and the board
// (worktrees, Focuses, workspaces, repos, scripts). Pure, so it is tested
// apart from the React host.
import type { Focus, JarvisScripts, PeerDto, RemoteWorktree, StationDto } from '../../api';
import type { JarvisHubContext } from '../../contexts/UiControlContext';
import type { ParseContext, TabRef } from '../../lib/jarvis/types';
import { scriptsContext } from '../../lib/jarvis/serverPort';
import type { RepoConfig, Workspace, Worktree } from '../../types';

export function buildParseContext(input: {
  hub: { path: string; context: JarvisHubContext | null } | null;
  peers: PeerDto[];
  lastActedOn: TabRef | null;
  worktrees: Worktree[];
  /** When each worktree was last opened here (path → ms), from the worktree LRU. */
  lru?: Record<string, number>;
  focuses: Focus[];
  workspaces: Workspace[];
  repos: RepoConfig[];
  scripts: JarvisScripts | null;
  remoteWorktrees?: RemoteWorktree[];
  /** The intercom stations feed: its open calls to the human ("answer claude-1 …"). */
  stations?: StationDto[];
}): ParseContext {
  const hc = input.hub?.context ?? null;
  const live = input.peers.filter((p) => p.live);
  // The registry knows who each tab is; its executionId pins the exact tab so a
  // closed-and-reused session number can't be hit by a stale preview.
  const tabs = (hc?.tabs ?? []).map((t) => {
    const peer = live.find((p) => p.worktreePath === t.worktreePath && p.mode === t.mode && p.sessionId === t.sessionId);
    if (!peer) return t;
    return { ...t, agentId: peer.agentId, alias: peer.alias, ...(peer.executionId ? { executionId: peer.executionId } : {}) };
  });
  return {
    tabs,
    focused: hc?.focused ?? null,
    lastActedOn: input.lastActedOn,
    currentWorktree: input.hub?.path ?? null,
    worktrees: input.worktrees.map((w) => ({
      path: w.path,
      name: w.meta?.ticketId || w.branch || w.path.split('/').pop() || w.path,
      branch: w.branch ?? null,
      ticketKey: w.meta?.ticketId ?? null,
      ...(input.lru?.[w.path] ? { lastUsedAt: input.lru[w.path] } : {}),
    })),
    focuses: input.focuses.map((f) => ({ id: f.id, name: f.name })),
    workspaces: input.workspaces.map((w) => ({ id: w.id, name: w.name })),
    repos: input.repos.map((r) => ({ path: r.path, name: r.name })),
    ...scriptsContext(input.scripts),
    peers: live.map((p) => ({ agentId: p.agentId, alias: p.alias, mode: p.mode, worktreePath: p.worktreePath })),
    calls: (input.stations ?? []).flatMap((s) => s.calls.map((c) => ({ id: c.id, agentId: s.agentId, title: c.title }))),
  };
}
