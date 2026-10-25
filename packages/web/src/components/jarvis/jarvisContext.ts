// The Jarvis parser's view of this window, assembled from the hub (its strip,
// focus, layout version), the agent registry (who each tab is) and the board
// (worktrees, Focuses, workspaces, repos, scripts). Pure, so it is tested
// apart from the React host.
import type { Focus, JarvisScripts, PeerDto, RemoteWorktree, StationDto } from '../../api';
import type { JarvisHubContext } from '../../contexts/UiControlContext';
import type { ParseContext, TabRef } from '../../lib/jarvis/types';
import { scriptsContext } from '../../lib/jarvis/serverPort';
import { MODEL_CAPS } from '../../lib/jarvis/model';
import { sessionNameKey } from '../../hooks/shellNames';
import type { RepoConfig, Workspace, Worktree } from '../../types';

export function buildParseContext(input: {
  hub: { path: string; context: JarvisHubContext | null } | null;
  peers: PeerDto[];
  lastActedOn: TabRef | null;
  worktrees: Worktree[];
  /** When each worktree was last opened here (path → ms), from the worktree LRU. */
  lru?: Record<string, number>;
  focuses: Focus[];
  /** The Focus open in this window ("this focus"), if any. */
  activeFocusId?: string | null;
  workspaces: Workspace[];
  /** The workspace this window is in ("which workspace am I in?"). */
  activeWorkspaceId?: string | null;
  repos: RepoConfig[];
  scripts: JarvisScripts | null;
  remoteWorktrees?: RemoteWorktree[];
  /** The strip's own tab names (hooks/shellNames): a renamed session is called by its name everywhere. */
  shellNames?: Record<string, string>;
  /** The intercom stations feed: its open calls to the human ("answer claude-1 …"). */
  stations?: StationDto[];
}): ParseContext {
  const hc = input.hub?.context ?? null;
  const live = input.peers.filter((p) => p.live);
  // The registry knows who each tab is; its executionId pins the exact tab so a
  // closed-and-reused session number can't be hit by a stale preview.
  const onScreen = (hc?.tabs ?? []).map((t) => {
    const peer = live.find((p) => p.worktreePath === t.worktreePath && p.mode === t.mode && p.sessionId === t.sessionId);
    if (!peer) return { ...t, onScreen: true };
    return { ...t, agentId: peer.agentId, alias: peer.alias, ...(peer.executionId ? { executionId: peer.executionId } : {}), onScreen: true };
  });
  // Every other live session in a local worktree ("close the shell in Strado/main"
  // from home): the registry knows them though no hub shows them. Most recently
  // opened worktrees first; the on-screen strip always stays within the cap.
  const local = new Set(input.worktrees.map((w) => w.path));
  const shown = (p: PeerDto) => onScreen.some((t) => t.worktreePath === p.worktreePath && t.mode === p.mode && t.sessionId === p.sessionId);
  const recency = (path: string) => input.lru?.[path] ?? 0;
  const offScreen = live
    .filter((p) => local.has(p.worktreePath) && !shown(p))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => recency(b.p.worktreePath) - recency(a.p.worktreePath) || a.i - b.i)
    .map(({ p }) => ({
      worktreePath: p.worktreePath, mode: p.mode, sessionId: p.sessionId,
      label: input.shellNames?.[sessionNameKey(p.worktreePath, p.mode, p.sessionId)] || `${MODE_LABEL[p.mode]}${p.sessionId === '1' ? '' : ` ${p.sessionId}`}`,
      // An agent mid-turn is busy (closing it confirms); a shell's process is checked at run time.
      busy: p.mode !== 'shell' && p.lifecycle === 'working',
      agentId: p.agentId, alias: p.alias, ...(p.executionId ? { executionId: p.executionId } : {}),
      onScreen: false,
    }));
  const tabs = [...onScreen, ...offScreen].slice(0, Math.max(onScreen.length, MODEL_CAPS.tabs));
  const names = uniqueWorktreeNames(input.worktrees, input.repos);
  return {
    tabs,
    focused: hc?.focused ?? null,
    lastActedOn: input.lastActedOn,
    currentWorktree: input.hub?.path ?? null,
    worktrees: input.worktrees.map((w, i) => ({
      path: w.path,
      name: names[i]!,
      branch: w.branch ?? null,
      ticketKey: w.meta?.ticketId ?? null,
      // The owning repo ("open a shell in strado website"): by id, else the repo's own checkout.
      repoName: repoOf(w, input.repos)?.name ?? null,
      ...(input.lru?.[w.path] ? { lastUsedAt: input.lru[w.path] } : {}),
    })),
    // A Focus's worktrees, local ones only (tabs and agents here only know those).
    focuses: input.focuses.map((f) => ({ id: f.id, name: f.name, worktreePaths: f.members.filter((m) => m.startsWith('local:')).map((m) => m.slice('local:'.length)) })),
    currentFocus: (() => { const f = input.focuses.find((x) => x.id === input.activeFocusId); return f ? { id: f.id, name: f.name } : null; })(),
    workspaces: input.workspaces.map((w) => ({ id: w.id, name: w.name })),
    currentWorkspace: (() => { const w = input.workspaces.find((x) => x.id === input.activeWorkspaceId); return w ? { id: w.id, name: w.name } : null; })(),
    repos: input.repos.map((r) => ({ path: r.path, name: r.name })),
    ...scriptsContext(input.scripts),
    peers: live.map((p) => ({ agentId: p.agentId, alias: p.alias, mode: p.mode, worktreePath: p.worktreePath })),
    calls: (input.stations ?? []).flatMap((s) => s.calls.map((c) => ({ id: c.id, agentId: s.agentId, title: c.title }))),
  };
}

const repoOf = (w: Worktree, repos: RepoConfig[]) => repos.find((r) => r.id === w.repoId) ?? repos.find((r) => r.path === w.path);
const lastTwo = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/') || path;

/** One name per worktree, unique in the workspace: the plain name (ticket,
 * branch or folder) when only one worktree has it, else "<repo>/<name>" for
 * every worktree sharing it ("Strado/main", "Strado Website/main"); without a
 * repo, or still clashing, the last two path segments. Compared ignoring case. */
export function uniqueWorktreeNames(worktrees: Worktree[], repos: RepoConfig[]): string[] {
  const clashes = (names: string[]) => {
    const n = new Map<string, number>();
    for (const x of names) n.set(x.toLowerCase(), (n.get(x.toLowerCase()) ?? 0) + 1);
    return (x: string) => (n.get(x.toLowerCase()) ?? 0) > 1;
  };
  const plain = worktrees.map((w) => w.meta?.ticketId || w.branch || w.path.split('/').pop() || w.path);
  const shared = clashes(plain);
  const named = plain.map((name, i) => {
    if (!shared(name)) return name;
    const repo = repoOf(worktrees[i]!, repos)?.name;
    return repo ? `${repo}/${name}` : lastTwo(worktrees[i]!.path);
  });
  const still = clashes(named);
  return named.map((name, i) => (plain[i] !== name && still(name) ? lastTwo(worktrees[i]!.path) : name));
}

/** How the strip names a session's kind ("Claude 2", "Shell"). */
const MODE_LABEL: Record<PeerDto['mode'], string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', shell: 'Shell' };
