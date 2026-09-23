import type { EscalationDto, ForkDto, IntercomTaskDto, PeerDto } from '../api';
import type { IntercomEvent } from '../eventStream';

export type IntercomState = { escalations: EscalationDto[]; tasks: IntercomTaskDto[]; forks: ForkDto[]; peers: PeerDto[]; loaded: boolean; error: string | null };
export const INITIAL_INTERCOM: IntercomState = { escalations: [], tasks: [], forks: [], peers: [], loaded: false, error: null };
export type IntercomAction =
  | { type: 'loaded'; escalations: EscalationDto[]; tasks: IntercomTaskDto[]; forks: ForkDto[]; peers: PeerDto[] }
  | { type: 'escalations'; escalations: EscalationDto[] }
  | { type: 'tasks'; tasks: IntercomTaskDto[] }
  | { type: 'forks'; forks: ForkDto[] }
  | { type: 'peers'; peers: PeerDto[] }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export function intercomReducer(state: IntercomState, action: IntercomAction): IntercomState {
  switch (action.type) {
    case 'loaded': return { escalations: action.escalations, tasks: action.tasks, forks: action.forks, peers: action.peers, loaded: true, error: null };
    case 'escalations': return { ...state, escalations: action.escalations };
    case 'tasks': return { ...state, tasks: action.tasks };
    case 'forks': return { ...state, forks: action.forks };
    case 'peers': return { ...state, peers: action.peers };
    case 'error': return { ...state, error: action.message };
    // A workspace switch: blank the surfaces instead of leaving the previous
    // workspace's rows on screen while the new fetch is in flight.
    case 'reset': return INITIAL_INTERCOM;
  }
}
export const collectionOf = (evt: IntercomEvent): 'escalations' | 'tasks' | 'forks' | 'peers' =>
  evt.type.startsWith('task.') ? 'tasks' : evt.type.startsWith('fork.') ? 'forks' : evt.type.startsWith('peer.') ? 'peers' : 'escalations';
export const openEscalations = (s: IntercomState): EscalationDto[] =>
  s.escalations.filter((e) => e.status === 'open' && e.to === 'human').sort((a, b) => b.createdAt - a.createdAt);
export const peerOf = (s: IntercomState, agentId: string): PeerDto | undefined => s.peers.find((p) => p.agentId === agentId);
export const ACTIVE_FORK: ReadonlySet<ForkDto['status']> = new Set(['summarising', 'queued', 'delivered']);
export const activeForks = (s: IntercomState): ForkDto[] => s.forks.filter((f) => ACTIVE_FORK.has(f.status)).sort((a, b) => b.createdAt - a.createdAt);
export const settledForks = (s: IntercomState): ForkDto[] => s.forks.filter((f) => !ACTIVE_FORK.has(f.status)).sort((a, b) => b.createdAt - a.createdAt);
export const FORK_LABEL_MAX = 120;
/** The notes' first line (trimmed), hard-cut at 120 chars with no ellipsis; falls
 * back to the source worktree's basename only when that first line is empty —
 * same rule as the server's forkLabel. A non-empty second line does not rescue
 * a blank first line. */
export function forkLabel(f: Pick<ForkDto, 'notes' | 'source'>): string {
  const firstLine = f.notes.split('\n')[0]?.trim() ?? '';
  if (firstLine.length > 0) return firstLine.slice(0, FORK_LABEL_MAX);
  return f.source.worktreePath.split('/').filter(Boolean).pop() ?? f.source.worktreePath;
}
/** `alias ?? agentId` for a peer target; `new <mode> tab` (+ ` · <agentId>` once spawned) for a new-tab target. */
export function forkTargetLabel(s: IntercomState, target: ForkDto['target']): string {
  if (target.kind === 'peer') return peerOf(s, target.agentId)?.alias ?? target.agentId;
  return target.agentId ? `new ${target.mode} tab · ${peerOf(s, target.agentId)?.alias ?? target.agentId}` : `new ${target.mode} tab`;
}
/** The registered peer behind a hub tab (path + mode + session id), if any. */
export function peerForTab(s: IntercomState, tab: { path: string; mode: string; id: string }): PeerDto | undefined {
  return s.peers.find((p) => p.worktreePath === tab.path && p.mode === tab.mode && p.sessionId === tab.id);
}
export function escalationsByWorktree(s: IntercomState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of openEscalations(s)) {
    const p = peerOf(s, e.from.agentId);
    if (p) out[p.worktreePath] = (out[p.worktreePath] ?? 0) + 1;
  }
  return out;
}
export function escalationForTab(s: IntercomState, tab: { path: string; mode: string; id: string }): EscalationDto | undefined {
  return openEscalations(s).find((e) => {
    const p = peerOf(s, e.from.agentId);
    return !!p && p.worktreePath === tab.path && p.mode === tab.mode && p.sessionId === tab.id;
  });
}
export type IntercomNotification = { id: string; path: string; mode: PeerDto['mode']; sessionId: string; title: string; body: string };
export function computeIntercomNotifications(prevOpenIds: Set<string>, s: IntercomState, repoLabel: (path: string) => string): IntercomNotification[] {
  const out: IntercomNotification[] = [];
  for (const e of openEscalations(s)) {
    if (prevOpenIds.has(e.id)) continue;
    const p = peerOf(s, e.from.agentId);
    if (!p) continue;
    out.push({ id: e.id, path: p.worktreePath, mode: p.mode, sessionId: p.sessionId, title: `${repoLabel(p.worktreePath)}: ${p.alias ?? p.agentId} needs a decision — ${e.title}`, body: e.body });
  }
  return out;
}
// Pure step for the Dashboard's "new escalation" notifier: `prev` is the
// caller's last-seen id set, or null on the very first snapshot for a
// scope (fresh mount, or right after a workspace switch) — that call never
// fires, it just seeds `seen` silently. Escalations whose peer hasn't
// arrived yet (escalations and peers land as separate dispatches) are left
// out of `seen` so they fire once their peer resolves, instead of being
// marked seen-but-unnotified forever.
export function nextSeenIds(prev: Set<string> | null, s: IntercomState, repoLabel: (path: string) => string): { seen: Set<string>; fire: IntercomNotification[] } {
  const seen = new Set<string>();
  for (const e of openEscalations(s)) {
    if (peerOf(s, e.from.agentId)) seen.add(e.id);
  }
  const fire = prev === null ? [] : computeIntercomNotifications(prev, s, repoLabel);
  return { seen, fire };
}
