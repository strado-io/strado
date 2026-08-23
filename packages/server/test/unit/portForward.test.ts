import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  forwardChannelUrl,
  startForwardListener,
  type ForwardListener,
} from '../../src/services/portForward.js';

// Stands in for the relay's /__strado_tcp endpoint: accepts a channel, and by
// default echoes bytes back the way the runner's dev server would.
type FakeRelay = {
  origin: string;
  urls: string[];
  sockets: WebSocket[];
  close: () => Promise<void>;
  /** Replaces the per-channel behaviour for subsequent connections. */
  onChannel: (fn: (ws: WebSocket) => void) => void;
};

async function fakeRelay(): Promise<FakeRelay> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const urls: string[] = [];
  const sockets: WebSocket[] = [];
  let handler: (ws: WebSocket) => void = (ws) => {
    ws.on('message', (data) => ws.send(data as Buffer, { binary: true }));
  };
  wss.on('connection', (ws, req) => {
    urls.push(req.url ?? '');
    sockets.push(ws);
    handler(ws);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as net.AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    urls,
    sockets,
    onChannel: (fn) => {
      handler = fn;
    },
    close: async () => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => resolve(s));
    s.on('error', reject);
  });
}

function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

let relay: FakeRelay | null = null;
let listener: ForwardListener | null = null;

afterEach(async () => {
  await listener?.close();
  await relay?.close();
  listener = null;
  relay = null;
});

describe('forwardChannelUrl', () => {
  it('upgrades the scheme and carries port + ticket', () => {
    const url = new URL(forwardChannelUrl('https://runner-dev.r.strado.io', 3000, 'tkt'));
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/__strado_tcp');
    expect(url.searchParams.get('port')).toBe('3000');
    expect(url.searchParams.get('ticket')).toBe('tkt');
  });

  it('uses ws: for a plain-http relay (local dev)', () => {
    expect(forwardChannelUrl('http://127.0.0.1:8790', 5173, 't')).toMatch(/^ws:\/\//);
  });
});

describe('startForwardListener', () => {
  it('binds loopback only', async () => {
    // 0.0.0.0 would put someone else's dev server on your local network.
    relay = await fakeRelay();
    listener = await startForwardListener({
      remotePort: 3000,
      getCredential: async () => ({ ticket: 't', runnerOrigin: relay!.origin }),
      idleMs: 0,
    });
    expect(listener.bindHost).toBe('127.0.0.1');
  });

  it('pipes bytes both ways over one channel per connection', async () => {
    relay = await fakeRelay();
    listener = await startForwardListener({
      remotePort: 3000,
      getCredential: async () => ({ ticket: 'tkt-1', runnerOrigin: relay!.origin }),
      idleMs: 0,
    });
    const socket = await connect(listener.localPort);
    const seen: Buffer[] = [];
    socket.on('data', (c) => seen.push(c));
    socket.write('GET / HTTP/1.1\r\n\r\n');
    await waitFor(() => Buffer.concat(seen).toString().includes('GET /'));

    // Second write on the SAME socket must reuse the same channel — that's what
    // makes HTTP keep-alive survive the relay hairpin.
    socket.write('second');
    await waitFor(() => Buffer.concat(seen).toString().includes('second'));
    expect(relay.urls.length).toBe(1);
    expect(relay.urls[0]).toContain('port=3000');
    expect(relay.urls[0]).toContain('ticket=tkt-1');
    socket.destroy();
  });

  it('opens one channel per TCP connection, not per listener', async () => {
    relay = await fakeRelay();
    listener = await startForwardListener({
      remotePort: 3000,
      getCredential: async () => ({ ticket: 't', runnerOrigin: relay!.origin }),
      idleMs: 0,
    });
    const a = await connect(listener.localPort);
    const b = await connect(listener.localPort);
    await waitFor(() => relay!.urls.length === 2);
    expect(listener.active()).toBe(2);
    a.destroy();
    b.destroy();
  });

  it('is byte-transparent', async () => {
    // Assets are binary far more often than not; a UTF-8 round trip would
    // silently corrupt every png and wasm file.
    relay = await fakeRelay();
    listener = await startForwardListener({
      remotePort: 3000,
      getCredential: async () => ({ ticket: 't', runnerOrigin: relay!.origin }),
      idleMs: 0,
    });
    const socket = await connect(listener.localPort);
    const seen: Buffer[] = [];
    socket.on('data', (c) => seen.push(c));
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x89, 0x50, 0x4e, 0x47]);
    socket.write(payload);
    await waitFor(() => Buffer.concat(seen).length >= payload.length);
    expect(Buffer.concat(seen).equals(payload)).toBe(true);
    socket.destroy();
  });

  it('closes the local socket when the runner refuses the port', async () => {
    // Otherwise the browser hangs on a request that is never going to be
    // answered, with nothing to explain why.
    relay = await fakeRelay();
    relay.onChannel((ws) => ws.close(1011, 'port 9999 is not forwardable on this runner'));
    const lines: string[] = [];
    listener = await startForwardListener({
      remotePort: 9999,
      getCredential: async () => ({ ticket: 't', runnerOrigin: relay!.origin }),
      idleMs: 0,
      log: (l) => lines.push(l),
    });
    const socket = await connect(listener.localPort);
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });
    socket.write('GET / HTTP/1.1\r\n\r\n');
    await waitFor(() => closed);
    await waitFor(() => lines.some((l) => l.includes('not forwardable')));
  });

  it('closes the local socket when no ticket can be minted', async () => {
    relay = await fakeRelay();
    const lines: string[] = [];
    listener = await startForwardListener({
      remotePort: 3000,
      getCredential: async () => {
        throw new Error('socket-ticket failed (503)');
      },
      idleMs: 0,
      log: (l) => lines.push(l),
    });
    const socket = await connect(listener.localPort);
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });
    socket.write('x');
    await waitFor(() => closed);
    expect(lines.some((l) => l.includes('503'))).toBe(true);
  });

  it('reports idle only once nothing is connected', async () => {
    // Forwards must not accumulate silently — but a browser tab holding a
    // keep-alive connection open is not idle.
    relay = await fakeRelay();
    let idle = 0;
    listener = await startForwardListener({
      remotePort: 3000,
      getCredential: async () => ({ ticket: 't', runnerOrigin: relay!.origin }),
      idleMs: 60,
      onIdle: () => {
        idle++;
      },
    });
    const socket = await connect(listener.localPort);
    await waitFor(() => listener!.active() === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(idle).toBe(0);

    socket.destroy();
    await waitFor(() => idle === 1);
  });

  it('close() stops listening and drops live connections', async () => {
    relay = await fakeRelay();
    const l = await startForwardListener({
      remotePort: 3000,
      getCredential: async () => ({ ticket: 't', runnerOrigin: relay!.origin }),
      idleMs: 0,
    });
    const socket = await connect(l.localPort);
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });
    await l.close();
    await waitFor(() => closed);
    await expect(connect(l.localPort)).rejects.toThrow();
  });
});
