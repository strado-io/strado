// The desktop half of port forwarding: a loopback TCP listener here, one relay
// WebSocket per accepted connection, raw bytes in between.
//
// One channel per TCP connection, not per request — that's what lets HTTP
// keep-alive survive the tunnel, which is the first mitigation the design names
// for the relay hairpin (median 64 ms to runner-dev via Mumbai).
//
// Runs in its own process (see forwardMain.ts). The local server is deliberately
// NOT the listener: it's the process that enumerates every worktree, and pushing
// dev-server asset traffic through it rebuilds the exact hazard that made
// terminal bytes go direct.
import net from 'node:net';
import { TCP_FORWARD_PATH, TCP_PORT_PARAM } from '@strado/relay/protocol';
import { WebSocket } from 'ws';

export type ForwardCredential = {
  ticket: string;
  /** Origin of the runner through the relay, e.g. https://runner-dev.r.strado.io */
  runnerOrigin: string;
};

export type ForwardListenerOptions = {
  /** Port to reach on the runner's loopback. */
  remotePort: number;
  /** 0 (default) allocates a free port. */
  localPort?: number;
  /**
   * Called per connection. Tickets are reusable within their TTL, so this is
   * expected to hand back a cached one and only re-mint near expiry.
   *
   * Returns the origin alongside the ticket rather than taking it once at
   * construction: the two come from the same response, and a re-mint that
   * changed the origin would otherwise leave every later connection dialing a
   * stale host with a fresh credential.
   */
  getCredential: () => Promise<ForwardCredential>;
  /** No connections for this long → onIdle. 0 disables. */
  idleMs?: number;
  onIdle?: () => void;
  log?: (line: string) => void;
  /** Test seam: swap in a fake socket implementation. */
  wsFactory?: (url: string) => WebSocket;
};

export type ForwardListener = {
  localPort: number;
  /** The interface actually bound. Must always be loopback — asserted in tests. */
  bindHost: string;
  /** Connections currently piping, for idle accounting and status. */
  active: () => number;
  close: () => Promise<void>;
};

/** Silence long enough to drop a forward, unless the caller says otherwise. */
export const DEFAULT_IDLE_MS = 10 * 60_000;

export function forwardChannelUrl(runnerOrigin: string, remotePort: number, ticket: string): string {
  const url = new URL(TCP_FORWARD_PATH, runnerOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.searchParams.set(TCP_PORT_PARAM, String(remotePort));
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

export async function startForwardListener(opts: ForwardListenerOptions): Promise<ForwardListener> {
  const log = opts.log ?? (() => {});
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const sockets = new Set<net.Socket>();
  let closing = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (!idleMs || closing || sockets.size > 0) return;
    idleTimer = setTimeout(() => {
      if (!closing && sockets.size === 0) {
        log(`idle for ${Math.round(idleMs / 1000)}s — closing forward`);
        opts.onIdle?.();
      }
    }, idleMs);
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    socket.setNoDelay(true);
    void pipe(socket);
  });

  async function pipe(socket: net.Socket): Promise<void> {
    // Bytes the client sent before the channel was authorized. A browser writes
    // its request line the instant the socket opens, so this is the normal case,
    // not an edge one.
    const pending: Buffer[] = [];
    let ws: WebSocket | null = null;
    let done = false;

    const finish = (why?: string) => {
      if (done) return;
      done = true;
      sockets.delete(socket);
      if (why) log(why);
      socket.destroy();
      // Closing with 1000 tells the relay this was orderly; the runner then
      // sends a plain FIN to the dev server rather than a reset.
      try {
        ws?.close(1000);
      } catch {
        /* already closed */
      }
      armIdle();
    };

    socket.on('data', (chunk: Buffer) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
      else pending.push(chunk);
    });
    socket.on('end', () => finish());
    socket.on('error', () => finish());
    socket.on('close', () => finish());

    let credential: ForwardCredential;
    try {
      credential = await opts.getCredential();
    } catch (err) {
      finish(`could not get a socket ticket: ${(err as Error).message}`);
      return;
    }
    if (done) return;

    const url = forwardChannelUrl(credential.runnerOrigin, opts.remotePort, credential.ticket);
    ws = opts.wsFactory ? opts.wsFactory(url) : new WebSocket(url);

    ws.on('open', () => {
      for (const chunk of pending) ws!.send(chunk, { binary: true });
      pending.length = 0;
    });
    ws.on('message', (data) => {
      if (!socket.destroyed) socket.write(data as Buffer);
    });
    ws.on('close', (code, reason) => {
      // 1011 with a reason is the runner refusing or unable to reach the port.
      // Surfacing it beats a browser showing an empty response with no clue.
      const why = String(reason ?? '');
      finish(code === 1011 && why ? `channel closed by the runner: ${why}` : undefined);
    });
    ws.on('error', (err) => finish(`channel error: ${(err as Error).message}`));
  }

  // 127.0.0.1 only, never 0.0.0.0: binding the wildcard would put someone
  // else's dev server on your local network.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.localPort ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const bound = server.address() as net.AddressInfo;
  const localPort = bound.port;
  log(`listening on ${bound.address}:${localPort} → runner:${opts.remotePort}`);
  armIdle();

  return {
    localPort,
    bindHost: bound.address,
    active: () => sockets.size,
    close: async () => {
      closing = true;
      if (idleTimer) clearTimeout(idleTimer);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
