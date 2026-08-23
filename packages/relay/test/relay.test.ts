import http from 'node:http';
import net from 'node:net';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TunnelClient } from '../src/client.js';
import { buildRelayApp, staticAuth, type TunnelManager } from '../src/server.js';

const RUNNER_TOKEN = 'test-runner-token';
const ACCESS_KEY = 'k'.repeat(32);
const DOMAIN = 'relay.test';
const HOST_HEADER = `r1.${DOMAIN}`;

let local: FastifyInstance;
let localPort = 0;
let relayApp: FastifyInstance;
let tunnels: TunnelManager;
let relayPort = 0;
let client: TunnelClient;
let cookie = '';

// Stands in for a dev server on the runner's loopback, plus a raw byte echo for
// proving the channel is byte-transparent. Only ports in `allowedPorts` pass the
// runner's gate.
let devServer: http.Server;
let devPort = 0;
let echoServer: net.Server;
let echoPort = 0;
const allowedPorts = new Set<number>();

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function req(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: relayPort, path, method: opts.method ?? 'GET', headers: { host: HOST_HEADER, ...opts.headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += String(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function startClient(): Promise<TunnelClient> {
  let connected = false;
  const c = new TunnelClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    runnerId: 'r1',
    token: RUNNER_TOKEN,
    accessKey: ACCESS_KEY,
    localPort,
    isPortAllowed: (p) => allowedPorts.has(p),
    log: () => {},
    onStatusChange: (s) => {
      connected = s === 'connected';
    },
  });
  c.start();
  await waitFor(() => connected);
  return c;
}

beforeAll(async () => {
  // Fake local strado server: JSON API, SSE stream, WS echo, SPA root.
  // bodyLimit mirrors the real runner: its worktree upload route allows 15MB, so
  // a fixture on Fastify's 1MB default would hide whether the RELAY hop is the
  // one rejecting a large body.
  local = Fastify({ logger: false, bodyLimit: 15 * 1024 * 1024 });
  await local.register(fastifyWebsocket);
  local.get('/', async (_req, reply) => reply.type('text/html').send('<html>spa</html>'));
  local.get('/api/hello', async () => ({ msg: 'hi' }));
  // Reports the URL the RUNNER actually sees, so a test can prove relay-only
  // credentials never make it this far.
  local.get('/api/seen', async (req) => ({ url: req.raw.url }));
  local.post('/api/echo', async (req) => ({ got: req.body }));
  local.get('/events/worktrees', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    reply.raw.write('event: snapshot\ndata: {"n":1}\n\n');
    reply.raw.write('event: update\ndata: {"n":2}\n\n');
    const beat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 200);
    req.raw.on('close', () => clearInterval(beat));
  });
  await local.register(async (scoped) => {
    scoped.get('/ws/terminal', { websocket: true }, (connection, req) => {
      const socket = connection.socket as WebSocket;
      const q = (req.query as Record<string, string>).session ?? '';
      socket.send(`welcome session=${q}`);
      socket.on('message', (data: Buffer, isBinary: boolean) => socket.send(data, { binary: isBinary }));
    });
  });
  await local.listen({ host: '127.0.0.1', port: 0 });
  localPort = (local.server.address() as { port: number }).port;

  // A real HTTP server, so a forwarded channel is exercised the way a browser
  // would: keep-alive, its own framing, no relay parsing involved.
  devServer = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'text/plain' });
    rs.end(`dev:${rq.url}`);
  });
  devServer.keepAliveTimeout = 5_000;
  await new Promise<void>((r) => devServer.listen(0, '127.0.0.1', () => r()));
  devPort = (devServer.address() as { port: number }).port;

  echoServer = net.createServer((sock) => sock.pipe(sock));
  await new Promise<void>((r) => echoServer.listen(0, '127.0.0.1', () => r()));
  echoPort = (echoServer.address() as { port: number }).port;
  allowedPorts.add(devPort);
  allowedPorts.add(echoPort);

  const built = buildRelayApp({ domain: DOMAIN, auth: staticAuth(RUNNER_TOKEN), cookieSecret: 'cookie-secret', log: () => {} });
  relayApp = built.app;
  tunnels = built.tunnels;
  await relayApp.listen({ host: '127.0.0.1', port: 0 });
  relayPort = (relayApp.server.address() as { port: number }).port;

  client = await startClient();
});

