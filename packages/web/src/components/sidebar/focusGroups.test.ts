import { describe, expect, it } from 'vitest';
import type { RemoteWorktree } from '../../api';
import type { FocusGroup } from '../../api';
import type { Worktree } from '../../types';
import { activeGroupOf, isGroupDone, nextMember, resolveMembers } from './focusGroups';

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
