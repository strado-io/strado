import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  CLOSE_BAD_VERSION,
  CLOSE_DRAIN,
  HTTP_HEAD_TIMEOUT_MS,
  MAX_PENDING_REQUESTS,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MISSED,
  PROTO_VERSION,
  TCP_FORWARD_PATH,
  TCP_PORT_PARAM,
  type HttpHeadMsg,
  type RelayToRunner,
  type WsFrameMsg,
  decodeWsData,
  encodeWsData,
  parseMsg,
  redactSecrets,
} from './protocol.js';

export interface RelayAuth {
  /** Validate a runner's registration credential (its runnerToken). */
  verifyRunner(runnerId: string, token: string): Promise<boolean>;
  /**
   * Authorize a browser's ?key= credential for this runner. Static mode
   * compares against the runner's hello accessKey; cloud mode exchanges a
   * one-time attach code against the API.
   */
  authorizeConnect(runnerId: string, credential: string, helloAccessKey: string): Promise<boolean>;
  /**
   * Authorize a `?ticket=` credential for this runner. Distinct from
   * authorizeConnect because tickets are reusable within a TTL: a browser
   * connecting DIRECTLY to the relay (rather than being served the runner's own
   * SPA) has no usable cookie — the access cookie is SameSite=Lax, so it is
   * never sent on a cross-site WebSocket handshake from the desktop's own
   * origin. Static mode accepts the hello accessKey.
   */
  authorizeSocket(runnerId: string, ticket: string, helloAccessKey: string): Promise<boolean>;
}

/** M1 behavior: one shared runner secret, connect key = the hello accessKey. */
export function staticAuth(runnerToken: string): RelayAuth {
  return {
    verifyRunner: async (_runnerId, token) => safeEqual(token, runnerToken),
    authorizeConnect: async (_runnerId, credential, helloAccessKey) => safeEqual(credential, helloAccessKey),
    authorizeSocket: async (_runnerId, ticket, helloAccessKey) => safeEqual(ticket, helloAccessKey),
  };
}

export interface RelayOptions {
  /** Suffix under which runners are addressed: <runnerId>.<domain>. */
  domain: string;
  auth: RelayAuth;
  /** HMAC key for the client access cookie. */
  cookieSecret: string;
  /** Presence heartbeat, called on register and periodically while alive. */
  onRunnerOnline?: (runnerId: string) => void;
  onRunnerOffline?: (runnerId: string) => void;
  log?: (line: string) => void;
}

/** Re-report presence at most this often per runner (pongs arrive every 30s). */
const ONLINE_REPORT_INTERVAL_MS = 60_000;

/** Ceiling on a proxied request body — above every downstream route's own limit. */
export const MAX_PROXY_BODY_BYTES = 20 * 1024 * 1024;

interface PendingHttp {
  onHead: (head: HttpHeadMsg) => void;
  onData: (chunk: Buffer) => void;
  onEnd: () => void;
  onError: (message: string) => void;
  headTimer: ReturnType<typeof setTimeout> | null;
  gotHead: boolean;
}

/**
 * A channel's kind decides which frames its bytes ride. Stored rather than
 * inferred so a buggy or hostile runner can't answer a terminal's ws:open with
 * tcp:data and push raw binary at an xterm — the ids share one namespace.
 */
type ChannelKind = 'ws' | 'tcp';

interface Channel {
  ws: WebSocket;
  kind: ChannelKind;
}

interface Tunnel {
  runnerId: string;
  accessKey: string;
  ws: WebSocket;
  pending: Map<string, PendingHttp>;
  channels: Map<string, Channel>;
  pingTimer: ReturnType<typeof setInterval> | null;
  missedPings: number;
  lastOnlineReportAt: number;
}

const COOKIE_NAME = 'strado_relay';

export class TunnelManager {
  private readonly tunnels = new Map<string, Tunnel>();
  private draining = false;
  constructor(
    private readonly log: (line: string) => void,
    private readonly presence: {
      online?: (runnerId: string) => void;
      offline?: (runnerId: string) => void;
    } = {},
  ) {}

