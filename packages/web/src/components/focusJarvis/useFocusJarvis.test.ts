import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChatEntry, JarvisMeta } from '../../types';

const log = vi.fn();
const send = vi.fn();
const stop = vi.fn();
const approve = vi.fn();
vi.mock('../../api', () => ({
  api: {
    focusJarvis: {
      log: (...a: unknown[]) => log(...a),
      send: (...a: unknown[]) => send(...a),
      stop: (...a: unknown[]) => stop(...a),
      approve: (...a: unknown[]) => approve(...a),
      streamUrl: (ws: string, id: string) => `/api/w/${ws}/focuses/${id}/jarvis/events`,
    },
  },
}));
vi.mock('../../lib/uiControl', () => ({ uiClientId: () => 'win-1' }));

import { useFocusJarvis, upsertEntry } from './useFocusJarvis';

type Listener = (e: MessageEvent) => void;
class FakeSource {
  static last: FakeSource | null = null;
  static count = 0;
  listeners = new Map<string, Listener>();
  closed = false;
  readyState = 0;
  constructor(public url: string) { FakeSource.last = this; FakeSource.count++; }
  /** The server went away and the browser gave up on this source. */
  die() { this.readyState = 2; this.listeners.get('error')?.({} as MessageEvent); }
  addEventListener(name: string, fn: Listener) { this.listeners.set(name, fn); }
  removeEventListener() {}
  close() { this.closed = true; }
  emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent); }
}

const meta: JarvisMeta = { focusId: 'f1', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 0, running: false };
const user = (id: string, text: string): ChatEntry => ({ id, at: '2026-10-26T10:00:00Z', type: 'user', text, windowId: 'win-1' });
const reply = (id: string, text: string, done = false): ChatEntry => ({ id, at: '2026-10-26T10:00:01Z', type: 'jarvis', turnId: 't1', text, done });

let origES: unknown;
beforeEach(() => {
  origES = (globalThis as any).EventSource;
  (globalThis as any).EventSource = FakeSource;
  log.mockReset(); send.mockReset(); stop.mockReset(); approve.mockReset();
  log.mockResolvedValue({ entries: [user('e1', 'hi')], meta });
});
afterEach(() => { (globalThis as any).EventSource = origES; });

describe('upsertEntry', () => {
  it('appends a new entry and replaces one with the same id', () => {
    const a = upsertEntry([], reply('e2', 'Hel'));
    expect(a).toHaveLength(1);
    const b = upsertEntry(a, reply('e2', 'Hello', true));
    expect(b).toEqual([reply('e2', 'Hello', true)]);
  });
});

describe('useFocusJarvis', () => {
  it('loads the log, then streams update one entry', async () => {
    const { result } = renderHook(() => useFocusJarvis('ws1', 'f1', () => ({})));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(FakeSource.last!.url).toBe('/api/w/ws1/focuses/f1/jarvis/events');
    act(() => FakeSource.last!.emit('entry', reply('e2', 'Hel')));
    act(() => FakeSource.last!.emit('entry', reply('e2', 'Hello', true)));
    expect(result.current.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(result.current.entries[1]).toMatchObject({ text: 'Hello', done: true });
    act(() => FakeSource.last!.emit('meta', { ...meta, running: true }));
    expect(result.current.meta?.running).toBe(true);
  });

  it('sends with this window and the context', async () => {
    send.mockResolvedValue(user('e3', 'open claude'));
    const { result } = renderHook(() => useFocusJarvis('ws1', 'f1', () => ({ focus: 'x' })));
    await waitFor(() => expect(result.current.meta).not.toBeNull());
    await act(() => result.current.send('open claude'));
    expect(send).toHaveBeenCalledWith('ws1', 'f1', { text: 'open claude', windowId: 'win-1', context: { focus: 'x' } });
    expect(result.current.entries.map((e) => e.id)).toContain('e3');
  });

  it('approves an entry with this window', async () => {
    approve.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFocusJarvis('ws1', 'f1', () => ({})));
    await waitFor(() => expect(result.current.meta).not.toBeNull());
    await act(() => result.current.approve('e9', false));
    expect(approve).toHaveBeenCalledWith('ws1', 'f1', 'e9', { approve: false, windowId: 'win-1', context: {} });
  });

  it('closes the stream when the Focus changes', async () => {
    const { rerender } = renderHook(({ id }) => useFocusJarvis('ws1', id, () => ({})), { initialProps: { id: 'f1' } });
    const first = FakeSource.last!;
    rerender({ id: 'f2' });
    expect(first.closed).toBe(true);
    expect(FakeSource.last!.url).toContain('/focuses/f2/');
  });

  it('does nothing without a Focus', () => {
    FakeSource.last = null;
    const { result } = renderHook(() => useFocusJarvis('ws1', null, () => ({})));
    expect(FakeSource.last).toBeNull();
    expect(result.current.entries).toEqual([]);
  });

  describe('a dead stream comes back', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

    it('closed for good (a server restart): reopened with backoff, and the latest page reloaded', async () => {
      renderHook(() => useFocusJarvis('ws1', 'f1', () => ({})));
      await flush();
      const first = FakeSource.last!;
      const loads = log.mock.calls.length;
      act(() => first.die());
      expect(first.closed).toBe(true);
      expect(FakeSource.last).toBe(first); // backoff: not yet
      await act(async () => { vi.advanceTimersByTime(1_000); });
      const second = FakeSource.last!;
      expect(second).not.toBe(first);
      // It dies again before opening: the wait doubles.
      act(() => second.die());
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(FakeSource.last).toBe(second);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      const third = FakeSource.last!;
      expect(third).not.toBe(second);
      log.mockResolvedValue({ entries: [user('e1', 'hi'), reply('e2', 'missed while down', true)], meta });
      act(() => third.listeners.get('open')?.({} as MessageEvent));
      await flush();
      expect(log.mock.calls.length).toBeGreaterThan(loads);
    });

    it('open but silent past 30 s after heartbeats: reopened and reloaded', async () => {
      const { result } = renderHook(() => useFocusJarvis('ws1', 'f1', () => ({})));
      await flush();
      const first = FakeSource.last!;
      act(() => first.emit('heartbeat', {}));
      await act(async () => { vi.advanceTimersByTime(20_000); });
      expect(FakeSource.last).toBe(first); // quiet, not dead yet
      act(() => first.emit('heartbeat', {}));
      await act(async () => { vi.advanceTimersByTime(36_000); });
      expect(first.closed).toBe(true);
      const second = FakeSource.last!;
      expect(second).not.toBe(first);
      log.mockResolvedValue({ entries: [user('e1', 'hi'), reply('e2', 'after the restart', true)], meta });
      act(() => second.listeners.get('open')?.({} as MessageEvent));
      await flush();
      expect(result.current.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
    });

    it('a server that sends no named heartbeat is never judged silent', async () => {
      renderHook(() => useFocusJarvis('ws1', 'f1', () => ({})));
      await flush();
      const first = FakeSource.last!;
      await act(async () => { vi.advanceTimersByTime(120_000); });
      expect(FakeSource.last).toBe(first);
      expect(first.closed).toBe(false);
    });
  });

  it('send and approve re-fetch the latest page (the stream may be down)', async () => {
    send.mockResolvedValue(user('e3', 'x'));
    approve.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFocusJarvis('ws1', 'f1', () => ({})));
    await waitFor(() => expect(result.current.meta).not.toBeNull());
    const before = log.mock.calls.length;
    await act(() => result.current.send('x'));
    await act(() => result.current.approve('a1', true));
    expect(log.mock.calls.length).toBe(before + 2);
  });
});
