import http from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TunnelClient } from '../src/client.js';
import { CLOSE_BAD_VERSION } from '../src/protocol.js';

function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

describe('TunnelClient close handling', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function startFakeRelay(onConnection: (ws: import('ws').WebSocket, req: http.IncomingMessage) => void) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', onConnection);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          wss.close();
          server.close(() => r());
        }),
    );
    return port;
  }

  it('logs close code/reason and backs off 60s on 1008 (credential rejected)', async () => {
    const port = await startFakeRelay((ws) => {
      ws.close(1008, 'Unauthorized');
    });
    const logs: string[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const client = new TunnelClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      runnerId: 'r1',
      token: 'tok',
      accessKey: 'key',
      localPort: 7777,
      log: (l) => logs.push(l),
    });
    cleanups.push(() => client.stop());
    client.start();

    await waitFor(() => logs.some((l) => l.includes('credential rejected')));
    expect(logs.some((l) => l.includes('tunnel closed 1008 Unauthorized'))).toBe(true);
    expect(logs.some((l) => l.includes('credential rejected — re-pair or check revocation'))).toBe(true);
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 60_000)).toBe(true);
  });

  it('logs update hint and backs off 5 min on CLOSE_BAD_VERSION (4003)', async () => {
    const port = await startFakeRelay((ws) => {
      ws.close(CLOSE_BAD_VERSION, 'Unsupported protocol version');
    });
    const logs: string[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const client = new TunnelClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      runnerId: 'r1',
      token: 'tok',
      accessKey: 'key',
      localPort: 7777,
      log: (l) => logs.push(l),
    });
    cleanups.push(() => client.stop());
    client.start();

    await waitFor(() => logs.some((l) => l.includes('strado-runner update')));
    expect(logs.some((l) => l.includes('tunnel closed 4003 Unsupported protocol version'))).toBe(true);
    expect(logs.some((l) => l.includes('relay requires a newer runner — run strado-runner update'))).toBe(true);
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 5 * 60_000)).toBe(true);
  });
});