  register(runnerId: string, accessKey: string, ws: WebSocket): boolean {
    if (this.draining) {
      ws.close(CLOSE_DRAIN, 'Relay draining');
      return false;
    }
    // Last-write-wins: a flaky runner must not get stuck behind its own
    // dead-but-undetected previous socket.
    const existing = this.tunnels.get(runnerId);
    if (existing) {
      this.log(`tunnel re-register: replacing socket for ${runnerId}`);
      this.dispose(existing, 'Replaced by new tunnel');
      this.tunnels.delete(runnerId);
    }
    const tunnel: Tunnel = {
      runnerId,
      accessKey,
      ws,
      pending: new Map(),
      channels: new Map(),
      pingTimer: null,
      missedPings: 0,
      lastOnlineReportAt: Date.now(),
    };
    this.tunnels.set(runnerId, tunnel);
    this.presence.online?.(runnerId);
    tunnel.pingTimer = setInterval(() => {
      tunnel.missedPings++;
      if (tunnel.missedPings >= PING_TIMEOUT_MISSED) {
        ws.close(1001, 'Ping timeout');
        return;
      }
      this.send(tunnel, { type: 'ping' });
    }, PING_INTERVAL_MS);
    this.log(`tunnel registered: ${runnerId}`);
    return true;
  }

  unregister(runnerId: string, ws?: WebSocket): void {
    const tunnel = this.tunnels.get(runnerId);
    if (!tunnel) return;
    // Only tear down if the closing socket is still the active one — the old
    // socket's close handler must not kill a fresh re-register.
    if (ws && tunnel.ws !== ws) return;
    this.dispose(tunnel, 'Tunnel disconnected');
    this.tunnels.delete(runnerId);
    this.presence.offline?.(runnerId);
    this.log(`tunnel unregistered: ${runnerId}`);
  }

  get(runnerId: string): { accessKey: string } | undefined {
    const t = this.tunnels.get(runnerId);
    return t ? { accessKey: t.accessKey } : undefined;
  }

  list(): string[] {
    return [...this.tunnels.keys()];
  }

  sendHttp(
    runnerId: string,
    req: { method: string; path: string; headers: Record<string, string>; body?: Buffer },
    sink: Omit<PendingHttp, 'headTimer' | 'gotHead'>,
  ): { id: string; abort: () => void } | null {
    const tunnel = this.tunnels.get(runnerId);
    if (!tunnel) return null;
    if (tunnel.pending.size >= MAX_PENDING_REQUESTS) {
      sink.onError('Runner overloaded (pending request queue full)');
      return { id: '', abort: () => {} };
    }
    const id = randomUUID();
    const pending: PendingHttp = { ...sink, gotHead: false, headTimer: null };
    pending.headTimer = setTimeout(() => {
      tunnel.pending.delete(id);
      sink.onError('Request timed out');
    }, HTTP_HEAD_TIMEOUT_MS);
    tunnel.pending.set(id, pending);
    this.send(tunnel, {
      type: 'http',
      id,
      method: req.method,
      path: req.path,
      headers: req.headers,
      body: req.body?.length ? req.body.toString('base64') : undefined,
    });
    return {
      id,
      abort: () => {
        const p = tunnel.pending.get(id);
        if (!p) return;
        if (p.headTimer) clearTimeout(p.headTimer);
        tunnel.pending.delete(id);
        this.send(tunnel, { type: 'http:abort', id });
      },
    };
  }

  private newChannel(runnerId: string, kind: ChannelKind, clientWs: WebSocket): { tunnel: Tunnel; id: string } {
    const tunnel = this.tunnels.get(runnerId);
    if (!tunnel) throw new Error('Runner not connected');
    // A closed control socket would silently drop the open frame and leave the
    // client attached to a channel the runner never opens.
    if (tunnel.ws.readyState !== 1) throw new Error('Runner tunnel not open');
    const id = randomUUID();
    tunnel.channels.set(id, { ws: clientWs, kind });
    return { tunnel, id };
  }

  openWsChannel(runnerId: string, path: string, query: string | undefined, clientWs: WebSocket): string {
    const { tunnel, id } = this.newChannel(runnerId, 'ws', clientWs);
    this.send(tunnel, { type: 'ws:open', id, path, query });
    return id;
  }

