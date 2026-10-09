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

// Ticket groups: worktrees that share a ticket (FX-412 in api and web) bundle
// themselves, so the common case needs no upkeep. Derived on every render,
// never stored — they follow the worktrees as they come and go.
const TICKET_ID_PREFIX = 'ticket:';
const TICKET_RE = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)/;

export const isAutoGroup = (g: FocusGroup) => g.id.startsWith(TICKET_ID_PREFIX);

/** The ticket a worktree is for: its ticket id, else a ticket-shaped part of its branch. */
export function ticketKey(ticketId: string | null | undefined, branch: string | null | undefined): string | null {
  for (const s of [ticketId, branch]) {
    const m = s ? TICKET_RE.exec(s) : null;
    if (m) return m[1]!.toUpperCase();
  }
  return null;
}

/** One group per ticket shared by two or more worktrees, sorted by ticket. */
export function ticketGroups(worktrees: Worktree[], remote: RemoteWorktree[]): FocusGroup[] {
  const byKey = new Map<string, string[]>();
  const add = (key: string | null, id: string) => { if (key) byKey.set(key, [...(byKey.get(key) ?? []), id]); };
  for (const w of worktrees) add(ticketKey(w.meta?.ticketId, w.branch), localPinId(w));
  for (const w of remote) add(ticketKey(null, w.branch), remotePinId(w));
  return [...byKey.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, members]) => ({ id: `${TICKET_ID_PREFIX}${key}`, name: key, members, createdAt: '' }));
}

/** Manual groups, then ticket groups — minus a ticket a manual group is already named after. */
export function allGroups(manual: FocusGroup[], worktrees: Worktree[], remote: RemoteWorktree[]): FocusGroup[] {
  const named = new Set(manual.map((g) => g.name.trim().toUpperCase()));
  return [...manual, ...ticketGroups(worktrees, remote).filter((g) => !named.has(g.name))];
}
