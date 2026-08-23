// The one route from inside a sandbox back to the host server.
//
// Agent hooks report status by POSTing to the server; inside a container the
// host's loopback is unreachable, so the host bind-mounts a unix socket into
// every sandbox (spec.ts's SANDBOX_SOCKET_PATH) and the hooks post to that
// instead. This file is the host end of that socket.
//
// It is NOT the server. A sandboxed agent can write whatever it likes to the
// socket, and the server trusts every loopback caller completely — so the
// socket is only ever a forwarder for the handful of status/event routes
// below. Anything else is answered 403 here and never reaches the app: without
// that, an agent in a sandbox could drive the whole worktree/terminal API on
// the host, which is a sandbox escape by construction.
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Socket } from 'node:net';

/** Method + path pairs a sandboxed hook may reach. Every entry is a POST on
 * purpose — a hook reports, it never reads. `prefix` entries keep their
 * trailing slash, also on purpose: the match has to land on a segment
 * boundary, or `/api/codexevil` would pass as `/api/codex`. */
export const ALLOW: { method: string; path: string; prefix: boolean }[] = [
  { method: 'POST', path: '/api/claude/status', prefix: false },
  { method: 'POST', path: '/api/codex/', prefix: true },
  { method: 'POST', path: '/api/opencode/', prefix: true },
  // The plan also named POST /api/events. No route answers it — the SSE
  // streams are GETs under /events/ — so allowing it would only pre-open a
  // path for whatever gets mounted there later. test/api/hookAllowlist.test.ts
  // holds both halves of that reasoning against the real app.
];

/** A sandboxed caller must not get to pick the client address the server sees:
 * these are the headers a proxy-trusting server reads it from, and node has
 * already lowercased whatever arrived. */
const STRIPPED = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
]);

/** Exported for the tests; the forwarder is the only caller. */
export function isAllowed(method: string | undefined, url: string | undefined): boolean {
  if (url === undefined || !url.startsWith('/')) return false;
  const reqPath = url.split('?')[0] ?? '';
  // The target normalises dot segments and percent escapes; matching before it
  // does would let `/api/codex/../worktrees` through. Hook paths need neither,
  // so both are simply refused rather than normalised here.
  if (reqPath.includes('%') || reqPath.split('/').includes('..')) return false;
  return ALLOW.some(
    (r) => r.method === method && (r.prefix ? reqPath.startsWith(r.path) : reqPath === r.path),
  );
}

/** `process.umask(v)`, or undefined where it is unavailable — node throws for
 * it in a worker thread, and a hardening measure must not be the reason the
 * socket fails to come up. */
function withUmask(mask: number): number | undefined {
  try {
    return process.umask(mask);
  } catch {
    return undefined;
  }
}

/**
 * Listen on `socketPath` and forward allowlisted requests to
 * 127.0.0.1:`targetPort`. Resolves once the socket is listening and 0600;
 * the returned function closes the listener and removes the socket file.
 */
export async function startHookSocket(opts: {
  socketPath: string;
  targetPort: number;
  /** How long a connection may sit idle before it is destroyed (default 10s).
   * A seam for the tests — nothing in the app passes it. */
  idleTimeoutMs?: number;
}): Promise<() => Promise<void>> {
  await fsp.mkdir(path.dirname(opts.socketPath), { recursive: true });
  // A crash leaves the socket file behind and bind() would EADDRINUSE on it.
  await fsp.rm(opts.socketPath, { force: true });

  const open = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (!isAllowed(req.method, req.url)) {
      req.resume(); // drain, or the client waits on a body nobody reads
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"FORBIDDEN","message":"route not reachable from a sandbox"}}');
      return;
    }
    const headers: http.OutgoingHttpHeaders = { host: `127.0.0.1:${opts.targetPort}` };
    for (const [k, v] of Object.entries(req.headers)) {
      if (k !== 'host' && !STRIPPED.has(k)) headers[k] = v;
    }
    const proxied = http.request(
      { host: '127.0.0.1', port: opts.targetPort, method: req.method, path: req.url, headers },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxied.on('error', () => {
      req.resume();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"UPSTREAM","message":"server unreachable"}}');
    });
    req.pipe(proxied);
  });
  server.on('connection', (s) => {
    open.add(s);
    s.on('close', () => open.delete(s));
  });
  // A hook post is milliseconds of work; an agent that opens a connection and
  // then stalls must not get to hold one on the host.
  //
  // setTimeout is the line that does that: it is the only one of the three
  // that actually destroys the socket at the deadline (headersTimeout and
  // requestTimeout were measured NOT closing a stalled connection on node
  // 20–25). The other two stay because they are correct in principle and cost
  // nothing — but they are not the bound.
  const idleMs = opts.idleTimeoutMs ?? 10_000;
  server.setTimeout(idleMs, (s) => s.destroy());
  server.headersTimeout = Math.min(5_000, idleMs);
  server.requestTimeout = idleMs;

  // The chmod below is a beat too late on its own: bind() creates the socket
  // with whatever the process umask allows, and it is connectable in between.
  // umask is process-global, so this is held only across the listen — and it
  // throws inside a worker thread (the test runner), where chmod alone stands.
  const prevMask = withUmask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.socketPath, () => {
        server.removeListener('error', reject);
        // Nothing after boot should be able to take the process down; a hook
        // that dies mid-post must not become an unhandled 'error' event.
        server.on('error', () => {});
        resolve();
      });
    });
  } finally {
    if (prevMask !== undefined) withUmask(prevMask);
  }
  // Only the host user talks to this socket. Rootless podman maps the
  // container's user to that same uid, so 0600 still lets the agent in.
  // (Belt and braces with the umask above — some platforms ignore it here.)
  await fsp.chmod(opts.socketPath, 0o600);

  return async () => {
    for (const s of open) s.destroy(); // else close() waits on keep-alive clients
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(opts.socketPath, { force: true });
  };
}
