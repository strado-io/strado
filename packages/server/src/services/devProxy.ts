import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import type { DebugLog } from './debugLog.js';

// One fixed origin (https://dev.fleetx.io on :443) can only be bound by one
// dev server, so two worktrees of the same repo could never run side by side.
// The dev proxy owns that port instead and routes by Host:
//
//   dev.fleetx.io            -> the repo's main checkout
//   <worktree>.dev.fleetx.io -> that worktree's dev server on its own port
//
// Each dev server runs on a private loopback port (PORT env), so they never
// collide. The proxy terminates TLS with the configured certificate (a
// wildcard `*.dev.fleetx.io` cert covers every worktree) and forwards plain
// HTTP or, for dev servers that insist on HTTPS, TLS without verification.

export type DevProxyConfig = {
  /** Base hostname the main checkout is served at, e.g. dev.fleetx.io. */
  host: string;
  /** Port the proxy listens on (the port the app used to own). */
  port: number;
  /** PEM certificate + key; both absent = plain HTTP listener. */
  certFile?: string | null;
  keyFile?: string | null;
  /** The dev server itself speaks HTTPS on its private port. */
  upstreamTls?: boolean;
  /** Accept connections from other machines (phones on the LAN). */
  allowLan?: boolean;
};

export type DevProxyRegistration = {
  key: string;
  hostname: string;
  config: DevProxyConfig;
  /** Live upstream port, or null when the dev server is not running. */
  resolvePort: () => number | null;
};

export type DevProxy = {
  /** Route `hostname` to the worktree; starts the listener on first use. */
  register(reg: DevProxyRegistration): Promise<{ url: string; warning: string | null }>;
  unregister(key: string): void;
  /** Ports the proxy currently listens on (never to be evicted). */
  listenPorts(): Set<number>;
  close(): Promise<void>;
};

type Route = DevProxyRegistration;

type Listener = {
  server: http.Server | https.Server;
  tls: boolean;
  // hostname suffix -> secure context, for SNI across repos sharing a port
  contexts: Map<string, tls.SecureContext>;
};

const LOOPBACK = '127.0.0.1';

/**
 * The hostname a worktree is served at. The repo's main checkout keeps the
 * bare host; every other worktree gets a DNS-safe label from its directory.
 */
export function worktreeHostname(baseHost: string, worktreePath: string, repoPath: string): string {
  if (path.resolve(worktreePath) === path.resolve(repoPath)) return baseHost;
  const label = path
    .basename(worktreePath)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/, '');
  return `${label || 'worktree'}.${baseHost}`;
}

function stripPort(host: string | undefined): string {
  if (!host) return '';
  return host.replace(/:\d+$/, '').toLowerCase();
}