afterAll(async () => {
  client.stop();
  await relayApp.close();
  await local.close();
  await new Promise<void>((r) => devServer.close(() => r()));
  await new Promise<void>((r) => echoServer.close(() => r()));
});

describe('relay control endpoints', () => {
  it('healthz reports registered tunnels on the bare host', async () => {
    const res = await req('/healthz', { headers: { host: DOMAIN } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, tunnels: 1 });
  });

  it('on-demand TLS ask allows registered runners only', async () => {
    const ok = await req(`/__relay_ask?domain=r1.${DOMAIN}`, { headers: { host: DOMAIN } });
    expect(ok.status).toBe(200);
    const nope = await req(`/__relay_ask?domain=ghost.${DOMAIN}`, { headers: { host: DOMAIN } });
    expect(nope.status).toBe(403);
    const outside = await req('/__relay_ask?domain=evil.example.com', { headers: { host: DOMAIN } });
    expect(outside.status).toBe(403);
  });
});

describe('client access gate', () => {
  it('rejects proxied requests without the cookie (401, retryable)', async () => {
    const res = await req('/api/hello');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong access key with 403 (permanent)', async () => {
    const res = await req('/__strado_connect?key=wrong');
    expect(res.status).toBe(403);
  });

  it('sets the signed cookie for the right key and redirects into the app', async () => {
    const res = await req(`/__strado_connect?key=${ACCESS_KEY}`);
    expect(res.status).toBe(302);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('strado_relay=');
    expect(setCookie).toContain('HttpOnly');
    cookie = setCookie.split(';')[0];
  });
});

describe('HTTP proxying', () => {
  it('proxies JSON GET', async () => {
    const res = await req('/api/hello', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ msg: 'hi' });
  });

  it('proxies a body larger than Fastify\'s 1MB default', async () => {
    // The relay must never be stricter than what it proxies: the worktree upload
    // route allows 15MB and was failing with a relay-generated 413.
    const big = 'x'.repeat(3 * 1024 * 1024);
    const res = await req('/api/echo', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ big }),
    });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { got: { big: string } }).got.big.length).toBe(big.length);
  });

  it('proxies POST bodies through untouched', async () => {
    const res = await req('/api/echo', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ got: { a: 1 } });
  });

  it('serves the SPA root', async () => {
    const res = await req('/', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.body).toContain('spa');
  });

  it('streams SSE incrementally (does not buffer until end)', async () => {
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: relayPort, path: '/events/worktrees', headers: { host: HOST_HEADER, cookie } },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          res.on('data', (c) => {
            chunks.push(String(c));
            // Both events arrived while the stream is still OPEN — that is
            // the streaming guarantee (a buffering proxy would never get here).
            if (chunks.join('').includes('"n":2')) {
              r.destroy();
              resolve();
            }
          });
          res.on('error', () => {});
        },
      );
      r.on('error', reject);
      r.end();
      setTimeout(() => reject(new Error('SSE timeout')), 5000);
    });
    const all = chunks.join('');
    expect(all).toContain('event: snapshot');
    expect(all).toContain('event: update');
  });

  it('404s unknown paths from the local server, proxied', async () => {
    const res = await req('/definitely-not-a-route', { headers: { cookie } });
    expect(res.status).toBe(404);
  });
});

describe('WebSocket proxying', () => {
  it('bridges a terminal-style WS end to end', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/terminal?session=1`, {
      headers: { host: HOST_HEADER, cookie },
    });
    const received: string[] = [];
    ws.on('message', (data) => received.push(String(data)));
    await waitFor(() => received.length >= 1);
    expect(received[0]).toBe('welcome session=1');
    ws.send('typed input');
    await waitFor(() => received.length >= 2);
    expect(received[1]).toBe('typed input');
    ws.close();
  });

  it('rejects WS without the cookie', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/terminal`, {
      headers: { host: HOST_HEADER },
    });
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => {});
    });
    expect(code).toBe(1008);
  });
});

