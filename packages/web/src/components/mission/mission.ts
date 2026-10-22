// Stations → what Mission Control shows: the strip's pills, the selected
// agent's card, and the approvals waiting for a human click.
import type { StationDto } from '../../api';
import { activityLine, scopeStations, sortStations, stateOf, stateWord, type ScopedStation, type StationScope } from '../../lib/dock/stations';
import { shortRelativeTime } from '../../lib/relativeTime';
import type { StripAgent } from './AgentStrip';
import type { CardAgent } from './AgentCard';
import type { ApprovalOutcome, PendingApproval } from './ApprovalPanel';

const nameOf = (s: StationDto) => s.alias || s.name;

/** A Focus's local worktrees (members are `local:<path>`); null with no Focus open. */
export const focusWorktreesOf = (focus: { members: string[] } | null | undefined): string[] | null =>
  focus ? focus.members.filter((m) => m.startsWith('local:')).map((m) => m.slice('local:'.length)) : null;

export const missionStations = (stations: StationDto[], scope: StationScope, focusWorktrees: string[] | null): ScopedStation[] =>
  sortStations(scopeStations(stations, { scope, focusWorktrees }));

/** Where a station is, as the sidebar names it: the repo's display name, with
 * the worktree too when that repo has several; else the worktree's own name. */
export function placeNamer(worktrees: { path: string; repoId?: string | null }[], repos: { id: string; name: string }[]): (s: StationDto) => string {
  const perRepo = new Map<string, number>();
  for (const w of worktrees) if (w.repoId) perRepo.set(w.repoId, (perRepo.get(w.repoId) ?? 0) + 1);
  return (s) => {
    const repoId = worktrees.find((w) => w.path === s.worktreePath)?.repoId;
    const repo = repoId ? repos.find((r) => r.id === repoId)?.name : undefined;
    if (!repo) return s.worktreeName;
    return (perRepo.get(repoId!) ?? 0) > 1 ? `${repo} / ${s.worktreeName}` : repo;
  };
}

/** The project a station is in: its repo's display name; else the worktree's own name. */
export function projectNamer(worktrees: { path: string; repoId?: string | null }[], repos: { id: string; name: string }[]): (s: StationDto) => string {
  return (s) => {
    const repoId = worktrees.find((w) => w.path === s.worktreePath)?.repoId;
    return (repoId ? repos.find((r) => r.id === repoId)?.name : undefined) ?? s.worktreeName;
  };
}

/** The strip's pills. With `projectOf` and the Focus's agents spanning 2+
 * projects, each is grouped under its project (groups in first-seen order, so
 * needs you still leads) and the project label replaces the place suffix. */
export const stripAgents = (placeOf: (s: StationDto) => string, stations: ScopedStation[], projectOf?: (s: StationDto) => string): StripAgent[] => {
  const inside = stations.filter((s) => !s.outside);
  const projects = projectOf ? [...new Set(inside.map(projectOf))] : [];
  const grouped = projects.length > 1;
  // Two shell-1s side by side are ambiguous: name where each one is (within a group, the worktree).
  const keyOf = (s: StationDto) => (grouped ? `${projectOf!(s)}\0${nameOf(s)}` : nameOf(s));
  const seen = new Map<string, number>();
  for (const s of stations) if (!s.outside) seen.set(keyOf(s), (seen.get(keyOf(s)) ?? 0) + 1);
  const row = (s: ScopedStation): StripAgent => {
    const state = stateOf(s);
    const dup = !s.outside && (seen.get(keyOf(s)) ?? 0) > 1;
    const place = dup ? (grouped ? s.worktreeName : placeOf(s)) : null;
    return {
      agentId: s.agentId, name: nameOf(s), mode: s.mode, state, word: stateWord(state), activity: activityLine(s) || null, outside: s.outside ? placeOf(s) : null, place,
      ...(grouped && !s.outside ? { project: projectOf!(s) } : {}),
    };
  };
  if (!grouped) return stations.map(row);
  return [...projects.flatMap((p) => inside.filter((s) => projectOf!(s) === p)), ...stations.filter((s) => s.outside)].map(row);
};

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
