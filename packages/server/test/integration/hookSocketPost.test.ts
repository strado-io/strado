// All three agent hooks, run the way a sandboxed session runs them: with
// STRADO_SERVER_SOCKET set. They must post the SAME payload to the SAME path
// as the loopback branch, and must not touch the port at all.
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hooks');

type Hit = { url: string; body: any };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function collector(hits: Hit[]): http.Server {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ url: req.url ?? '', body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return server;
}

/** A stand-in for the host's hook socket. */
async function listenOnSocket(hits: Hit[]): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'api.sock');
  await new Promise<void>((resolve) => collector(hits).listen(socketPath, resolve));
  return socketPath;
}

/** The port branch, which must stay silent when the socket is in play. */
async function listenOnPort(hits: Hit[]): Promise<number> {
  const server = collector(hits);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

function runHook(script: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(HOOKS, script), ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end();
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

describe('hooks with STRADO_SERVER_SOCKET set', () => {
  it('claude-status-hook posts status over the socket, not the port', async () => {
    const viaSocket: Hit[] = [];
    const viaPort: Hit[] = [];
    const socketPath = await listenOnSocket(viaSocket);
    const port = await listenOnPort(viaPort);

    const code = await runHook('claude-status-hook.mjs', ['working', String(port)], {
      CLAUDE_PROJECT_DIR: '/tmp/wt-a',
      STRADO_SESSION_ID: '2',
      STRADO_SERVER_SOCKET: socketPath,
    });

    expect(code).toBe(0);
    expect(viaSocket).toEqual([
      { url: '/api/claude/status', body: { cwd: '/tmp/wt-a', status: 'working', sessionId: '2' } },
    ]);
    expect(viaPort).toEqual([]);
  });

  it('codex-notify-hook posts waiting over the socket, not the port', async () => {
    const viaSocket: Hit[] = [];
    const viaPort: Hit[] = [];
    const socketPath = await listenOnSocket(viaSocket);
    const port = await listenOnPort(viaPort);

    const code = await runHook(
      'codex-notify-hook.mjs',
      [String(port), '/tmp/wt-a', JSON.stringify({ type: 'agent-turn-complete' })],
      { STRADO_SESSION_ID: '3', STRADO_SERVER_SOCKET: socketPath },
    );

    expect(code).toBe(0);
    expect(viaSocket).toEqual([
      { url: '/api/codex/status', body: { cwd: '/tmp/wt-a', status: 'waiting', sessionId: '3' } },
    ]);
    expect(viaPort).toEqual([]);
  });

  it('the hooks still exit 0 when nothing is listening on the socket', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk-'));
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    const dead = path.join(dir, 'api.sock'); // never created

    expect(
      await runHook('claude-status-hook.mjs', ['idle', '1'], {
        CLAUDE_PROJECT_DIR: '/tmp/wt-b',
        STRADO_SERVER_SOCKET: dead,
      }),
    ).toBe(0);
    expect(
      await runHook(
        'codex-notify-hook.mjs',
        ['1', '/tmp/wt-b', JSON.stringify({ type: 'agent-turn-complete' })],
        { STRADO_SERVER_SOCKET: dead },
      ),
    ).toBe(0);
  });

  it('the opencode plugin posts over the socket, not the port', async () => {
    const viaSocket: Hit[] = [];
    const viaPort: Hit[] = [];
    const socketPath = await listenOnSocket(viaSocket);
    const port = await listenOnPort(viaPort);

    const before = { ...process.env };
    cleanups.push(() => {
      process.env = before;
    });
    process.env.STRADO_STATUS_PORT = String(port);
    process.env.STRADO_WORKTREE = '/tmp/wt-a';
    process.env.STRADO_SESSION_ID = '4';
    process.env.STRADO_SERVER_SOCKET = socketPath;

    const { StradoStatus } = await import('../../hooks/strado-opencode-status.js');
    const plugin = await StradoStatus();
    await plugin['chat.message']();
    await plugin.event({ event: { type: 'session.idle' } });

    expect(viaSocket).toEqual([
      { url: '/api/opencode/status', body: { cwd: '/tmp/wt-a', status: 'working', sessionId: '4' } },
      { url: '/api/opencode/status', body: { cwd: '/tmp/wt-a', status: 'waiting', sessionId: '4' } },
    ]);
    expect(viaPort).toEqual([]);
  });
});