// The desktop window connects from its own origin, where the SameSite=Lax
// access cookie is never sent. A ?ticket= credential is the only way in.
describe('socket tickets (cross-origin clients)', () => {
  it('authorizes a WS with a ticket and no cookie, keeping the rest of the query', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/terminal?session=7&ticket=${ACCESS_KEY}`, {
      headers: { host: HOST_HEADER },
    });
    const received: string[] = [];
    ws.on('message', (data) => received.push(String(data)));
    ws.on('error', () => {});
    await waitFor(() => received.length >= 1);
    expect(received[0]).toBe('welcome session=7');
    ws.close();
  });

  it('does not lose frames sent before ticket verification finishes', async () => {
    // The handshake completes before the relay has authorized, so the client
    // can (and xterm does) send immediately on open.
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/terminal?session=8&ticket=${ACCESS_KEY}`, {
      headers: { host: HOST_HEADER },
    });
    const received: string[] = [];
    ws.on('message', (data) => received.push(String(data)));
    ws.on('error', () => {});
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send('early keystroke');
    await waitFor(() => received.includes('early keystroke'));
    ws.close();
  });

  it('closes 1008 for a bad ticket — a credential problem, not an offline runner', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/terminal?ticket=not-the-key`, {
      headers: { host: HOST_HEADER },
    });
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => {});
    });
    expect(code).toBe(1008);
  });

  it('strips the ticket before the query reaches the runner', async () => {
    const res = await req(`/api/seen?a=1&ticket=${ACCESS_KEY}&b=2`);
    expect(res.status).toBe(200);
    const { url } = JSON.parse(res.body) as { url: string };
    expect(url).toBe('/api/seen?a=1&b=2');
    expect(url).not.toContain('ticket');
  });

  it('authorizes HTTP with a ticket, so the control plane needs no cookie jar', async () => {
    const res = await req(`/api/hello?ticket=${ACCESS_KEY}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ msg: 'hi' });
  });
});

