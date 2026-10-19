import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ feed: vi.fn(), handlers: new Set<(e: { type: string }) => void>() }));
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { ...actual.api, intercom: { ...actual.api.intercom, feed: h.feed } } };
});
vi.mock('../eventStream', () => ({
  subscribeIntercom: (_ws: string, fn: (e: { type: string }) => void) => { h.handlers.add(fn); return () => { h.handlers.delete(fn); }; },
}));

import { FEED_THROTTLE_MS, useFeed } from './feed';

const msg = (over: Record<string, unknown> = {}) => ({
  id: 'm1', from: { agentId: 'claude-2@app', alias: null, executionId: 'x' }, to: 'claude-1@app', kind: 'message',
  body: 'can you rebase?\nthe second line is dropped', createdAt: 5, ...over,
});

beforeEach(() => { h.feed.mockReset(); h.handlers.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe('useFeed', () => {
  it('loads a station\'s line (or the whole line), first line of each body only', async () => {
    h.feed.mockResolvedValue([msg()]);
    const { result } = renderHook(() => useFeed('ws1', 'claude-1@app', true));
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(h.feed).toHaveBeenCalledWith('ws1', { agent: 'claude-1@app', limit: 50 });
    expect(result.current[0]).toEqual({ id: 'm1', from: 'claude-2@app', to: 'claude-1@app', body: 'can you rebase?', at: 5 });
  });

  it('closed (no card, no Line): no fetch at all', async () => {
    renderHook(() => useFeed('ws1', null, false));
    await act(async () => { await Promise.resolve(); });
    expect(h.feed).not.toHaveBeenCalled();
    expect(h.handlers.size).toBe(0);
  });

  it('refetches on feed.changed only, throttled', async () => {
    vi.useFakeTimers();
    h.feed.mockResolvedValue([msg()]);
    renderHook(() => useFeed('ws1', null, true));
    await act(async () => { await Promise.resolve(); });
    expect(h.feed).toHaveBeenCalledTimes(1);
    act(() => {
      for (const f of h.handlers) { f({ type: 'feed.changed' }); f({ type: 'feed.changed' }); f({ type: 'task.created' }); }
    });
    await act(async () => { vi.advanceTimersByTime(FEED_THROTTLE_MS); await Promise.resolve(); });
    expect(h.feed).toHaveBeenCalledTimes(2);
  });

  it('an agent\'s answer to you (message.queued) refetches too, so a station card shows "claude-1 → you: …"', async () => {
    vi.useFakeTimers();
    h.feed.mockResolvedValue([msg()]);
    const { result } = renderHook(() => useFeed('ws1', 'claude-1@app', true));
    await act(async () => { await Promise.resolve(); });
    h.feed.mockResolvedValue([msg({ id: 'r1', from: { agentId: 'claude-1@app' }, to: 'human', kind: 'reply', body: 'Yes, all 40 pass.' }), msg()]);
    act(() => { for (const f of h.handlers) f({ type: 'message.queued' }); });
    await act(async () => { vi.advanceTimersByTime(FEED_THROTTLE_MS); await Promise.resolve(); await Promise.resolve(); });
    expect(h.feed).toHaveBeenCalledTimes(2);
    expect(result.current[0]).toEqual(expect.objectContaining({ from: 'claude-1@app', to: 'human', body: 'Yes, all 40 pass.' }));
  });
});
