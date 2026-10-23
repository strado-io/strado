// Stations → what Mission Control shows: the strip's pills, the selected
// agent's card, and the approvals waiting for a human click.
import type { StationDto } from '../../api';
import { activityLine, scopeStations, sortStations, stateOf, stateWord, type ScopedStation, type StationScope } from '../../lib/dock/stations';
import { shortRelativeTime } from '../../lib/relativeTime';
import type { CardAgent } from './AgentCard';
import type { ApprovalOutcome, PendingApproval } from './ApprovalPanel';

const nameOf = (s: StationDto) => s.alias || s.name;

/** A Focus's local worktrees (members are `local:<path>`); null with no Focus open. */
export const focusWorktreesOf = (focus: { members: string[] } | null | undefined): string[] | null =>
  focus ? focus.members.filter((m) => m.startsWith('local:')).map((m) => m.slice('local:'.length)) : null;

export const missionStations = (stations: StationDto[], scope: StationScope, focusWorktrees: string[] | null): ScopedStation[] =>
  sortStations(scopeStations(stations, { scope, focusWorktrees }));

export function cardAgent(s: StationDto): CardAgent {
  const state = stateOf(s);
  const since = state === 'working' ? s.activity?.at ?? s.lastActivityAt : s.lastResult?.at ?? s.lastActivityAt;
  return {
    agentId: s.agentId, name: nameOf(s), mode: s.mode, worktree: s.worktreeName, state, word: stateWord(state),
    elapsed: since ? shortRelativeTime(since) || null : null,
    // Needs you because of a call: the call says why. A shell: what it is running, if known.
    detail: s.calls.length > 0 ? `asks: ${s.calls[0]!.title}`
      : s.mode === 'shell' ? (state === 'working' && s.activity?.text?.trim()) || null
      : activityLine(s) || null,
    calls: s.calls.map((c) => ({ id: c.id, title: c.title })),
  };
}

export const pendingApprovals = (stations: StationDto[]): PendingApproval[] =>
  stations.flatMap((s) => (s.approvals ?? []).map((a) => ({ ...a, agentId: s.agentId, agentName: nameOf(s) })))
    .sort((a, b) => a.createdAt - b.createdAt);

/** The answer, or 'gone' when the agent's own tab answered first (409, reason gone). */
export async function decideApproval(
  answer: (wsId: string, id: string, decision: 'allow' | 'deny') => Promise<unknown>,
  wsId: string, id: string, decision: 'allow' | 'deny',
): Promise<ApprovalOutcome> {
  try {
    await answer(wsId, id, decision);
    return 'ok';
  } catch (err) {
    if ((err as { details?: { reason?: unknown } } | null)?.details?.reason === 'gone') return 'gone';
    throw err;
  }
}
