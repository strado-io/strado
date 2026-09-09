// The hook socket is the one hole through the container wall, so most of what
// is asserted here is what must NOT get through it. A sandboxed agent can
// write to this socket at will; if anything but the status routes reaches the
// host server, the sandbox is decorative.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowed, startHookSocket } from './hookSocket.js';

type Hit = {
  method: string;
  url: string;
  body: string;
  contentType: string | undefined;
  headers: http.IncomingHttpHeaders;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A stand-in for the real server, on loopback like the real one. */
async function startTarget(reply?: { code: number; body: string }): Promise<{ port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        contentType: req.headers['content-type'],
        headers: req.headers,
      });
      res.writeHead(reply?.code ?? 200, { 'content-type': 'application/json' });
      res.end(reply?.body ?? '{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { port: addr.port, hits };
}

async function tmpSocketPath(): Promise<string> {
  // Short by construction: a unix socket path is capped near 104 bytes.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hs-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'api.sock');
}

async function start(targetPort: number): Promise<string> {
  const socketPath = await tmpSocketPath();
  const close = await startHookSocket({ socketPath, targetPort });
  cleanups.push(close);
  return socketPath;
}

function call(
  socketPath: string,
  method: string,
  reqPath: string,
  body?: string,
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: reqPath,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: out,
            contentType: res.headers['content-type'],
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('startHookSocket', () => {
  it('forwards an allowlisted POST to the target and returns its response', async () => {
    const target = await startTarget({ code: 201, body: '{"stored":true}' });
    const sock = await start(target.port);

    const res = await call(sock, 'POST', '/api/claude/status', '{"cwd":"/w","status":"working"}');

    expect(res.status).toBe(201);
    expect(res.body).toBe('{"stored":true}');
    expect(res.contentType).toBe('application/json');
    expect(target.hits).toMatchObject([
      {
        method: 'POST',
        url: '/api/claude/status',
        body: '{"cwd":"/w","status":"working"}',
        contentType: 'application/json',
      },
    ]);
  });

  it('allows agent status and the exact Git credential broker route', async () => {
    const target = await startTarget();
    const sock = await start(target.port);

    for (const p of ['/api/codex/status', '/api/opencode/status', '/api/git/credential']) {
      expect((await call(sock, 'POST', p, '{}')).status).toBe(200);
    }
    // Nothing answers POST /api/events — the SSE streams are GETs under
    // /events/ — so it is off the wall. hookAllowlist.test.ts pins that.
    expect((await call(sock, 'POST', '/api/events', '{}')).status).toBe(403);
    expect(target.hits.map((h) => h.url)).toEqual([
      '/api/codex/status',
      '/api/opencode/status',
      '/api/git/credential',
    ]);
  });

  it('403s a non-status route without the target ever seeing it', async () => {
    const target = await startTarget();
    const sock = await start(target.port);

    const res = await call(sock, 'GET', '/api/worktrees');

    expect(res.status).toBe(403);
    expect(target.hits).toEqual([]);
  });

  it('403s the terminal API', async () => {
    const target = await startTarget();
    const sock = await start(target.port);

    expect((await call(sock, 'POST', '/api/terminal/sessions', '{}')).status).toBe(403);
    expect((await call(sock, 'GET', '/api/claude/status')).status).toBe(403);
    expect(target.hits).toEqual([]);
  });

  it('matches prefixes on a segment boundary, not a string prefix', async () => {
    const target = await startTarget();
    const sock = await start(target.port);

    expect((await call(sock, 'POST', '/api/codex/notify', '{}')).status).toBe(200);
    expect((await call(sock, 'POST', '/api/codexevil', '{}')).status).toBe(403);
    expect((await call(sock, 'POST', '/api/opencodex/steal', '{}')).status).toBe(403);
    expect(target.hits.map((h) => h.url)).toEqual(['/api/codex/notify']);
  });

  it('403s an attempt to climb out of an allowed prefix', async () => {
    const target = await startTarget();
    const sock = await start(target.port);

    expect((await call(sock, 'POST', '/api/codex/../worktrees', '{}')).status).toBe(403);
    expect((await call(sock, 'POST', '/api/codex/%2e%2e/worktrees', '{}')).status).toBe(403);
    expect(target.hits).toEqual([]);
  });

  it('keeps the query string but allowlists on the path alone', async () => {
    const target = await startTarget();
    const sock = await start(target.port);

    expect((await call(sock, 'POST', '/api/codex/status?tab=2', '{}')).status).toBe(200);
    expect((await call(sock, 'POST', '/api/worktrees?x=/api/codex/status', '{}')).status).toBe(403);
    expect(target.hits.map((h) => h.url)).toEqual(['/api/codex/status?tab=2']);
  });

  it('starts over a stale socket file left by a crashed server', async () => {
    const target = await startTarget();
    const socketPath = await tmpSocketPath();
    await fsp.writeFile(socketPath, 'not a socket');

    const close = await startHookSocket({ socketPath, targetPort: target.port });
    cleanups.push(close);

    expect((await call(socketPath, 'POST', '/api/claude/status', '{}')).status).toBe(200);
  });

  it('leaves the socket 0600 and removes it on close', async () => {
    const target = await startTarget();
    const socketPath = await tmpSocketPath();
    const close = await startHookSocket({ socketPath, targetPort: target.port });

    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);

    await close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('strips the headers a caller could spoof its client address with', async () => {
    const target = await startTarget();
    const sock = await start(target.port);

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: sock,
          method: 'POST',
          path: '/api/claude/status',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '10.0.0.9',
            'x-real-ip': '10.0.0.9',
            forwarded: 'for=10.0.0.9',
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });

    const hit = target.hits[0];
    expect(hit?.headers['x-forwarded-for']).toBeUndefined();
    expect(hit?.headers['x-real-ip']).toBeUndefined();
    expect(hit?.headers['forwarded']).toBeUndefined();
    expect(hit?.headers['host']).toBe(`127.0.0.1:${target.port}`);
  });

  it('destroys a connection that opens and then stalls mid-request', async () => {
    // A sandboxed agent that never finishes a request would otherwise sit on a
    // host connection indefinitely. `headersTimeout`/`requestTimeout` do not
    // close it — only `server.setTimeout` does, which is what this pins.
    const target = await startTarget();
    const socketPath = await tmpSocketPath();
    const close = await startHookSocket({ socketPath, targetPort: target.port, idleTimeoutMs: 500 });
    cleanups.push(close);

    const stalled = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      stalled.on('connect', () => resolve());
      stalled.on('error', reject);
    });
    stalled.write('POST /api/claude/status HTTP/1.1\r\nHost: x\r\n'); // no blank line: never completes

    const closedInTime = await new Promise<boolean>((resolve) => {
      // 6x the deadline — the assertion is "it closes", not "it closes fast",
      // while staying under vitest's default 5s per-test budget.
      const giveUp = setTimeout(() => resolve(false), 3_000);
      stalled.on('close', () => {
        clearTimeout(giveUp);
        resolve(true);
      });
    });
    stalled.destroy();
    expect(closedInTime).toBe(true);
  });

  it('answers 502 when the target is not listening', async () => {
    // A port that was bound and then released: nothing answers on it.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const sock = await start(addr.port);

    expect((await call(sock, 'POST', '/api/claude/status', '{}')).status).toBe(502);
  });
});

