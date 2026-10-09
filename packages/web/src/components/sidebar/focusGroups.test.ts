import { describe, expect, it } from 'vitest';
import type { RemoteWorktree } from '../../api';
import type { FocusGroup } from '../../api';
import type { Worktree } from '../../types';
import { activeGroupOf, allGroups, isAutoGroup, isGroupDone, nextMember, resolveMembers, ticketGroups } from './focusGroups';

const wt = (path: string, repoId = 'r1') => ({ path, repoId } as Worktree);
const rw = (path: string, runnerId = 'run1') => ({ path, runnerId, localRepoId: 'r2' } as RemoteWorktree);
const group = (members: string[]): FocusGroup => ({ id: 'g', name: 'G', members, createdAt: 't' });

describe('resolveMembers', () => {
  it('keeps member order, resolves local and remote ids, drops unknown ones', () => {
    const out = resolveMembers(
      group(['remote:run1:/x', 'local:/gone', 'local:/a']),
      [wt('/a')],
      [rw('/x')],
    );
    expect(out.map((e) => e.pinId)).toEqual(['remote:run1:/x', 'local:/a']);
    expect(out[0]).toMatchObject({ kind: 'remote', repoId: 'r2' });
    expect(out[1]).toMatchObject({ kind: 'local', repoId: 'r1' });
  });
});

describe('isGroupDone', () => {
  const members = resolveMembers(group(['local:/a', 'local:/b']), [wt('/a'), wt('/b')], []);
  it('is done only when every member has a merged or closed PR', () => {
    expect(isGroupDone(members, (p) => (p === '/a' ? 'merged' : 'closed'))).toBe(true);
    expect(isGroupDone(members, (p) => (p === '/a' ? 'merged' : 'open'))).toBe(false);
  });
  it('is not done when a member has no PR yet', () => {
    expect(isGroupDone(members, (p) => (p === '/a' ? 'merged' : null))).toBe(false);
  });
  it('is not done when nothing resolves', () => {
    expect(isGroupDone([], () => 'merged')).toBe(false);
  });
  it('is never done with a runner member (no MR lookup for runners)', () => {
    const mixed = resolveMembers(group(['local:/a', 'remote:run1:/x']), [wt('/a')], [rw('/x')]);
    expect(isGroupDone(mixed, () => 'merged')).toBe(false);
  });
});

describe('nextMember', () => {
  const members = resolveMembers(group(['local:/a', 'local:/b', 'local:/c']), [wt('/a'), wt('/b'), wt('/c')], []);
  it('moves forward and back, wrapping', () => {
    expect(nextMember(members, 'local:/a', 1)?.pinId).toBe('local:/b');
    expect(nextMember(members, 'local:/c', 1)?.pinId).toBe('local:/a');
    expect(nextMember(members, 'local:/a', -1)?.pinId).toBe('local:/c');
  });
  it('enters at the first (→) or last (←) member from outside the group', () => {
    expect(nextMember(members, 'local:/elsewhere', 1)?.pinId).toBe('local:/a');
    expect(nextMember(members, null, -1)?.pinId).toBe('local:/c');
  });
  it('does nothing with fewer than two members', () => {
    expect(nextMember(members.slice(0, 1), 'local:/a', 1)).toBeNull();
    expect(nextMember([], null, 1)).toBeNull();
  });
});

describe('activeGroupOf', () => {
  it('treats an unknown or null id as no active group', () => {
    const gs = [group([])];
    expect(activeGroupOf(gs, 'g')?.id).toBe('g');
    expect(activeGroupOf(gs, 'deleted-elsewhere')).toBeNull();
    expect(activeGroupOf(gs, null)).toBeNull();
  });
});

describe('ticketGroups', () => {
  const lw = (path: string, repoId: string, ticketId = '', branch = 'b') =>
    ({ path, branch, repoId, meta: ticketId ? { ticketId } : null } as Worktree);

  it('bundles worktrees made from the same ticket, whatever its format', () => {
    const out = ticketGroups([
      lw('/api/a', 'r1', 'PROJ-412'), lw('/web/a', 'r2', 'PROJ-412'),
      lw('/api/b', 'r1', '#981'), lw('/web/b', 'r2', '#981'),
      lw('/api/main', 'r1'),
    ]);
    expect(out).toEqual([
      { id: 'ticket:#981', name: '#981', createdAt: '', members: ['local:/api/b', 'local:/web/b'] },
      { id: 'ticket:PROJ-412', name: 'PROJ-412', createdAt: '', members: ['local:/api/a', 'local:/web/a'] },
    ]);
    expect(isAutoGroup(out[0]!)).toBe(true);
  });

  it('never reads a ticket out of a branch name', () => {
    expect(ticketGroups([lw('/a', 'r1', '', 'FX-412-api'), lw('/b', 'r2', '', 'FX-412-web')])).toEqual([]);
  });

  it('needs at least two worktrees to make a group', () => {
    expect(ticketGroups([lw('/a', 'r1', 'FX-1'), lw('/b', 'r2', 'FX-2')])).toEqual([]);
  });
});

describe('allGroups', () => {
  const lw = (path: string, ticketId: string) => ({ path, branch: 'b', repoId: 'r1', meta: { ticketId } } as Worktree);
  it('adds ticket groups after manual ones, skipping a ticket a manual group already names', () => {
    const manual: FocusGroup = { id: 'g1', name: 'FX-412', members: [], createdAt: 't' };
    const wts = [lw('/a', 'FX-412'), lw('/b', 'FX-412'), lw('/c', 'FD-9'), lw('/d', 'FD-9')];
    expect(allGroups([manual], wts).map((g) => g.id)).toEqual(['g1', 'ticket:FD-9']);
  });
});