export function createDevProxy(debugLog?: DebugLog): DevProxy {
  const routes = new Map<string, Route>(); // key -> route
  const listeners = new Map<number, Listener>();
  // Upgraded (WebSocket) sockets leave the HTTP server's bookkeeping, so
  // server.close() would wait on them forever; close() destroys them.
  const tunnels = new Set<net.Socket>();
  const log = (line: string) => debugLog?.log('dev-proxy', line);

  function routeFor(port: number, hostHeader: string | undefined): Route | null {
    const host = stripPort(hostHeader);
    for (const r of routes.values()) {
      if (r.config.port === port && r.hostname === host) return r;
    }
    return null;
  }

  function knownHosts(port: number): string[] {
    return [...routes.values()].filter((r) => r.config.port === port).map((r) => r.hostname).sort();
  }

  // The dev server sees the base host it always saw, so host checks
  // (webpack-dev-server's allowedHosts) keep passing unchanged. The real
  // host travels in X-Forwarded-Host.
  function upstreamHeaders(req: http.IncomingMessage, route: Route, scheme: string): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    const original = req.headers.host ?? route.hostname;
    headers.host = route.config.host;
    if (typeof headers.origin === 'string' && stripPort(headers.origin.replace(/^\w+:\/\//, '')) === route.hostname) {
      headers.origin = `${scheme}://${route.config.host}`;
    }
    headers['x-forwarded-host'] = original;
    headers['x-forwarded-proto'] = scheme;
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? LOOPBACK;
    return headers;
  }

  function sendError(res: http.ServerResponse, status: number, message: string) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`[strado dev proxy] ${message}\n`);
  }

  function onRequest(port: number, scheme: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const route = routeFor(port, req.headers.host);
    if (!route) {
      const known = knownHosts(port);
      sendError(res, 404, `no worktree is served at ${stripPort(req.headers.host)}.` +
        (known.length ? ` Known hosts: ${known.join(', ')}` : ''));
      return;
    }
    const upstreamPort = route.resolvePort();
    if (!upstreamPort) {
      sendError(res, 502, `${route.hostname} is not running — start it in Strado.`);
      return;
    }
    if (upstreamPort === route.config.port) {
      // The dev server ignored PORT and bound the proxy's port on another
      // interface; forwarding would loop straight back into the proxy.
      sendError(res, 502, `${route.hostname}'s dev server is listening on :${upstreamPort} itself — make it use $PORT.`);
      return;
    }
    const mod = route.config.upstreamTls ? https : http;
    const upstream = mod.request(
      {
        host: LOOPBACK,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req, route, scheme),
        rejectUnauthorized: false,
      },
      (upRes) => {
        // rawHeaders keeps repeated headers (set-cookie) intact
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.rawHeaders);
        upRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      sendError(res, 502, `${route.hostname} (port ${upstreamPort}) did not answer: ${err.message}`);
    });
    req.pipe(upstream);
  }

  // WebSockets (HMR) are relayed as raw sockets after replaying the request.
  function onUpgrade(port: number, scheme: string, req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    const route = routeFor(port, req.headers.host);
    const upstreamPort = route?.resolvePort() ?? null;
    if (!route || !upstreamPort || upstreamPort === route.config.port) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    const headers = upstreamHeaders(req, route, scheme === 'https' ? 'wss' : 'ws');
    const upstream = route.config.upstreamTls
      ? tls.connect({ host: LOOPBACK, port: upstreamPort, rejectUnauthorized: false, servername: route.config.host })
      : net.connect(upstreamPort, LOOPBACK);
    const ready = route.config.upstreamTls ? 'secureConnect' : 'connect';
    upstream.once(ready, () => {
      let head0 = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) head0 += `${name}: ${v}\r\n`;
      }
      upstream.write(head0 + '\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const destroy = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', destroy);
    socket.on('error', destroy);
    tunnels.add(socket);
    tunnels.add(upstream);
    upstream.on('close', () => {
      tunnels.delete(upstream);
      socket.destroy();
    });
    socket.on('close', () => {
      tunnels.delete(socket);
      upstream.destroy();
    });
  }

  function secureContext(config: DevProxyConfig): tls.SecureContext {
    try {
      return tls.createSecureContext({
        cert: fs.readFileSync(config.certFile!),
        key: fs.readFileSync(config.keyFile!),
      });
    } catch (err) {
      throw new AppError('VALIDATION', `dev proxy certificate for ${config.host}: ${(err as Error).message}`);
    }
  }

  async function ensureListener(config: DevProxyConfig): Promise<Listener> {
    const wantsTls = Boolean(config.certFile && config.keyFile);
    const existing = listeners.get(config.port);
    if (existing) {
      if (existing.tls !== wantsTls) {
        throw new AppError(
          'VALIDATION',
          `dev proxy on :${config.port} is already ${existing.tls ? 'HTTPS' : 'HTTP'}; ${config.host} asks for ${wantsTls ? 'HTTPS' : 'HTTP'}`,
        );
      }
      if (wantsTls && !existing.contexts.has(config.host)) existing.contexts.set(config.host, secureContext(config));
      return existing;
    }

    const contexts = new Map<string, tls.SecureContext>();
    let server: http.Server | https.Server;
    if (wantsTls) {
      const ctx = secureContext(config);
      contexts.set(config.host, ctx);
      server = https.createServer({
        SNICallback: (servername, cb) => {
          const name = servername.toLowerCase();
          for (const [base, c] of contexts) {
            if (name === base || name.endsWith(`.${base}`)) return cb(null, c);
          }
          cb(null, ctx);
        },
        cert: fs.readFileSync(config.certFile!),
        key: fs.readFileSync(config.keyFile!),
      });
    } else {
      server = http.createServer();
    }
    const scheme = wantsTls ? 'https' : 'http';
    server.on('request', (req, res) => onRequest(config.port, scheme, req, res));
    server.on('upgrade', (req, socket, head) => onUpgrade(config.port, scheme, req, socket as net.Socket, head));

    // macOS lets an unprivileged process bind a port below 1024 only on the
    // wildcard address, so those listen everywhere and drop non-loopback
    // peers unless the repo opted into LAN access.
    const listenHost = config.port < 1024 ? undefined : LOOPBACK;
    if (!config.allowLan) {
      server.on('connection', (socket: net.Socket) => {
        const addr = socket.remoteAddress ?? '';
        if (!(addr === LOOPBACK || addr === '::1' || addr === '::ffff:127.0.0.1')) socket.destroy();
      });
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        const hint = err.code === 'EACCES'
          ? ' (ports below 1024 need extra permission on this OS)'
          : err.code === 'EADDRINUSE' ? ' (another process holds it)' : '';
        reject(new AppError('PORT_IN_USE', `dev proxy could not listen on :${config.port}${hint}: ${err.message}`));
      };
      server.once('error', onError);
      server.listen(config.port, listenHost, () => {
        server.off('error', onError);
        resolve();
      });
    });
    server.on('error', (err) => log(`:${config.port} server error: ${err.message}`));
    const listener: Listener = { server, tls: wantsTls, contexts };
    listeners.set(config.port, listener);
    log(`listening on ${scheme}://${listenHost ?? '*'}:${config.port}`);
    return listener;
  }

  async function resolveWarning(hostname: string): Promise<string | null> {
    try {
      const addrs = await dns.lookup(hostname, { all: true });
      if (addrs.some((a) => a.address === LOOPBACK || a.address === '::1')) return null;
      return `${hostname} resolves to ${addrs.map((a) => a.address).join(', ')}, not ${LOOPBACK}`;
    } catch {
      return `${hostname} does not resolve — add "${LOOPBACK} ${hostname}" to /etc/hosts`;
    }
  }

  return {
    async register(reg) {
      const listener = await ensureListener(reg.config);
      for (const [key, r] of routes) {
        if (key !== reg.key && r.config.port === reg.config.port && r.hostname === reg.hostname) {
          throw new AppError('VALIDATION', `${reg.hostname} is already routed to ${key}`);
        }
      }
      routes.set(reg.key, reg);
      const scheme = listener.tls ? 'https' : 'http';
      const defaultPort = listener.tls ? 443 : 80;
      const url = `${scheme}://${reg.hostname}${reg.config.port === defaultPort ? '' : `:${reg.config.port}`}`;
      log(`route ${reg.hostname} -> ${reg.key}`);
      return { url, warning: await resolveWarning(reg.hostname) };
    },
    unregister(key) {
      routes.delete(key);
    },
    listenPorts() {
      return new Set(listeners.keys());
    },
    async close() {
      const servers = [...listeners.values()].map((l) => l.server);
      listeners.clear();
      routes.clear();
      for (const s of tunnels) s.destroy();
      tunnels.clear();
      await Promise.all(
        servers.map((s) => new Promise<void>((resolve) => {
          s.close(() => resolve());
          (s as http.Server).closeAllConnections?.();
        })),
      );
    },
  };
}
