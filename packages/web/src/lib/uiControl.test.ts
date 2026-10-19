import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handlers = { onCommand: (c: { id: string; op: string; args: Record<string, unknown> }) => void; onReady: () => void };
const sub = vi.hoisted(() => ({ handlers: null as null | Handlers, calls: [] as unknown[][], unsub: vi.fn() }));
vi.mock('../eventStream', () => ({
  subscribeUi: (ws: string, client: string, h: Handlers) => { sub.calls.push([ws, client]); sub.handlers = h; return sub.unsub; },
}));
const apiMock = vi.hoisted(() => ({ reportState: vi.fn(), ack: vi.fn() }));
vi.mock('../api', () => ({ api: { ui: apiMock } }));

import { UI_STATE_HEARTBEAT_MS, startUiControl, uiClientId } from './uiControl';

const state = { focused: true, worktreePath: '/w/a', visible: [{ worktreePath: '/w/a', mode: 'claude' as const, sessionId: '1' }], layout: {} };
const flush = () => new Promise((r) => setTimeout(r, 0));
const ready = async () => { sub.handlers!.onReady(); await flush(); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  sub.handlers = null; sub.calls = []; sub.unsub.mockReset();
  apiMock.reportState.mockReset().mockResolvedValue(undefined);
  apiMock.ack.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('uiControl', () => {
  it('clientId is stable within a page load and matches the server pattern', () => {
    expect(uiClientId()).toBe(uiClientId());
    expect(uiClientId()).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });
  it('connects with workspace and client id; reports state on ui.ready', async () => {
    const stop = startUiControl({ wsId: 'ws1', getState: () => state, onCommand: vi.fn() });
    expect(sub.calls).toEqual([['ws1', uiClientId()]]);
    expect(apiMock.reportState).not.toHaveBeenCalled();
    await ready();
    expect(apiMock.reportState).toHaveBeenCalledWith('ws1', uiClientId(), state);
    stop();
    expect(sub.unsub).toHaveBeenCalled();
  });
  it('re-reports on heartbeat, focus, blur, visibilitychange and notify(); nothing after stop()', async () => {
    const ctl = startUiControl({ wsId: 'ws1', getState: () => state, onCommand: vi.fn() });
    await ready();
    apiMock.reportState.mockClear();
    vi.advanceTimersByTime(UI_STATE_HEARTBEAT_MS);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
    ctl.notify();
    await flush();
    expect(apiMock.reportState).toHaveBeenCalledTimes(5);
    ctl();
    vi.advanceTimersByTime(UI_STATE_HEARTBEAT_MS * 3);
    window.dispatchEvent(new Event('focus'));
    ctl.notify();
    await flush();
    expect(apiMock.reportState).toHaveBeenCalledTimes(5);
  });
  it('caps visible at 200', async () => {
    const many = { ...state, visible: Array.from({ length: 250 }, (_, i) => ({ worktreePath: '/w/a', mode: 'shell' as const, sessionId: String(i) })) };
    const ctl = startUiControl({ wsId: 'ws1', getState: () => many, onCommand: vi.fn() });
    await ready();
    expect(apiMock.reportState.mock.calls[0]![2].visible).toHaveLength(200);
    ctl();
  });
  it('an unknown client (NOT_FOUND) reconnects the stream', async () => {
    apiMock.reportState.mockRejectedValueOnce(Object.assign(new Error('no client'), { code: 'NOT_FOUND' }));
    const ctl = startUiControl({ wsId: 'ws1', getState: () => state, onCommand: vi.fn() });
    await ready(); await flush();
    expect(sub.calls).toHaveLength(2);
    expect(sub.unsub).toHaveBeenCalledTimes(1);
    ctl();
  });
  it('FORBIDDEN (window not served from loopback) turns app control off: no reconnect, no more reports', async () => {
    apiMock.reportState.mockRejectedValueOnce(Object.assign(new Error('only the local hub'), { code: 'FORBIDDEN' }));
    const ctl = startUiControl({ wsId: 'ws1', getState: () => state, onCommand: vi.fn() });
    await ready(); await flush();
    expect(sub.unsub).toHaveBeenCalledTimes(1);
    expect(sub.calls).toHaveLength(1);
    vi.advanceTimersByTime(UI_STATE_HEARTBEAT_MS * 2);
    window.dispatchEvent(new Event('focus'));
    ctl.notify();
    await flush();
    expect(apiMock.reportState).toHaveBeenCalledTimes(1);
    ctl();
  });
  it('reports nothing before the first ui.ready, so an early focus cannot 404 the handshake away', async () => {
    const ctl = startUiControl({ wsId: 'ws1', getState: () => state, onCommand: vi.fn() });
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(UI_STATE_HEARTBEAT_MS);
    ctl.notify();
    await flush();
    expect(apiMock.reportState).not.toHaveBeenCalled();
    await ready();
    expect(apiMock.reportState).toHaveBeenCalledTimes(1);
    ctl();
  });
  it('after a NOT_FOUND reconnect, waits for the new stream\'s ui.ready before reporting again', async () => {
    apiMock.reportState.mockRejectedValueOnce(Object.assign(new Error('no client'), { code: 'NOT_FOUND' }));
    const ctl = startUiControl({ wsId: 'ws1', getState: () => state, onCommand: vi.fn() });
    await ready(); await flush();
    expect(sub.calls).toHaveLength(2);
    ctl.notify();
    await flush();
    expect(apiMock.reportState).toHaveBeenCalledTimes(1);
    await ready();
    expect(apiMock.reportState).toHaveBeenCalledTimes(2);
    ctl();
  });
  it('a long handler error is cut to the server\'s 200-char reason limit', async () => {
    const ctl = startUiControl({ wsId: 'ws1', getState: () => state, onCommand: vi.fn().mockRejectedValue(new Error('x'.repeat(500))) });
    sub.handlers!.onCommand({ id: 'C9', op: 'place', args: {} });
    await flush();
    expect(apiMock.ack.mock.calls[0]![3].reason).toHaveLength(200);
    ctl();
  });
  it('acks a command with the handler result and the client id, then re-reports state', async () => {
    const onCommand = vi.fn().mockResolvedValue({ applied: true, result: { tabId: '2' } });
    const ctl = startUiControl({ wsId: 'ws1', getState: () => state, onCommand });
    await ready();
    apiMock.reportState.mockClear();
    sub.handlers!.onCommand({ id: 'C1', op: 'browser.open', args: { url: 'https://x' } });
    await flush(); await flush();
    expect(onCommand).toHaveBeenCalledWith({ id: 'C1', op: 'browser.open', args: { url: 'https://x' } });
    expect(apiMock.ack).toHaveBeenCalledWith('ws1', uiClientId(), 'C1', { applied: true, result: { tabId: '2' } });
    expect(apiMock.reportState).toHaveBeenCalledTimes(1);
    ctl();
  });
  it('a throwing handler acks applied:false with the message as reason', async () => {
    const ctl = startUiControl({ wsId: 'ws1', getState: () => state, onCommand: vi.fn().mockRejectedValue(new Error('boom')) });
    sub.handlers!.onCommand({ id: 'C2', op: 'place', args: {} });
    await flush();
    expect(apiMock.ack).toHaveBeenCalledWith('ws1', uiClientId(), 'C2', { applied: false, reason: 'boom' });
    ctl();
  });
});