  /** Raw TCP to 127.0.0.1:<port> on the runner (dev-server forwarding). */
  openTcpChannel(runnerId: string, port: number, clientWs: WebSocket): string {
    const { tunnel, id } = this.newChannel(runnerId, 'tcp', clientWs);
    this.send(tunnel, { type: 'tcp:open', id, port });
    return id;
  }

  sendWsFrame(runnerId: string, channelId: string, frame: { data: string; b64?: boolean }): void {
    const tunnel = this.tunnels.get(runnerId);
    if (tunnel) this.send(tunnel, { type: 'ws:frame', id: channelId, ...frame });
  }

  sendTcpData(runnerId: string, channelId: string, chunk: Buffer): void {
    const tunnel = this.tunnels.get(runnerId);
    if (tunnel) this.send(tunnel, { type: 'tcp:data', id: channelId, data: chunk.toString('base64') });
  }

  /** Closes either kind — the stored kind picks the frame the runner expects. */
  closeChannel(runnerId: string, channelId: string, code?: number): void {
    const tunnel = this.tunnels.get(runnerId);
    if (!tunnel) return;
    const channel = tunnel.channels.get(channelId);
    tunnel.channels.delete(channelId);
    if (channel?.kind === 'tcp') this.send(tunnel, { type: 'tcp:close', id: channelId });
    else this.send(tunnel, { type: 'ws:close', id: channelId, code });
  }

  handleRunnerMessage(runnerId: string, raw: unknown): void {
    const tunnel = this.tunnels.get(runnerId);
    if (!tunnel) return;
    const msg = parseMsg(raw);
    if (!msg) return;
    if (msg.type === 'pong') {
      tunnel.missedPings = 0;
      // Presence heartbeat rides the pong so a crashed relay can never leave
      // runners stuck "online" — the store side ages entries out.
      if (Date.now() - tunnel.lastOnlineReportAt >= ONLINE_REPORT_INTERVAL_MS) {
        tunnel.lastOnlineReportAt = Date.now();
        this.presence.online?.(tunnel.runnerId);
      }
    } else if (msg.type === 'http:head') {
      const pending = tunnel.pending.get(msg.id as string);
      if (!pending) return;
      if (pending.headTimer) clearTimeout(pending.headTimer);
      pending.headTimer = null;
      pending.gotHead = true;
      pending.onHead(msg as unknown as HttpHeadMsg);
    } else if (msg.type === 'http:data') {
      const pending = tunnel.pending.get(msg.id as string);
      if (pending?.gotHead) pending.onData(Buffer.from(String(msg.data), 'base64'));
    } else if (msg.type === 'http:end') {
      const pending = tunnel.pending.get(msg.id as string);
      if (!pending) return;
      tunnel.pending.delete(msg.id as string);
      pending.onEnd();
    } else if (msg.type === 'http:error') {
      const pending = tunnel.pending.get(msg.id as string);
      if (!pending) return;
      if (pending.headTimer) clearTimeout(pending.headTimer);
      tunnel.pending.delete(msg.id as string);
      pending.onError(String(msg.message ?? 'Proxy error'));
    } else if (msg.type === 'ws:frame') {
      const channel = tunnel.channels.get(msg.id as string);
      if (channel?.kind === 'ws' && channel.ws.readyState === 1) {
        channel.ws.send(decodeWsData(msg as unknown as WsFrameMsg));
      }
    } else if (msg.type === 'tcp:data') {
      const channel = tunnel.channels.get(msg.id as string);
      // Always a binary frame: TCP has no text/binary distinction, and the
      // forwarder writes whatever arrives straight to a socket.
      if (channel?.kind === 'tcp' && channel.ws.readyState === 1) {
        channel.ws.send(Buffer.from(String(msg.data), 'base64'), { binary: true });
      }
    } else if (msg.type === 'ws:close') {
      const channel = tunnel.channels.get(msg.id as string);
      if (channel) {
        tunnel.channels.delete(msg.id as string);
        channel.ws.close(sanitizeCloseCode(msg.code as number | undefined));
      }
    } else if (msg.type === 'tcp:close') {
      const channel = tunnel.channels.get(msg.id as string);
      if (channel) {
        tunnel.channels.delete(msg.id as string);
        // A refusal carries a message; a plain FIN doesn't. The forwarder has to
        // tell them apart: "the dev server closed the connection" is normal,
        // "that port isn't forwardable" needs to reach a human.
        const message = typeof msg.message === 'string' ? msg.message : '';
        if (message) {
          this.log(`tcp channel refused by ${tunnel.runnerId}: ${message}`);
          channel.ws.close(1011, message.slice(0, 120));
        } else {
          channel.ws.close(1000);
        }
      }
    }
  }

