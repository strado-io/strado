import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUsage } from './usage';
import type { UsageSummary } from '../types';

const summary = (cost: number): UsageSummary => ({
  range: { from: '2026-08-03', to: '2026-09-01' },
  totals: {
    cost, tokens: 100, cachedInput: 90, uncachedInput: 5, cacheWrite: 0,
    output: 5, cacheSavings: 1, cacheSavingsMultiple: 2,
  },
  byAgent: { claude: { cost, tokens: 100 }, codex: { cost: 0, tokens: 0 } },
  series: [{ date: '2026-09-01', claude: { cost, tokens: 100 }, codex: { cost: 0, tokens: 0 } }],
  models: [], worktrees: [], skipped: 0, bytesRead: 0,
});

const accounts = [{
  agent: 'claude' as const,
  accountLabel: 'dev@example.com',
  plan: 'TEAM',
  credentialSource: 'Keychain',
  windows: [{ label: 'Session (5h)', usedPercent: 2, resetsAt: null }],
  quotaStatus: 'official' as const,
}];

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  accounts: vi.fn(),
}));

vi.mock('../api', () => ({
  api: { usage: { summary: mocks.summary, accounts: mocks.accounts } },
}));

beforeEach(() => {
  mocks.summary.mockReset().mockResolvedValue(summary(10));
  mocks.accounts.mockReset().mockResolvedValue(accounts);
});

describe('useUsage', () => {
  it('loads the summary and accounts for the workspace', async () => {
    const { result } = renderHook(() => useUsage('ws-1', 30));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.summary?.totals.cost).toBe(10);
    expect(result.current.accounts).toEqual(accounts);
    expect(mocks.summary).toHaveBeenCalledWith('ws-1', 30);
  });

  it('refetches when the range changes', async () => {
    const { result, rerender } = renderHook(({ days }: { days: 7 | 30 | 90 }) => useUsage('ws-1', days), {
      initialProps: { days: 30 as 7 | 30 | 90 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ days: 7 });

    await waitFor(() => expect(mocks.summary).toHaveBeenLastCalledWith('ws-1', 7));
  });

  it('ignores a stale response that lands after a newer request', async () => {
    let resolveFirst: (value: UsageSummary) => void = () => {};
    mocks.summary.mockImplementationOnce(() => new Promise<UsageSummary>((resolve) => { resolveFirst = resolve; }));
    mocks.summary.mockResolvedValueOnce(summary(20));

    const { result, rerender } = renderHook(({ days }: { days: 7 | 30 | 90 }) => useUsage('ws-1', days), {
      initialProps: { days: 30 as 7 | 30 | 90 },
    });
    rerender({ days: 7 });
    await waitFor(() => expect(result.current.summary?.totals.cost).toBe(20));

    await act(async () => { resolveFirst(summary(999)); });

    expect(result.current.summary?.totals.cost).toBe(20);
  });

  it('keeps showing data while a refresh is in flight', async () => {
    const { result } = renderHook(() => useUsage('ws-1', 30));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.refresh(); });

    expect(result.current.summary?.totals.cost).toBe(10);
    expect(result.current.refreshing).toBe(true);
    await waitFor(() => expect(result.current.refreshing).toBe(false));
  });

  it('surfaces an error without dropping the data it already had', async () => {
    const { result } = renderHook(() => useUsage('ws-1', 30));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.summary.mockRejectedValueOnce(new Error('server down'));

    act(() => { result.current.refresh(); });

    await waitFor(() => expect(result.current.error).toBe('server down'));
    expect(result.current.summary?.totals.cost).toBe(10);
  });

  it('still renders the summary when the accounts call fails', async () => {
    mocks.accounts.mockRejectedValueOnce(new Error('keychain locked'));

    const { result } = renderHook(() => useUsage('ws-1', 30));

    await waitFor(() => expect(result.current.summary?.totals.cost).toBe(10));
    expect(result.current.accounts).toEqual([]);
  });

  it('clears data when the workspace changes', async () => {
    const { result, rerender } = renderHook(({ ws }: { ws: string }) => useUsage(ws, 30), {
      initialProps: { ws: 'ws-1' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    mocks.summary.mockImplementationOnce(() => new Promise(() => {}));
    rerender({ ws: 'ws-2' });

    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(true);
  });
});
