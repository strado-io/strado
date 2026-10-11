import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type FocusGroup } from '../api';
import { useFocusGroups, __resetFocusGroups } from './useFocusGroups';

vi.mock('../api', () => ({
  api: { groups: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } },
}));
const g = (over: Partial<FocusGroup>): FocusGroup => ({ id: 'g1', name: 'G', members: [], createdAt: 't', ...over });

beforeEach(() => {
  __resetFocusGroups();
  vi.mocked(api.groups.list).mockReset();
  vi.mocked(api.groups.create).mockReset();
  vi.mocked(api.groups.update).mockReset();
  vi.mocked(api.groups.remove).mockReset();
});

describe('useFocusGroups', () => {
  it('loads once and shares the list between hook instances', async () => {
    vi.mocked(api.groups.list).mockResolvedValue([g({})]);
    const a = renderHook(() => useFocusGroups('w1'));
    const b = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(a.result.current.groups).toHaveLength(1));
    expect(b.result.current.groups).toHaveLength(1);
    expect(api.groups.list).toHaveBeenCalledTimes(1);
  });

  it('treats a failed load as no groups', async () => {
    vi.mocked(api.groups.list).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.groups).toEqual([]);
  });

  it('treats a synchronous throw (incomplete api mock, bad client) as no groups', async () => {
    vi.mocked(api.groups.list).mockImplementation(() => { throw new Error('sync'); });
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.groups).toEqual([]);
  });

  it('applies each mutation result to the latest list', async () => {
    vi.mocked(api.groups.list)
      .mockResolvedValueOnce([g({ id: 'g1' }), g({ id: 'g2' })])
      .mockResolvedValue([g({ id: 'g1', members: ['local:/a'] }), g({ id: 'g2', members: ['local:/b'] })]);
    vi.mocked(api.groups.update).mockImplementation(async (_ws, id, patch) =>
      g({ id, members: patch.addMembers ?? [] }));
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    await act(async () => {
      await Promise.all([
        result.current.setMembership('g1', 'local:/a', true),
        result.current.setMembership('g2', 'local:/b', true),
      ]);
    });
    expect(result.current.groups.map((x) => x.members)).toEqual([['local:/a'], ['local:/b']]);
    expect(api.groups.update).toHaveBeenCalledWith('w1', 'g1', { addMembers: ['local:/a'] });
  });

  it('create appends, remove drops', async () => {
    vi.mocked(api.groups.list).mockResolvedValueOnce([]).mockResolvedValueOnce([g({ id: 'new', name: 'N' })]).mockResolvedValue([]);
    vi.mocked(api.groups.create).mockResolvedValue(g({ id: 'new', name: 'N' }));
    vi.mocked(api.groups.remove).mockResolvedValue(undefined);
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { await result.current.create('N', ['local:/a']); });
    expect(result.current.groups.map((x) => x.id)).toEqual(['new']);
    await act(async () => { await result.current.remove('new'); });
    expect(result.current.groups).toEqual([]);
  });

  it('retries the load on the next mount after a failure', async () => {
    vi.mocked(api.groups.list).mockRejectedValueOnce(new Error('blip')).mockResolvedValue([g({})]);
    const first = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    expect(first.result.current.groups).toEqual([]);
    first.unmount();
    const second = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(second.result.current.groups).toHaveLength(1));
  });

  it('refetches the whole list after a mutation, picking up other changes', async () => {
    vi.mocked(api.groups.list)
      .mockResolvedValueOnce([g({ id: 'g1' })])
      .mockResolvedValue([g({ id: 'g1', members: ['local:/a'] }), g({ id: 'from-elsewhere' })]);
    vi.mocked(api.groups.update).mockResolvedValue(g({ id: 'g1', members: ['local:/a'] }));
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    await act(async () => { await result.current.setMembership('g1', 'local:/a', true); });
    await waitFor(() => expect(result.current.groups.map((x) => x.id)).toEqual(['g1', 'from-elsewhere']));
  });

  it('refetches after a failed mutation, so a group deleted elsewhere drops out', async () => {
    vi.mocked(api.groups.list).mockResolvedValueOnce([g({ id: 'gone' })]).mockResolvedValue([]);
    vi.mocked(api.groups.update).mockRejectedValue(new Error('focus group gone not found'));
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    await act(async () => {
      await expect(result.current.setMembership('gone', 'local:/a', true)).rejects.toThrow(/not found/);
    });
    await waitFor(() => expect(result.current.groups).toEqual([]));
  });

  it('setState patches the group and shows the answer', async () => {
    vi.mocked(api.groups.list)
      .mockResolvedValueOnce([g({ id: 'g1' })])
      .mockResolvedValue([g({ id: 'g1', state: 'parked' })]);
    vi.mocked(api.groups.update).mockImplementation(async (_ws, id, patch) => g({ id, state: patch.state }));
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    await act(async () => { await result.current.setState('g1', 'parked'); });
    expect(api.groups.update).toHaveBeenCalledWith('w1', 'g1', { state: 'parked' });
    expect(result.current.groups[0]!.state).toBe('parked');
  });

  it('ignores an older list reply that lands after a newer one', async () => {
    const replies: ((v: FocusGroup[]) => void)[] = [];
    vi.mocked(api.groups.list).mockImplementation(() => new Promise((r) => { replies.push(r); }));
    vi.mocked(api.groups.update).mockImplementation(async (_ws, id) => g({ id }));
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(replies).toHaveLength(1));
    await act(async () => { replies[0]!([g({ id: 'g1' })]); });
    await act(async () => { await result.current.setMembership('g1', 'local:/a', true); });
    await act(async () => { await result.current.setMembership('g1', 'local:/b', true); });
    await waitFor(() => expect(replies).toHaveLength(3));
    await act(async () => { replies[2]!([g({ id: 'g1', members: ['local:/a', 'local:/b'] })]); });
    await act(async () => { replies[1]!([g({ id: 'g1', members: ['local:/a'] })]); });
    expect(result.current.groups[0]!.members).toEqual(['local:/a', 'local:/b']);
  });

  it('refreshes when the window regains focus', async () => {
    vi.mocked(api.groups.list).mockResolvedValueOnce([]).mockResolvedValue([g({ id: 'new-elsewhere' })]);
    const { result } = renderHook(() => useFocusGroups('w1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(result.current.groups.map((x) => x.id)).toEqual(['new-elsewhere']));
  });
});

