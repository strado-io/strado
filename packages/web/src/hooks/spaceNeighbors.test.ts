import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpaceNeighbors } from './spaceNeighbors';
import type { RepoConfig, Workspace, Worktree } from '../types';

vi.mock('../api', () => ({
  api: { repos: { list: vi.fn() }, worktrees: { list: vi.fn() } },
}));
const { api } = await import('../api');

const ws = (id: string): Workspace => ({
  id, name: id.toUpperCase(), color: '#333', icon: id[0]!, defaultEditor: 'code',
  defaultPortBase: 8080, logDir: null,
});
const spaces = [ws('a'), ws('b'), ws('c')];
const repo = (id: string) => ({ id, name: id, path: `/${id}` }) as RepoConfig;

beforeEach(() => {
  vi.mocked(api.repos.list).mockReset();
  vi.mocked(api.worktrees.list).mockReset();
  vi.mocked(api.repos.list).mockImplementation(async (id: string) => [repo(`repo-${id}`)]);
  vi.mocked(api.worktrees.list).mockImplementation(async () => [] as Worktree[]);
});

describe('useSpaceNeighbors', () => {
  it('loads only the two neighbours of the active space', async () => {
    const { result } = renderHook(() => useSpaceNeighbors(spaces, 'b'));
    await waitFor(() => expect(result.current.prev?.data).not.toBeNull());
    await waitFor(() => expect(result.current.next?.data).not.toBeNull());
    expect(result.current.prev?.space.id).toBe('a');
    expect(result.current.next?.space.id).toBe('c');
    expect(result.current.prev?.data?.repos[0]!.id).toBe('repo-a');
    expect(vi.mocked(api.repos.list).mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'c']);
  });

  it('defers the prefetch instead of racing the active space to the server', async () => {
    // Child effects run before their parent's, so a bare fetch here goes out
    // ahead of the active space's own repos/worktrees — and `GET /worktrees`
    // is a `git worktree list` per repo. Nothing may be in flight yet at the
    // moment the effect runs.
    const { result } = renderHook(() => useSpaceNeighbors(spaces, 'b'));
    expect(vi.mocked(api.repos.list)).not.toHaveBeenCalled();
    expect(vi.mocked(api.worktrees.list)).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.next?.data).not.toBeNull());
  });

  it('has no prev at the first space and no next at the last', async () => {
    const first = renderHook(() => useSpaceNeighbors(spaces, 'a'));
    expect(first.result.current.prev).toBeNull();
    expect(first.result.current.next?.space.id).toBe('b');

    const last = renderHook(() => useSpaceNeighbors(spaces, 'c'));
    expect(last.result.current.next).toBeNull();
    expect(last.result.current.prev?.space.id).toBe('b');
  });

  it('keeps data null when a neighbour fails to load, without throwing', async () => {
    vi.mocked(api.worktrees.list).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useSpaceNeighbors(spaces, 'b'));
    await waitFor(() => expect(vi.mocked(api.worktrees.list)).toHaveBeenCalled());
    expect(result.current.next?.data).toBeNull();
  });

  it('refetches when the active space changes', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useSpaceNeighbors(spaces, id),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(result.current.next?.data).not.toBeNull());
    vi.mocked(api.repos.list).mockClear();
    rerender({ id: 'b' });
    await waitFor(() =>
      expect(vi.mocked(api.repos.list).mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'c']),
    );
  });

  it('returns both neighbours as null for a single space', () => {
    const { result } = renderHook(() => useSpaceNeighbors([ws('a')], 'a'));
    expect(result.current.prev).toBeNull();
    expect(result.current.next).toBeNull();
    expect(vi.mocked(api.repos.list)).not.toHaveBeenCalled();
  });

  it('evicts snapshots for spaces that are no longer neighbours', async () => {
    const fiveSpaces = [ws('a'), ws('b'), ws('c'), ws('d'), ws('e')];
    let shouldDeferA = false;
    const resolveMap: Record<string, (val: RepoConfig[]) => void> = {};

    vi.mocked(api.repos.list).mockImplementation((id: string) => {
      return new Promise<RepoConfig[]>((resolve) => {
        if (id === 'a' && shouldDeferA) {
          resolveMap['a'] = resolve;
        } else {
          resolve([repo(`repo-${id}`)]);
        }
      });
    });
    vi.mocked(api.worktrees.list).mockImplementation(async () => []);

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useSpaceNeighbors(fiveSpaces, id),
      { initialProps: { id: 'b' } },
    );

    // Active: b, neighbours: a (prev), c (next)
    // Wait for both to load
    await waitFor(() => expect(result.current.prev?.data).not.toBeNull());
    await waitFor(() => expect(result.current.next?.data).not.toBeNull());
    expect(result.current.prev?.data?.repos[0]?.id).toBe('repo-a');

    // Now enable deferral for 'a' on the next fetch
    shouldDeferA = true;

    // Move to d: neighbours: c (prev), e (next)
    // 'a' is no longer a neighbour and must be evicted from snapshots
    rerender({ id: 'd' });
    await waitFor(() => expect(result.current.next?.data).not.toBeNull());

    // Move back to b: neighbours: a (prev), c (next)
    rerender({ id: 'b' });

    // IMMEDIATELY after rerender (before 'a' refetch resolves), prev.data MUST be null
    // because 'a' was evicted from snapshots. Without pruning, the stale 'a' entry
    // would still be in the map and prev.data would be populated synchronously.
    expect(result.current.prev?.data).toBeNull();
    expect(result.current.prev?.space.id).toBe('a');

    // Now resolve the pending fetch for 'a' — which is deferred out of the
    // effect, so it has to be waited for rather than assumed to be in flight.
    await waitFor(() => expect(resolveMap['a']).toBeDefined());
    resolveMap['a']!([repo('repo-a')]);

    // Wait for it to load
    await waitFor(() => expect(result.current.prev?.data).not.toBeNull());
    expect(result.current.prev?.data?.repos[0]?.id).toBe('repo-a');
  });

  it('isolates failure to one neighbour without affecting the other', async () => {
    vi.mocked(api.repos.list).mockImplementation(async (id: string) => {
      if (id === 'a') {
        return [repo(`repo-a`)];
      } else if (id === 'c') {
        throw new Error('failed to load c');
      }
      return [];
    });
    vi.mocked(api.worktrees.list).mockImplementation(async () => []);

    const { result } = renderHook(() => useSpaceNeighbors(spaces, 'b'));

    // Wait for both to settle
    await waitFor(() => expect(vi.mocked(api.repos.list)).toHaveBeenCalledWith('c'));

    // Verify that a loaded successfully while c failed
    expect(result.current.prev?.data).not.toBeNull();
    expect(result.current.prev?.data?.repos[0]?.id).toBe('repo-a');

    expect(result.current.next?.data).toBeNull();
    expect(result.current.next?.space.id).toBe('c');
  });
});