describe('intercom routes through the hook socket', () => {
  it('allows the hook-facing routes plus the step 6 CLI, shell-adapter, and step 8 task/escalation rows, and nothing else under /api/intercom', () => {
    // Step 4/4b: hook delivery, confirm, send, and the turn diary.
    expect(isAllowed('POST', '/api/intercom/hook')).toBe(true);
    expect(isAllowed('POST', '/api/intercom/hook/confirm')).toBe(true);
    expect(isAllowed('POST', '/api/intercom/messages')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/hook')).toBe(false);
    expect(isAllowed('POST', '/api/intercom/hookx')).toBe(false);
    expect(isAllowed('GET', '/api/intercom/messages')).toBe(false);
    expect(isAllowed('GET', '/api/intercom/diary')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/diary?agent=claude-1%40repo&limit=5')).toBe(true); // the query string is not part of the match
    expect(isAllowed('GET', '/api/intercom/diary%2Fx')).toBe(false);                              // a percent escape in the PATH is refused
    expect(isAllowed('POST', '/api/intercom/diary')).toBe(false);
    expect(isAllowed('GET', '/api/intercom/diary/x')).toBe(false);
    // Step 6: the `strado` CLI's pull/ack/peers, and the shell adapters.
    expect(isAllowed('POST', '/api/intercom/pull')).toBe(true);
    expect(isAllowed('POST', '/api/intercom/messages/abc/ack')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/peers')).toBe(true);
    expect(isAllowed('POST', '/api/intercom/shell/run')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/tabs/claude-1@repo/read')).toBe(true);
    // Still off the wall: wrong verb, or a path shape none of the rows match.
    expect(isAllowed('POST', '/api/intercom/peers')).toBe(false);
    expect(isAllowed('GET', '/api/intercom/shell/run')).toBe(false);
    expect(isAllowed('POST', '/api/intercom/tabs/x/read')).toBe(false);
    expect(isAllowed('GET', '/api/intercom/tabsx/read')).toBe(false);
    expect(isAllowed('POST', '/api/intercom/messagesx/ack')).toBe(false);
    expect(isAllowed('GET', '/api/intercom/pull')).toBe(false);
    // step 8
    expect(isAllowed('POST', '/api/intercom/tasks')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/tasks')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/tasks?status=open&mine=1')).toBe(true);
    expect(isAllowed('POST', '/api/intercom/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV/claim')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
    expect(isAllowed('POST', '/api/intercom/escalations')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/escalations/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isAllowed('POST', '/api/intercom/escalations/01ARZ3NDEKTSV4RRFFQ69G5FAV/resolve')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/escalations')).toBe(false);
    expect(isAllowed('POST', '/api/intercom/tasksx')).toBe(false);

    expect(isAllowed('POST', '/api/intercom/forks')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/forks/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isAllowed('GET', '/api/intercom/forks')).toBe(false);
    expect(isAllowed('POST', '/api/intercom/forks/01ARZ3NDEKTSV4RRFFQ69G5FAV/cancel')).toBe(false);
    expect(isAllowed('POST', '/api/intercom/forksx')).toBe(false);
  });
});
