import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChatEntry } from '../../types';

const log = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: { focusJarvis: { log } } }));

import { markSeen, newestReply, useFocusJarvisBadges } from './badges';

const at = '2026-10-26T10:00:00Z';
const reply = (id: string, done = true): ChatEntry => ({ id, at, type: 'jarvis', turnId: 't', text: 'x', done });
const meta = (pendingApprovals: number) => ({ focusId: 'f', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals, running: false });
const focus = (id: string) => ({ id, name: id, members: [], createdAt: 't', lastActiveAt: 't' });

beforeEach(() => {
  sessionStorage.clear();
  log.mockReset();
  log.mockImplementation(async (_ws: string, id: string) => (id === 'f2'
    ? { entries: [reply('r1'), { id: 'u', at, type: 'user', text: 'q', windowId: 'w' }, reply('r2')], meta: meta(2) }
    : { entries: [], meta: meta(0) }));
});
afterEach(() => { vi.useRealTimers(); });

describe('newestReply', () => {
  it('is the last finished Jarvis reply', () => {
    expect(newestReply([reply('a'), reply('b'), reply('c', false)])).toBe('b');
    expect(newestReply([])).toBeNull();
  });
});

describe('useFocusJarvisBadges', () => {
  it('fetches each Focus but the active one: approvals waiting, and a reply not seen in this window', async () => {
    const { result } = renderHook(() => useFocusJarvisBadges('ws', [focus('f1'), focus('f2'), focus('f3')], 'f1', 0));
    await waitFor(() => expect(result.current.get('f2')).toEqual({ pendingApprovals: 2, unread: true }));
    expect(result.current.get('f3')).toEqual({ pendingApprovals: 0, unread: false });
    expect(log.mock.calls.map((c) => c[1]).sort()).toEqual(['f2', 'f3']);
  });

  it('a reply seen in this window is not unread', async () => {
    markSeen('f2', 'r2');
    const { result } = renderHook(() => useFocusJarvisBadges('ws', [focus('f1'), focus('f2')], 'f1', 0));
    await waitFor(() => expect(result.current.get('f2')).toEqual({ pendingApprovals: 2, unread: false }));
  });

  it('refreshes on a live event, at most every 10 s, and when the window comes back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { rerender } = renderHook(({ pulse }) => useFocusJarvisBadges('ws', [focus('f1'), focus('f2')], 'f1', pulse), { initialProps: { pulse: 0 } });
    expect(log).toHaveBeenCalledTimes(1);
    rerender({ pulse: 1 });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(log).toHaveBeenCalledTimes(1); // throttled
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(log).toHaveBeenCalledTimes(2);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(log).toHaveBeenCalledTimes(3);
  });
});
