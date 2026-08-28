import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { CodeReview } from '../types';
import { useCodeReviews } from './codeReviews';

vi.mock('../api', () => ({ api: { reviews: { list: vi.fn() } } }));

const list = vi.mocked(api.reviews.list);
const counts = { open: 120, merged: 80, closed: 4 };
const repositories = [{
  repoId: 'r1', repoName: 'Repo', provider: 'gitlab' as const, status: 'ok' as const, counts,
}];

function review(number: number, updatedAt: string): CodeReview {
  return {
    number, title: `Review ${number}`, state: 'open', webUrl: `https://example.com/${number}`,
    pipeline: null, approvals: null, sourceBranch: `branch-${number}`, targetBranch: 'main',
    updatedAt, provider: 'gitlab', repoId: 'r1', repoName: 'Repo',
  };
}

beforeEach(() => { list.mockReset(); });

describe('useCodeReviews pagination', () => {
  it('refetches from page 1 when the repository filter changes', async () => {
    list.mockResolvedValue({
      reviews: [review(1, '2026-08-01T00:00:00Z')], repositories, counts, page: 1, pageSize: 20, hasMore: true, pageLimit: null,
    });

    const { rerender } = renderHook(({ repoId }) => useCodeReviews('ws1', 'open', '', repoId), {
      initialProps: { repoId: 'all' },
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    rerender({ repoId: 'r1' });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith('ws1', 'open', 1, '', 'r1');
  });

  it('refreshes the page the user is on, not the one it started from', async () => {
    const page = (n: number) => ({
      reviews: [review(n, '2026-08-01T00:00:00Z')], repositories, counts,
      page: n, pageSize: 20, hasMore: true, pageLimit: null,
    });
    list.mockResolvedValueOnce(page(1)).mockResolvedValue(page(2));
    const { result } = renderHook(() => useCodeReviews('ws1', 'open', ''));
    await waitFor(() => expect(result.current.page).toBe(1));

    await act(async () => { await result.current.goToPage(2); });
    list.mockClear();
    // The background poll takes this path; it must re-ask for page 2.
    await act(async () => { result.current.refresh(); });

    await waitFor(() => expect(list).toHaveBeenLastCalledWith('ws1', 'open', 2, '', 'all'));
  });

  it('carries search into numbered pages and replaces the previous page', async () => {
    list
      .mockResolvedValueOnce({
        reviews: [review(1, '2026-08-01T00:00:00Z')], repositories, counts, page: 1, pageSize: 20, hasMore: true, pageLimit: null,
      })
      .mockResolvedValueOnce({
        reviews: [review(2, '2026-08-02T00:00:00Z')],
        repositories, counts, page: 2, pageSize: 20, hasMore: false, pageLimit: null,
      });

    const { result } = renderHook(() => useCodeReviews('ws1', 'open', 'fuel issue'));
    await waitFor(() => expect(result.current.page).toBe(1));

    await act(async () => { await result.current.goToPage(2); });

    expect(list).toHaveBeenNthCalledWith(1, 'ws1', 'open', 1, 'fuel issue', 'all');
    expect(list).toHaveBeenNthCalledWith(2, 'ws1', 'open', 2, 'fuel issue', 'all');
    expect(result.current.reviews.map((item) => item.number)).toEqual([2]);
    expect(result.current.pageSize).toBe(20);
    expect(result.current.hasMore).toBe(false);
  });
});
