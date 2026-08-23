import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pickMrSummary, useMrSummaries, __resetMrCache, __resetMrCacheTtlOnly, invalidateMrPath } from './mrSummaries';
import { api } from '../api';
import type { MergeRequest } from '../types';

vi.mock('../api', () => ({
  api: { worktrees: { mergeRequests: vi.fn() } },
}));

const mocked = vi.mocked(api.worktrees.mergeRequests);

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
    mocked.mockImplementation(async (_ws, p) =>
      p === '/a'
        ? { kind: 'list' as const, provider: 'github' as const, mergeRequests: [mr({ number: 7 })] }
        : { kind: 'needsAuth' as const, provider: 'github' as const },
    );
    const { result } = renderHook(() => useMrSummaries('ws1', ['/a', '/b']));
    await waitFor(() => expect(result.current.get('/a')?.number).toBe(7));
    expect(result.current.get('/b')).toBeNull();
  });

  it('serves cached entries without refetching within the TTL', async () => {
    mocked.mockResolvedValue({ kind: 'list', provider: 'github', mergeRequests: [mr({ number: 9 })] });
    const first = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(first.result.current.get('/a')?.number).toBe(9));
    expect(mocked).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(second.result.current.get('/a')?.number).toBe(9));
    expect(mocked).toHaveBeenCalledTimes(1); // cache hit, no second request
  });

  it('dedupes concurrent requests for the same path', async () => {
    let release!: (v: { kind: 'list'; provider: 'github'; mergeRequests: MergeRequest[] }) => void;
    mocked.mockImplementation(() => new Promise((r) => { release = r; }));
    const a = renderHook(() => useMrSummaries('ws1', ['/a']));
    const b = renderHook(() => useMrSummaries('ws1', ['/a']));
    release({ kind: 'list', provider: 'github', mergeRequests: [mr({ number: 4 })] });
    await waitFor(() => expect(a.result.current.get('/a')?.number).toBe(4));
    await waitFor(() => expect(b.result.current.get('/a')?.number).toBe(4));
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known value when a refresh throws', async () => {
    mocked.mockResolvedValueOnce({ kind: 'list', provider: 'github', mergeRequests: [mr({ number: 2 })] });
    const first = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(first.result.current.get('/a')?.number).toBe(2));
    first.unmount();

    __resetMrCacheTtlOnly(); // see implementation note — expires TTL without dropping values
    mocked.mockRejectedValueOnce(new Error('server down'));
    const second = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.get('/a')?.number).toBe(2));
  });

  it('resolves to null (no unhandled rejection) when the api call throws synchronously', async () => {
    mocked.mockImplementation(() => {
      throw new Error('sync boom');
    });
    const { result } = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(result.current.get('/a')).toBeNull());
  });

  it('invalidateMrPath drops the cache so the next mount refetches', async () => {
    mocked.mockResolvedValue({ kind: 'list', provider: 'github', mergeRequests: [mr({ number: 1 })] });
    const first = renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(first.result.current.get('/a')?.number).toBe(1));
    first.unmount();
    invalidateMrPath('/a');
    renderHook(() => useMrSummaries('ws1', ['/a']));
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(2));
  });
});