// A dev server on the runner reachable from the desktop. Raw TCP because the
// far end isn't ours — parsing it could only corrupt it.
describe('TCP port forwarding', () => {
  interface Chan {
    ws: WebSocket;
    chunks: Buffer[];
    body: () => string;
    closed: Promise<{ code: number; reason: string }>;
  }

  async function openChannel(query: string): Promise<Chan> {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/__strado_tcp?${query}`, {
      headers: { host: HOST_HEADER },
    });
    const chunks: Buffer[] = [];
    ws.on('message', (data) => chunks.push(data as Buffer));
    ws.on('error', () => {});
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('close', () => reject(new Error('closed before open')));
    }).catch(() => {});
    return { ws, chunks, body: () => Buffer.concat(chunks).toString('utf8'), closed };
  }

  it('carries a real HTTP exchange to a loopback port on the runner', async () => {
    const chan = await openChannel(`port=${devPort}&ticket=${ACCESS_KEY}`);
    // Written immediately on open — a browser does exactly this, so these bytes
    // land before the relay has finished verifying the ticket.
    chan.ws.send(Buffer.from('GET /app HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n'));
    await waitFor(() => chan.body().includes('dev:/app'));
    expect(chan.body()).toContain('200 OK');
    chan.ws.close();
  });

  it('reuses one channel for a second request (keep-alive survives the tunnel)', async () => {
    // The doc's first latency mitigation: one TCP channel per connection, not
    // per request. If the channel were torn down per request this would hang.
    const chan = await openChannel(`port=${devPort}&ticket=${ACCESS_KEY}`);
    chan.ws.send(Buffer.from('GET /one HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n'));
    await waitFor(() => chan.body().includes('dev:/one'));
    chan.ws.send(Buffer.from('GET /two HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n'));
    await waitFor(() => chan.body().includes('dev:/two'));
    chan.ws.close();
  });

  it('is byte-transparent — non-UTF8 bytes survive the round trip', async () => {
    // The ws:frame path would decode this as UTF-8 and mangle it. Asset bytes
    // (images, wasm, gzip) are binary far more often than not.
    const chan = await openChannel(`port=${echoPort}&ticket=${ACCESS_KEY}`);
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x1f, 0x89, 0x50, 0x4e, 0x47]);
    chan.ws.send(payload);
    await waitFor(() => Buffer.concat(chan.chunks).length >= payload.length);
    expect(Buffer.concat(chan.chunks).equals(payload)).toBe(true);
    chan.ws.close();
  });

  it('refuses a port the runner does not know about', async () => {
    // Defense in depth: a ticket holder already has a shell here, but a bug or
    // a stolen ticket must not become "scan the runner's loopback".
    // A low fixed port: devPort+N would drift past 65535 (macOS hands out
    // ephemeral ports near the top) and get refused by the range check instead,
    // which would pass this test for entirely the wrong reason.
    const stranger = 2;
    expect(allowedPorts.has(stranger)).toBe(false);
    const chan = await openChannel(`port=${stranger}&ticket=${ACCESS_KEY}`);
    const { code, reason } = await chan.closed;
    // 1011, not 1008: the credential was fine, so a client must not go re-mint
    // a ticket and retry.
    expect(code).toBe(1011);
    expect(reason).toContain('not forwardable');
  });

  it('reports an allowed port with nothing listening as a refusal, not an empty page', async () => {
    const dead = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    allowedPorts.add(dead);
    try {
      const chan = await openChannel(`port=${dead}&ticket=${ACCESS_KEY}`);
      const { code, reason } = await chan.closed;
      expect(code).toBe(1011);
      expect(reason).toContain('cannot reach');
    } finally {
      allowedPorts.delete(dead);
    }
  });

  it('rejects a malformed port before any runner round trip', async () => {
    for (const bad of ['port=0', 'port=70000', 'port=abc', '']) {
      const chan = await openChannel(bad ? `${bad}&ticket=${ACCESS_KEY}` : `ticket=${ACCESS_KEY}`);
      const { code } = await chan.closed;
      expect(code).toBe(1008);
    }
  });

  it('needs a credential like every other channel', async () => {
    const chan = await openChannel(`port=${devPort}`);
    const { code } = await chan.closed;
    expect(code).toBe(1008);
  });

  it('does not let the runner push TCP bytes into a terminal channel', async () => {
    // Channel ids share one namespace across kinds. A tcp:data frame aimed at a
    // ws channel must be dropped, not delivered as binary to an xterm.
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/terminal?session=9&ticket=${ACCESS_KEY}`, {
      headers: { host: HOST_HEADER },
    });
    const received: Buffer[] = [];
    ws.on('message', (d) => received.push(d as Buffer));
    ws.on('error', () => {});
    await waitFor(() => received.length >= 1);
    const ids = [...(tunnels as unknown as { tunnels: Map<string, { channels: Map<string, unknown> }> }).tunnels.values()]
      .flatMap((t) => [...t.channels.keys()]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      tunnels.handleRunnerMessage('r1', JSON.stringify({ type: 'tcp:data', id, data: Buffer.from('X').toString('base64') }));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(received).toString()).not.toContain('X');
    ws.close();
  });
});

describe('lifecycle', () => {
  it('surviving a tunnel-client restart: requests fail closed, then recover', async () => {
    client.stop();
    await waitFor(() => tunnels.list().length === 0);
    const down = await req('/api/hello', { headers: { cookie } });
    expect([401, 503]).toContain(down.status);

    client = await startClient();
    // Cookie stays valid across restarts because the access key is stable.
    const up = await req('/api/hello', { headers: { cookie } });
    expect(up.status).toBe(200);
  });

  it('last-write-wins re-register replaces the old tunnel', async () => {
    const second = await startClient();
    // Old client got replaced; the new tunnel serves traffic.
    const res = await req('/api/hello', { headers: { cookie } });
    expect(res.status).toBe(200);
    // Stop the OLD client (its socket is already dead); traffic still works
    // because unregister ignores a stale socket.
    client.stop();
    await new Promise((r) => setTimeout(r, 100));
    const res2 = await req('/api/hello', { headers: { cookie } });
    expect(res2.status).toBe(200);
    client = second;
  });
});
