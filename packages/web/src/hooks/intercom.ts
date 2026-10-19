import type { EscalationDto, IntercomTaskDto, PeerDto } from '../api';
import type { IntercomEvent } from '../eventStream';

export type IntercomState = { escalations: EscalationDto[]; tasks: IntercomTaskDto[]; peers: PeerDto[]; loaded: boolean; error: string | null };
export const INITIAL_INTERCOM: IntercomState = { escalations: [], tasks: [], peers: [], loaded: false, error: null };
export type IntercomAction =
  | { type: 'loaded'; escalations: EscalationDto[]; tasks: IntercomTaskDto[]; peers: PeerDto[] }
  | { type: 'escalations'; escalations: EscalationDto[] }
  | { type: 'tasks'; tasks: IntercomTaskDto[] }
  | { type: 'peers'; peers: PeerDto[] }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export function intercomReducer(state: IntercomState, action: IntercomAction): IntercomState {
  switch (action.type) {
    case 'loaded': return { escalations: action.escalations, tasks: action.tasks, peers: action.peers, loaded: true, error: null };
    // Any successful fetch means the server is reachable again, so a stale
    // error from an earlier failed fetch stops shouting.
    case 'escalations': return { ...state, escalations: action.escalations, error: null };
    case 'tasks': return { ...state, tasks: action.tasks, error: null };
    case 'peers': return { ...state, peers: action.peers, error: null };
    case 'error': return { ...state, error: action.message };
    // A workspace switch: blank the surfaces instead of leaving the previous
    // workspace's rows on screen while the new fetch is in flight.
    case 'reset': return INITIAL_INTERCOM;
  }
}
export const collectionOf = (evt: IntercomEvent): 'escalations' | 'tasks' | 'peers' =>
  evt.type.startsWith('task.') ? 'tasks' : evt.type.startsWith('peer.') ? 'peers' : 'escalations';
export const openEscalations = (s: IntercomState): EscalationDto[] =>
  s.escalations.filter((e) => e.status === 'open' && e.to === 'human').sort((a, b) => b.createdAt - a.createdAt);
/** A peer ask that timed out (or lost its target) and was handed to the human. */
export const isRetargetedAsk = (e: EscalationDto): boolean => e.to === 'human' && e.askMessageId != null;
export const peerOf = (s: IntercomState, agentId: string): PeerDto | undefined => s.peers.find((p) => p.agentId === agentId);
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
/** `path`/`mode`/`sessionId` are null for a retargeted ask whose asker tab has
 * exited: there is no tab to open, only the drawer. */
export type IntercomNotification = { id: string; path: string | null; mode: PeerDto['mode'] | null; sessionId: string | null; title: string; body: string };
export function computeIntercomNotifications(prevOpenIds: Set<string>, s: IntercomState, repoLabel: (path: string) => string): IntercomNotification[] {
  const out: IntercomNotification[] = [];
  for (const e of openEscalations(s)) {
    if (prevOpenIds.has(e.id)) continue;
    const p = peerOf(s, e.from.agentId);
    if (!p) {
      if (isRetargetedAsk(e)) out.push({ id: e.id, path: null, mode: null, sessionId: null, title: `${e.from.agentId} timed out waiting on a peer — ${e.title}`, body: e.body });
      continue;
    }
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
// marked seen-but-unnotified forever. A retargeted ask is the exception: its
// asker may have exited for good, so it never waits on a peer.
export function nextSeenIds(prev: Set<string> | null, s: IntercomState, repoLabel: (path: string) => string): { seen: Set<string>; fire: IntercomNotification[] } {
  const seen = new Set<string>();
  for (const e of openEscalations(s)) {
    if (peerOf(s, e.from.agentId) || isRetargetedAsk(e)) seen.add(e.id);
  }
  const fire = prev === null ? [] : computeIntercomNotifications(prev, s, repoLabel);
  return { seen, fire };
}
