import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationDto } from '../api';

const h = vi.hoisted(() => ({
  stations: vi.fn(),
  intercomHandlers: new Set<(e: unknown) => void>(),
  worktreeHandlers: new Set<(e: unknown) => void>(),
}));
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { ...actual.api, intercom: { ...actual.api.intercom, stations: h.stations } } };
});
vi.mock('../eventStream', () => ({
  subscribeIntercom: (_ws: string, fn: (e: unknown) => void) => { h.intercomHandlers.add(fn); return () => { h.intercomHandlers.delete(fn); }; },
  subscribeWorktrees: (fn: (e: unknown) => void) => { h.worktreeHandlers.add(fn); return () => { h.worktreeHandlers.delete(fn); }; },
}));

import { STATIONS_THROTTLE_MS, useStations } from './stations';

const st = (over: Partial<StationDto> = {}): StationDto => ({
  agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/wt/a', worktreeName: 'a', sessionId: '1',
  lifecycle: 'idle', live: true, calls: [], lastActivityAt: 1, ...over,
});

beforeEach(() => {
  h.stations.mockReset();
  h.intercomHandlers.clear();
  h.worktreeHandlers.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe('useStations', () => {
  it('loads the stations for the workspace', async () => {
    h.stations.mockResolvedValue([st()]);
    const { result } = renderHook(() => useStations('ws1'));
    await waitFor(() => expect(result.current.stations).toHaveLength(1));
    expect(h.stations).toHaveBeenCalledWith('ws1');
  });

  it('refetches on intercom and worktree events, at most once per throttle window', async () => {
    vi.useFakeTimers();
    h.stations.mockResolvedValue([st()]);
    renderHook(() => useStations('ws1'));
    await act(async () => { await Promise.resolve(); });
    expect(h.stations).toHaveBeenCalledTimes(1);
    act(() => {
      for (const f of h.intercomHandlers) f({ type: 'intercom.escalation' });
      for (const f of h.worktreeHandlers) f({ type: 'worktree.updated' });
      for (const f of h.intercomHandlers) f({ type: 'intercom.message' });
    });
    await act(async () => { vi.advanceTimersByTime(STATIONS_THROTTLE_MS); await Promise.resolve(); });
    expect(h.stations).toHaveBeenCalledTimes(2); // three events, one refetch
  });

  it('a failed load keeps the last good list (the dock never flashes empty)', async () => {
    h.stations.mockResolvedValueOnce([st()]).mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useStations('ws1'));
    await waitFor(() => expect(result.current.stations).toHaveLength(1));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.stations).toHaveLength(1);
  });
});
