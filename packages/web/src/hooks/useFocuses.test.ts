import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Focus } from '../api';
import { useFocuses, __resetFocuses } from './useFocuses';

vi.mock('../api', () => ({
  api: { focuses: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } },
}));
const f = (over: Partial<Focus>): Focus => ({ id: 'f1', name: 'F', members: [], createdAt: 't', lastActiveAt: 't', ...over });

beforeEach(() => {
  __resetFocuses();
  localStorage.clear();
  vi.mocked(api.focuses.list).mockReset();
  vi.mocked(api.focuses.create).mockReset();
  vi.mocked(api.focuses.update).mockReset();
  vi.mocked(api.focuses.remove).mockReset();
});

describe('useFocuses', () => {
  it('loads once and shares the list between hook instances', async () => {
    vi.mocked(api.focuses.list).mockResolvedValue([f({})]);
    const a = renderHook(() => useFocuses('w1'));
    const b = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(a.result.current.focuses).toHaveLength(1));
    expect(b.result.current.focuses).toHaveLength(1);
    expect(api.focuses.list).toHaveBeenCalledTimes(1);
  });

  it('treats a failed load as no focuses, and retries on the next mount', async () => {
    vi.mocked(api.focuses.list).mockRejectedValueOnce(new Error('blip')).mockResolvedValue([f({})]);
    const first = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    expect(first.result.current.focuses).toEqual([]);
    first.unmount();
    const second = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(second.result.current.focuses).toHaveLength(1));
  });

  it('the active focus is per workspace on this device, and ignores an id no longer in the list', async () => {
    localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ w1: 'f1', w2: 'gone' }));
    vi.mocked(api.focuses.list).mockResolvedValue([f({ id: 'f1' })]);
    vi.mocked(api.focuses.update).mockImplementation(async (_ws, id) => f({ id }));
    const w1 = renderHook(() => useFocuses('w1'));
    const w2 = renderHook(() => useFocuses('w2'));
    await waitFor(() => expect(w1.result.current.active?.id).toBe('f1'));
    await waitFor(() => expect(w2.result.current.loaded).toBe(true));
    expect(w2.result.current.active).toBeNull();
    // Activating is instant locally and touches the server for ordering.
    act(() => { w1.result.current.activate(null); });
    expect(w1.result.current.active).toBeNull();
    act(() => { w1.result.current.activate('f1'); });
    expect(w1.result.current.active?.id).toBe('f1');
    await waitFor(() => expect(api.focuses.update).toHaveBeenCalledWith('w1', 'f1', { touch: true }));
    expect(JSON.parse(localStorage.getItem('strado:active-focus-by-ws')!)).toEqual({ w1: 'f1', w2: 'gone' });
  });

  it('create appends and activates; remove drops and clears the active id when it was active', async () => {
    vi.mocked(api.focuses.list).mockResolvedValueOnce([]).mockResolvedValueOnce([f({ id: 'new', name: 'N' })]).mockResolvedValue([]);
    vi.mocked(api.focuses.create).mockResolvedValue(f({ id: 'new', name: 'N' }));
    vi.mocked(api.focuses.remove).mockResolvedValue(undefined);
    const { result } = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { await result.current.create('N', ['local:/a']); });
    expect(api.focuses.create).toHaveBeenCalledWith('w1', { name: 'N', members: ['local:/a'], ticket: undefined });
    expect(result.current.focuses.map((x) => x.id)).toEqual(['new']);
    expect(result.current.active?.id).toBe('new');
    await act(async () => { await result.current.remove('new'); });
    expect(result.current.focuses).toEqual([]);
    expect(result.current.activeId).toBeNull();
  });

  it('applies each membership result to the latest list, then refetches to pick up other changes', async () => {
    vi.mocked(api.focuses.list)
      .mockResolvedValueOnce([f({ id: 'f1' }), f({ id: 'f2' })])
      .mockResolvedValue([f({ id: 'f1', members: ['local:/a'] }), f({ id: 'f2', members: ['local:/b'] }), f({ id: 'from-elsewhere' })]);
    vi.mocked(api.focuses.update).mockImplementation(async (_ws, id, patch) => f({ id, members: patch.addMembers ?? [] }));
    const { result } = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(result.current.focuses).toHaveLength(2));
    await act(async () => {
      await Promise.all([
        result.current.setMembership('f1', 'local:/a', true),
        result.current.setMembership('f2', 'local:/b', true),
      ]);
    });
    expect(api.focuses.update).toHaveBeenCalledWith('w1', 'f1', { addMembers: ['local:/a'] });
    await waitFor(() => expect(result.current.focuses.map((x) => x.id)).toEqual(['f1', 'f2', 'from-elsewhere']));
  });

  it('refetches after a failed mutation, so a focus deleted elsewhere drops out', async () => {
    vi.mocked(api.focuses.list).mockResolvedValueOnce([f({ id: 'gone' })]).mockResolvedValue([]);
    vi.mocked(api.focuses.update).mockRejectedValue(new Error('focus gone not found'));
    const { result } = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(result.current.focuses).toHaveLength(1));
    await act(async () => {
      await expect(result.current.rename('gone', 'x')).rejects.toThrow(/not found/);
    });
    await waitFor(() => expect(result.current.focuses).toEqual([]));
  });

  it('ignores an older list reply that lands after a newer one', async () => {
    const replies: ((v: Focus[]) => void)[] = [];
    vi.mocked(api.focuses.list).mockImplementation(() => new Promise((r) => { replies.push(r); }));
    vi.mocked(api.focuses.update).mockImplementation(async (_ws, id) => f({ id }));
    const { result } = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(replies).toHaveLength(1));
    await act(async () => { replies[0]!([f({ id: 'f1' })]); });
    await act(async () => { await result.current.setMembership('f1', 'local:/a', true); });
    await act(async () => { await result.current.setMembership('f1', 'local:/b', true); });
    await waitFor(() => expect(replies).toHaveLength(3));
    await act(async () => { replies[2]!([f({ id: 'f1', members: ['local:/a', 'local:/b'] })]); });
    await act(async () => { replies[1]!([f({ id: 'f1', members: ['local:/a'] })]); });
    expect(result.current.focuses[0]!.members).toEqual(['local:/a', 'local:/b']);
  });

  it('refreshes when the window regains focus', async () => {
    vi.mocked(api.focuses.list).mockResolvedValueOnce([]).mockResolvedValue([f({ id: 'new-elsewhere' })]);
    const { result } = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(result.current.focuses.map((x) => x.id)).toEqual(['new-elsewhere']));
  });

  it('migrates the old Working on list into a first focus, once, and activates it', async () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: ['local:/a', 'remote:r1:/x'], w2: ['local:/z'] }));
    vi.mocked(api.focuses.list).mockResolvedValue([]);
    vi.mocked(api.focuses.create).mockImplementation(async (_ws, body) => f({ id: 'mig', name: body.name, members: body.members ?? [] }));
    const { result } = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(result.current.focuses).toHaveLength(1));
    expect(api.focuses.create).toHaveBeenCalledWith('w1', { name: 'Working on', members: ['local:/a', 'remote:r1:/x'] });
    expect(result.current.active?.id).toBe('mig');
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: [], w2: ['local:/z'] });
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(api.focuses.list).toHaveBeenCalledTimes(2));
    expect(api.focuses.create).toHaveBeenCalledTimes(1);
  });

  it('does not migrate when the workspace already has a focus', async () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: ['local:/a'] }));
    vi.mocked(api.focuses.list).mockResolvedValue([f({ id: 'have' })]);
    const { result } = renderHook(() => useFocuses('w1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(api.focuses.create).not.toHaveBeenCalled();
    expect(result.current.active).toBeNull();
  });
});
