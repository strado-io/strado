// Focus-group rules, pure so each is a unit test: which members still exist,
// when a group is Done, and where ⌥⌘-arrow goes next.
import type { FocusGroup, RemoteWorktree } from '../../api';
import type { MergeRequest, Worktree } from '../../types';
import { localPinId, remotePinId, type SidebarEntry } from './pinIds';

/** Members that match a listed worktree, in group order. Unknown ids (deleted, runner offline) are skipped. */
export function resolveMembers(group: FocusGroup, worktrees: Worktree[], remote: RemoteWorktree[]): SidebarEntry[] {
  const local = new Map(worktrees.map((w) => [localPinId(w), w]));
  const rem = new Map(remote.map((w) => [remotePinId(w), w]));
  return group.members.flatMap((id): SidebarEntry[] => {
    const l = local.get(id);
    if (l) return [{ kind: 'local', pinId: id, repoId: l.repoId, w: l }];
    const r = rem.get(id);
    if (r) return [{ kind: 'remote', pinId: id, repoId: r.localRepoId, w: r }];
    return [];
  });
}

/**
 * Every member's PR is merged or closed. A member without a PR keeps the group
 * open (its PR may not exist yet); runner worktrees have no PR lookup, so a
 * group holding one is never Done.
 */
export function isGroupDone(members: SidebarEntry[], mrState: (path: string) => MergeRequest['state'] | null): boolean {
  if (members.length === 0) return false;
  return members.every((m) => {
    if (m.kind !== 'local') return false;
    const s = mrState(m.w.path);
    return s === 'merged' || s === 'closed';
  });
}

/** Next member for ⌥⌘-arrow; entering from outside lands on the first (→) or last (←). */
export function nextMember(members: SidebarEntry[], currentId: string | null, dir: 1 | -1): SidebarEntry | null {
  if (members.length < 2) return null;
  const i = members.findIndex((m) => m.pinId === currentId);
  if (i === -1) return dir === 1 ? members[0]! : members[members.length - 1]!;
  return members[(i + dir + members.length) % members.length]!;
}

export function activeGroupOf(groups: FocusGroup[], id: string | null): FocusGroup | null {
  return (id && groups.find((g) => g.id === id)) || null;
}

// Ticket groups: worktrees made from the same ticket (FX-412 in api and web)
// bundle themselves, so the common case needs no upkeep. Keyed on the ticket
// id Strado saved when the worktree was created, matched exactly — never
// parsed out of branch names, since trackers' id formats differ. Derived on
// every render, never stored, so they follow the worktrees as they come and go.
const TICKET_ID_PREFIX = 'ticket:';

export const isAutoGroup = (g: FocusGroup) => g.id.startsWith(TICKET_ID_PREFIX);

/**
 * One group per ticket shared by two or more local worktrees, sorted by
 * ticket. Runner worktrees carry no ticket, so they never join one.
 */
export function ticketGroups(worktrees: Worktree[]): FocusGroup[] {
  const byTicket = new Map<string, string[]>();
  for (const w of worktrees) {
    const ticket = w.meta?.ticketId?.trim();
    if (ticket) byTicket.set(ticket, [...(byTicket.get(ticket) ?? []), localPinId(w)]);
  }
  return [...byTicket.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ticket, members]) => ({ id: `${TICKET_ID_PREFIX}${ticket}`, name: ticket, members, createdAt: '' }));
}

/** Manual groups, then ticket groups — minus a ticket a manual group is already named after. */
export function allGroups(manual: FocusGroup[], worktrees: Worktree[]): FocusGroup[] {
  const named = new Set(manual.map((g) => g.name.trim()));
  return [...manual, ...ticketGroups(worktrees).filter((g) => !named.has(g.name))];
}