  /**
   * Deploy-time graceful drain: in-band drain message first (WS close frames
   * don't reliably arrive within a kill window), then close with CLOSE_DRAIN
   * so runners reset their backoff and redial immediately.
   */
  async drain(reason = 'Relay draining for deploy'): Promise<void> {
    this.draining = true;
    const all = [...this.tunnels.values()];
    this.log(`draining ${all.length} tunnels`);
    for (const tunnel of all) {
      try {
        this.send(tunnel, { type: 'drain', reason });
      } catch {
        /* best effort */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const tunnel of all) {
      this.dispose(tunnel, reason, CLOSE_DRAIN);
      this.tunnels.delete(tunnel.runnerId);
    }
  }

  private dispose(tunnel: Tunnel, reason: string, closeCode = 1000): void {
    if (tunnel.pingTimer) clearInterval(tunnel.pingTimer);
    for (const [, pending] of tunnel.pending) {
      if (pending.headTimer) clearTimeout(pending.headTimer);
      pending.onError(reason);
    }
    tunnel.pending.clear();
    for (const [, channel] of tunnel.channels) {
      try {
        channel.ws.close(1001, reason);
      } catch {
        /* already closed */
      }
    }
    tunnel.channels.clear();
    try {
      tunnel.ws.close(closeCode, reason);
    } catch {
      /* already closed */
    }
  }

  private send(tunnel: Tunnel, message: RelayToRunner): void {
    if (tunnel.ws.readyState === 1) tunnel.ws.send(JSON.stringify(message));
  }
}

// Never forward unsendable close codes; never map to 1000 (clients read 1000
// as a clean exit and stop reconnecting).
function sanitizeCloseCode(code: number | undefined): number {
  if (code == null || [1004, 1005, 1006, 1015].includes(code)) return 1011;
  if (code === 1000 || (code >= 1001 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1011;
}

function accessCookieValue(secret: string, runnerId: string, accessKey: string): string {
  return createHmac('sha256', secret).update(`${runnerId}:${accessKey}`).digest('hex');
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Query param carrying a socket ticket. Relay-only — never forwarded. */
const TICKET_PARAM = 'ticket';
/** Frames a client may send while ticket verification is still in flight. */
const MAX_EARLY_FRAMES = 64;

function readParam(query: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const pair of query.split('&')) {
    if (pair.startsWith(prefix)) return decodeURIComponent(pair.slice(prefix.length));
  }
  return null;
}

/**
 * Drop one query param, leaving every other pair byte-exact. Rebuilding via
 * URLSearchParams would re-encode the whole string, and the values here are
 * absolute filesystem paths going to the runner — not worth the risk.
 */
function stripParam(query: string, name: string): string {
  if (!query) return query;
  const prefix = `${name}=`;
  return query
    .split('&')
    .filter((pair) => pair !== name && !pair.startsWith(prefix))
    .join('&');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Hop-by-hop headers that must not be forwarded through the tunnel. */
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export function buildRelayApp(opts: RelayOptions): { app: FastifyInstance; tunnels: TunnelManager } {
  const log = opts.log ?? ((line: string) => console.log(`[relay] ${redactSecrets(line)}`));
  const tunnels = new TunnelManager(log, { online: opts.onRunnerOnline, offline: opts.onRunnerOffline });
  // Fastify defaults bodyLimit to 1 MB, which made the relay — not the runner —
  // the binding constraint on every proxied POST. The worktree upload route
  // allows 15 MB and simply failed with 413 through the tunnel. A proxy must
  // never be stricter than what it proxies, so this sits above every downstream
  // limit; the runner still enforces its own.
  //
  // Bounded rather than unlimited on purpose: bodies are buffered whole here (the
  // relay does not parse them, but it does hold them), so this is the per-request
  // memory ceiling.
  const app = Fastify({ logger: false, exposeHeadRoutes: false, bodyLimit: MAX_PROXY_BODY_BYTES });

  // Raw pass-through bodies: the relay never parses payloads it proxies.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const domainSuffix = `.${opts.domain}`;
  const runnerIdOf = (req: FastifyRequest): string | null => {
    const hostname = ((req.headers.host ?? '').split(':')[0] ?? '').toLowerCase();
    if (!hostname.endsWith(domainSuffix)) return null;
    const label = hostname.slice(0, -domainSuffix.length);
    return label && !label.includes('.') ? label : null;
  };

  app.register(fastifyWebsocket, {
    options: {
      // Interactive traffic: Nagle + delayed-ACK across tunnel hops turns
      // keystroke echo into visible lag.
      verifyClient: () => true,
    },
  });

  app.register(async (wsScope) => {
    // ── Runner registration ─────────────────────────────────────────
    wsScope.get<{ Querystring: { runner?: string; token?: string } }>(
      '/tunnel',
      { websocket: true },
      (connection, req) => {
        const socket = connection.socket as WebSocket;
        (req.raw.socket as Socket).setNoDelay(true);
        const runnerId = String(req.query.runner ?? '');
        const token = String(req.query.token ?? '');
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(runnerId)) {
          socket.close(1008, 'Invalid runner id');
          return;
        }
        let registered = false;
        let authing = false;
        socket.on('message', (raw) => {
          if (!registered) {
            // Protocol: the runner sends hello and waits for hello-ack before
            // anything else, so pre-registration traffic beyond hello is a
            // protocol violation we can ignore.
            if (authing) return;
            const msg = parseMsg(raw);
            if (!msg || msg.type !== 'hello') {
              socket.close(1008, 'Expected hello');
              return;
            }
            if (msg.v !== PROTO_VERSION) {
              socket.close(CLOSE_BAD_VERSION, `Unsupported protocol ${String(msg.v)}`);
              return;
            }
            const accessKey = String(msg.accessKey ?? '');
            if (accessKey.length < 16) {
              socket.close(1008, 'Access key too short');
              return;
            }
            authing = true;
            void (async () => {
              let ok = false;
              try {
                ok = await opts.auth.verifyRunner(runnerId, token);
              } catch (err) {
                log(`verifyRunner error for ${runnerId}: ${(err as Error).message}`);
              }
              authing = false;
              if (socket.readyState !== 1) return;
              if (!ok) {
                log(`tunnel auth failed for ${runnerId}`);
                socket.close(1008, 'Unauthorized');
                return;
              }
              if (!tunnels.register(runnerId, accessKey, socket)) return;
              registered = true;
              socket.send(JSON.stringify({ type: 'hello-ack', v: PROTO_VERSION }));
            })();
            return;
          }
          tunnels.handleRunnerMessage(runnerId, raw);
        });
        socket.on('close', () => {
          if (registered) tunnels.unregister(runnerId, socket);
        });
        socket.on('error', () => {
          if (registered) tunnels.unregister(runnerId, socket);
        });
      },
    );

    // ── Client traffic (hostname-routed) ────────────────────────────
    const proxyWs = (connection: { socket: unknown }, req: FastifyRequest) => {
      const clientWs = connection.socket as WebSocket;
      (req.raw.socket as Socket).setNoDelay(true);
      const runnerId = runnerIdOf(req);
      if (!runnerId) {
        clientWs.close(1008, 'Unauthorized');
        return;
      }
      const url = new URL(req.url, 'http://relay.internal');
      const rawQuery = url.search.slice(1);
      const ticket = readParam(rawQuery, TICKET_PARAM);
      const query = ticket ? stripParam(rawQuery, TICKET_PARAM) : rawQuery;

      // Port forwarding: a reserved path, so it never reaches the runner's app.
      const tcp = url.pathname === TCP_FORWARD_PATH;
      const tcpPort = tcp ? Number(readParam(rawQuery, TCP_PORT_PARAM) ?? '') : 0;
      if (tcp && !(Number.isInteger(tcpPort) && tcpPort > 0 && tcpPort < 65536)) {
        clientWs.close(1008, 'Invalid port');
        return;
      }

      let channelId: string | null = null;
      let gone = false;
      // The handshake has already completed by the time this handler runs, so
      // a client can send frames before ticket verification finishes. Buffer
      // them — dropping silently would eat the terminal's first resize, which
      // is exactly the bug the client works around by passing cols/rows in the
      // URL.
      const early: { data: Buffer; isBinary: boolean }[] = [];

      const forward = (data: Buffer, isBinary: boolean) => {
        if (tcp) tunnels.sendTcpData(runnerId, channelId!, data);
        else tunnels.sendWsFrame(runnerId, channelId!, encodeWsData(data, isBinary));
      };

      clientWs.on('message', (data, isBinary) => {
        if (channelId) forward(data as Buffer, isBinary);
        else if (early.length < MAX_EARLY_FRAMES) early.push({ data: data as Buffer, isBinary });
      });
      clientWs.on('close', () => {
        gone = true;
        if (channelId) tunnels.closeChannel(runnerId, channelId);
      });
      clientWs.on('error', () => {
        gone = true;
        if (channelId) tunnels.closeChannel(runnerId, channelId);
      });

      void (async () => {
        const ok = await authorizeRequest(req, runnerId, ticket);
        if (gone || clientWs.readyState !== 1) return;
        if (!ok) {
          // 1008 means "your credential is the problem" — the client re-mints a
          // ticket and retries once. 1011 (below) means the runner is away, so
          // the client keeps backing off instead. Never collapse the two.
          clientWs.close(1008, 'Unauthorized');
          return;
        }
        try {
          channelId = tcp
            ? tunnels.openTcpChannel(runnerId, tcpPort, clientWs)
            : tunnels.openWsChannel(runnerId, url.pathname, query || undefined, clientWs);
        } catch {
          clientWs.close(1011, 'Runner not connected');
          return;
        }
        if (tcp) log(`tcp forward opened: ${runnerId}:${tcpPort}`);
        for (const frame of early) forward(frame.data, frame.isBinary);
        early.length = 0;
      })();
    };

    /** Cookie gate — used by the runner's own same-origin SPA. */
    const authorized = (req: FastifyRequest, runnerId: string): boolean => {
      const tunnel = tunnels.get(runnerId);
      if (!tunnel) return false;
      const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
      if (!cookie) return false;
      return safeEqual(cookie, accessCookieValue(opts.cookieSecret, runnerId, tunnel.accessKey));
    };

    /** Cookie, or a socket ticket for clients on a different origin. */
    const authorizeRequest = async (
      req: FastifyRequest,
      runnerId: string,
      ticket: string | null,
    ): Promise<boolean> => {
      if (authorized(req, runnerId)) return true;
      if (!ticket) return false;
      const tunnel = tunnels.get(runnerId);
      if (!tunnel) return false;
      try {
        return await opts.auth.authorizeSocket(runnerId, ticket, tunnel.accessKey);
      } catch (err) {
        log(`authorizeSocket error for ${runnerId}: ${(err as Error).message}`);
        return false;
      }
    };

    const proxyHttp = async (req: FastifyRequest, reply: FastifyReply) => {
      const runnerId = runnerIdOf(req);
      if (!runnerId) {
        // Bare relay host: only the control endpoints below exist.
        return reply.code(404).send({ error: 'Not found' });
      }
      const tunnel = tunnels.get(runnerId);

      const url = new URL(req.url, 'http://relay.internal');

      // Access-gate bootstrap: /__strado_connect?key=<accessKey> sets the
      // signed cookie, then redirects into the app. EventSource/WebSocket
      // send cookies automatically, so the SPA needs no changes.
      if (url.pathname === '/__strado_connect') {
        if (!tunnel) return reply.code(503).send({ error: 'Runner not connected' });
        const key = String((req.query as Record<string, unknown>).key ?? '');
        let ok = false;
        try {
          ok = key.length > 0 && (await opts.auth.authorizeConnect(runnerId, key, tunnel.accessKey));
        } catch (err) {
          log(`authorizeConnect error for ${runnerId}: ${(err as Error).message}`);
          return reply.code(500).send({ error: 'Access check failed' });
        }
        if (!ok) {
          log(`connect denied for ${runnerId}`);
          return reply.code(403).send({ error: 'Invalid access key' });
        }
        const value = accessCookieValue(opts.cookieSecret, runnerId, tunnel.accessKey);
        reply.header(
          'set-cookie',
          `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        );
        return reply.redirect('/');
      }

      const rawQuery = url.search.slice(1);
      const ticket = readParam(rawQuery, TICKET_PARAM);
      if (!(await authorizeRequest(req, runnerId, ticket))) {
        // 401 = fixable (get a cookie or a fresh ticket); 403 is reserved for
        // definitive denials so clients know when to stop retrying.
        return reply.code(401).send({ error: 'Unauthorized — open /__strado_connect?key=…' });
      }
      if (!tunnel) return reply.code(503).send({ error: 'Runner not connected' });

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string' && !HOP_HEADERS.has(key)) headers[key] = value;
      }

      // Streamed response: hijack the reply and write raw as chunks arrive —
      // buffering here would break every /events/* SSE stream.
      reply.hijack();
      const raw = reply.raw as ServerResponse;
      (req.raw as IncomingMessage).socket.setNoDelay(true);
      let finished = false;
      const handle = tunnels.sendHttp(
        runnerId,
        {
          method: req.method,
          // Ticket stripped: it authorizes the relay hop only and must never
          // reach runner application code or the runner's logs.
          path: url.pathname + (() => {
            const q = ticket ? stripParam(rawQuery, TICKET_PARAM) : rawQuery;
            return q ? `?${q}` : '';
          })(),
          headers,
          body: Buffer.isBuffer(req.body) ? req.body : undefined,
        },
        {
          onHead: (head) => {
            const outHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(head.headers)) {
              if (!HOP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
            }
            raw.writeHead(head.status, outHeaders);
          },
          onData: (chunk) => {
            raw.write(chunk);
          },
          onEnd: () => {
            finished = true;
            raw.end();
          },
          onError: (message) => {
            finished = true;
            if (!raw.headersSent) {
              raw.writeHead(502, { 'content-type': 'application/json' });
              raw.end(JSON.stringify({ error: message }));
            } else {
              raw.destroy();
            }
          },
        },
      );
      if (!handle) {
        raw.writeHead(503, { 'content-type': 'application/json' });
        raw.end(JSON.stringify({ error: 'Runner not connected' }));
        return;
      }
      // Client went away (closed tab / EventSource teardown): abort the
      // runner-side fetch or it streams into the void forever.
      raw.on('close', () => {
        if (!finished) handle.abort();
      });
    };

    // wsHandler is only legal on GET routes; other methods proxy HTTP only.
    const rest = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
    wsScope.route({ method: 'GET', url: '/*', handler: proxyHttp, wsHandler: proxyWs });
    wsScope.route({ method: 'GET', url: '/', handler: proxyHttp, wsHandler: proxyWs });
    wsScope.route({ method: [...rest], url: '/*', handler: proxyHttp });
    wsScope.route({ method: [...rest], url: '/', handler: proxyHttp });
  });

  // Control endpoints on the bare relay host (exact routes win over '/*'
  // only for the same host, so guard on runnerIdOf being null).
  app.get('/healthz', async (req, reply) => {
    if (runnerIdOf(req)) return reply.callNotFound();
    return { ok: true, tunnels: tunnels.list().length };
  });

  // Caddy on_demand_tls ask endpoint: only mint certs for hostnames that map
  // to a currently-registered runner (prevents cert-issuance spam).
  app.get<{ Querystring: { domain?: string } }>('/__relay_ask', async (req, reply) => {
    const domain = String(req.query.domain ?? '').toLowerCase();
    if (!domain.endsWith(domainSuffix)) return reply.code(403).send('no');
    const label = domain.slice(0, -domainSuffix.length);
    if (!label || label.includes('.') || !tunnels.get(label)) return reply.code(403).send('no');
    return reply.send('ok');
  });

  return { app, tunnels };
}
