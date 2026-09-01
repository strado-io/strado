import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pickMrSummary, useMrSummaries, __resetMrCache, __resetMrCacheTtlOnly, invalidateMrPath } from './mrSummaries';
import { api } from '../api';
import type { MergeRequest } from '../types';

vi.mock('../api', () => ({
  api: { worktrees: { mergeRequests: vi.fn(), mergeRequestsBatch: vi.fn() } },
}));

const mocked = vi.mocked(api.worktrees.mergeRequests);
const batched = vi.mocked(api.worktrees.mergeRequestsBatch);

function mr(over: Partial<MergeRequest>): MergeRequest {
  return {
    number: 1, title: 't', state: 'open', webUrl: 'https://x/1',
    pipeline: null, approvals: null, sourceBranch: 'b', updatedAt: '2026-07-25T00:00:00Z',
    provider: 'github', ...over,
  };
}

beforeEach(() => {
  __resetMrCache();
  mocked.mockReset();
  batched.mockReset();
});

describe('pickMrSummary', () => {
  it('prefers the first open MR', () => {
    const list = [mr({ number: 3, state: 'merged' }), mr({ number: 2, state: 'open' }), mr({ number: 1, state: 'open' })];
    expect(pickMrSummary(list)?.number).toBe(2);
  });

  it('falls back to merged, then closed, then null', () => {
    expect(pickMrSummary([mr({ number: 5, state: 'closed' }), mr({ number: 4, state: 'merged' })])?.number).toBe(4);
    expect(pickMrSummary([mr({ number: 5, state: 'closed' })])?.number).toBe(5);
    expect(pickMrSummary([])).toBeNull();
  });
});

describe('useMrSummaries', () => {
  it('maps list responses to summaries and non-list to null', async () => {
    batched.mockImplementation(async (_ws, paths) => ({
      results: Object.fromEntries(paths.map((p) => [p, p === '/a'
        ? { kind: 'list' as const, provider: 'github' as const, mergeRequests: [mr({ number: 7 })] }
        : { kind: 'needsAuth' as const, provider: 'github' as const }])),
    }));
    const { result } = renderHook(() => useMrSummaries('ws1', ['/a', '/b']));
    await waitFor(() => expect(result.current.get('/a')?.number).toBe(7));
    expect(result.current.get('/b')).toBeNull();
  });

  it('serves cached entries without refetching within the TTL', async () => {
    batched.mockResolvedValue({
      results: { '/a': { kind: 'list', provider: 'github', mergeRequests: [mr({ number: 9 })] } },
    });
    const first = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(first.result.current.get('/a')?.number).toBe(9));
    expect(batched).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(second.result.current.get('/a')?.number).toBe(9));
    expect(batched).toHaveBeenCalledTimes(1); // cache hit, no second request
  });

  it('dedupes concurrent requests for the same path', async () => {
    let release!: (v: { results: Record<string, { kind: 'list'; provider: 'github'; mergeRequests: MergeRequest[] }> }) => void;
    batched.mockImplementation(() => new Promise((r) => { release = r; }));
    const a = renderHook(() => useMrSummaries('ws1', ['/a']));
    const b = renderHook(() => useMrSummaries('ws1', ['/a']));
    release({ results: { '/a': { kind: 'list', provider: 'github', mergeRequests: [mr({ number: 4 })] } } });
    await waitFor(() => expect(a.result.current.get('/a')?.number).toBe(4));
    await waitFor(() => expect(b.result.current.get('/a')?.number).toBe(4));
    expect(batched).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known value when a refresh throws', async () => {
    batched.mockResolvedValueOnce({
      results: { '/a': { kind: 'list', provider: 'github', mergeRequests: [mr({ number: 2 })] } },
    });
    const first = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(first.result.current.get('/a')?.number).toBe(2));
    first.unmount();

    __resetMrCacheTtlOnly(); // see implementation note — expires TTL without dropping values
    batched.mockRejectedValueOnce(new Error('server down'));
    const second = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(batched).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.get('/a')?.number).toBe(2));
  });

  it('resolves to null (no unhandled rejection) when the api call throws synchronously', async () => {
    batched.mockImplementation(() => {
      throw new Error('sync boom');
    });
    const { result } = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(result.current.get('/a')).toBeNull());
  });

  it('invalidateMrPath drops the cache so the next mount refetches', async () => {
    batched.mockResolvedValue({
      results: { '/a': { kind: 'list', provider: 'github', mergeRequests: [mr({ number: 1 })] } },
    });
    const first = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(first.result.current.get('/a')?.number).toBe(1));
    first.unmount();
    invalidateMrPath('/a');
    renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(batched).toHaveBeenCalledTimes(2));
  });
});

