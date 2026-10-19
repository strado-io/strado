import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM module without types
import { Cdp } from '../../hooks/mcp/preview.mjs';

/** A CDP endpoint that accepts the connection and never answers. */
class SilentSocket {
  static last: SilentSocket | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { SilentSocket.last = this; queueMicrotask(() => this.onopen?.()); }
  send(data: string) { this.sent.push(data); }
  close() { this.onclose?.(); }
}

const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;
beforeEach(() => { (globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket; vi.useFakeTimers(); });
afterEach(() => { (globalThis as { WebSocket?: unknown }).WebSocket = realWs; vi.useRealTimers(); });

describe('Cdp', () => {
  it('rejects a call the target never answers once its timeout passes, and forgets it', async () => {
    const cdp = new Cdp('ws://x', { timeoutMs: 1000 });
    await cdp.connect();
    const call = cdp.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true });
    const settled = expect(call).rejects.toThrow(/Runtime\.evaluate timed out after 1 s/);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(cdp.pending.size).toBe(0);
  });

  it('rejects every pending call when the socket closes', async () => {
    const cdp = new Cdp('ws://x', { timeoutMs: 60_000 });
    await cdp.connect();
    const a = cdp.send('Page.reload');
    const b = cdp.send('Network.enable');
    SilentSocket.last!.close();
    await expect(a).rejects.toThrow(/closed/);
    await expect(b).rejects.toThrow(/closed/);
    expect(cdp.pending.size).toBe(0);
  });

  it('a send after the socket closed rejects at once instead of hanging', async () => {
    const cdp = new Cdp('ws://x');
    await cdp.connect();
    SilentSocket.last!.close();
    await expect(cdp.send('Page.reload')).rejects.toThrow(/closed/);
  });

  it('defaults to a 30 s per-call timeout', async () => {
    const cdp = new Cdp('ws://x');
    await cdp.connect();
    const call = cdp.send('Page.navigate', { url: 'http://x' });
    const settled = expect(call).rejects.toThrow(/timed out after 30 s/);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });
});