describe('useMrSummaries polling cadence', () => {
  it('serves the fresh cache instead of refetching once a minute', async () => {
    vi.useFakeTimers();
    try {
      batched.mockResolvedValue({ results: { '/a': { kind: 'needsAuth' as const, provider: 'github' as const } } });
      const { unmount } = renderHook(() => useMrSummaries('ws1', ['/a']));
      await vi.advanceTimersByTimeAsync(0);
      expect(batched).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(batched).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still refreshes on the slower poll cadence', async () => {
    vi.useFakeTimers();
    try {
      batched.mockResolvedValue({ results: { '/a': { kind: 'needsAuth' as const, provider: 'github' as const } } });
      const { unmount } = renderHook(() => useMrSummaries('ws1', ['/a']));
      await vi.advanceTimersByTimeAsync(0);
      expect(batched).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(batched).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useMrSummaries batching', () => {
  it('asks for every path in a single request', async () => {
    const paths = ['/a', '/b', '/c', '/d', '/e'];
    batched.mockResolvedValue({
      results: Object.fromEntries(paths.map((p) => [p, {
        kind: 'list' as const, provider: 'github' as const, mergeRequests: [mr({ number: 7 })],
      }])),
    });
    const { result } = renderHook(() => useMrSummaries('ws1', paths));
    await waitFor(() => expect(result.current.get('/e')?.number).toBe(7));
    expect(batched).toHaveBeenCalledTimes(1);
    expect(batched).toHaveBeenCalledWith('ws1', paths);
  });

  it('only asks for the paths that are not already cached', async () => {
    batched.mockResolvedValue({
      results: { '/a': { kind: 'list' as const, provider: 'github' as const, mergeRequests: [mr({ number: 1 })] } },
    });
    const first = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(first.result.current.get('/a')?.number).toBe(1));

    batched.mockResolvedValue({
      results: { '/b': { kind: 'list' as const, provider: 'github' as const, mergeRequests: [mr({ number: 2 })] } },
    });
    const second = renderHook(() => useMrSummaries('ws1', ['/a', '/b']));
    await waitFor(() => expect(second.result.current.get('/b')?.number).toBe(2));

    expect(second.result.current.get('/a')?.number).toBe(1);
    expect(batched).toHaveBeenLastCalledWith('ws1', ['/b']);
  });

  it('keeps the last known chip when the batch call fails', async () => {
    batched.mockResolvedValueOnce({
      results: { '/a': { kind: 'list' as const, provider: 'github' as const, mergeRequests: [mr({ number: 3 })] } },
    });
    const first = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(first.result.current.get('/a')?.number).toBe(3));
    first.unmount();

    __resetMrCacheTtlOnly();
    batched.mockRejectedValueOnce(new Error('server down'));
    const second = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(batched).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.get('/a')?.number).toBe(3));
  });

  it('maps a per-path error entry to no chip', async () => {
    batched.mockResolvedValue({
      results: { '/a': { kind: 'error' as const, message: 'GitLab at gl.test is unreachable' } },
    });
    const { result } = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(result.current.get('/a')).toBeNull());
  });
});
