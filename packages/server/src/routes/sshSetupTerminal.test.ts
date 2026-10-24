import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { SSH_SETUP_KEY_PREFIX, SSH_SETUP_ROUTES } from '../services/sshSetup/types.js';
import { createTerminalManager, type TerminalManager } from '../services/terminalManager.js';
import { jobOwnsKey, registerSshSetupTerminalRoutes, sameOrigin } from './sshSetupTerminal.js';

const KEY = `${SSH_SETUP_KEY_PREFIX}job-1`;
let app: FastifyInstance | null = null;
let term: TerminalManager | null = null;
afterEach(async () => { term?.kill(KEY); term = null; await app?.close(); app = null; });

async function serve(owns: (key: string) => boolean): Promise<string> {
  term = createTerminalManager();
  app = Fastify();
  await app.register(websocket);
  await registerSshSetupTerminalRoutes(app, { terminal: term, owns });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  return `ws://127.0.0.1:${port}${SSH_SETUP_ROUTES.terminal}`;
}

type Frame = { type: 'data'; data: string } | { type: 'exit'; code: number | null } | { type: 'error'; message: string };
function collect(url: string, headers: Record<string, string> = {}) {
  const own = new URL(url.replace(/^ws/, 'http')).origin;
  const ws = new WebSocket(url, { headers: { origin: own, ...headers } });
  const frames: Frame[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  return { ws, frames, closed };
}

describe('ssh setup terminal ws', () => {
  it('refuses a key that is not a setup key, or one no live job owns', async () => {
    const url = await serve((k) => k === KEY);
    const other = collect(`${url}?key=${encodeURIComponent('/tmp\0shell:1')}`);
    expect(await other.closed).toBe(4404);
    const unowned = collect(`${url}?key=${encodeURIComponent(`${SSH_SETUP_KEY_PREFIX}job-2`)}`);
    expect(await unowned.closed).toBe(4404);
    expect(unowned.frames).toEqual([{ type: 'error', message: 'not a setup terminal' }]);
  });

  it('refuses a page on another origin or a relayed window', async () => {
    const url = await serve(() => true);
    const foreign = collect(`${url}?key=${encodeURIComponent(KEY)}`, { origin: 'https://evil.example' });
    expect(await foreign.closed).toBe(4403);
    const relayed = collect(`${url}?key=${encodeURIComponent(KEY)}`, { 'x-strado-via': 'relay' });
    expect(await relayed.closed).toBe(4403);
    const otherPort = collect(`${url}?key=${encodeURIComponent(KEY)}`, { origin: 'http://127.0.0.1:5999' });
    expect(await otherPort.closed).toBe(4403);
    const noOrigin = new WebSocket(`${url}?key=${encodeURIComponent(KEY)}`);
    expect(await new Promise<number>((r) => noOrigin.on('close', (c) => r(c)))).toBe(4403);
  });

  it('streams output as data frames, takes input, and ends with a structured exit frame', async () => {
    const url = await serve(() => true);
    await term!.ensure(KEY, '/tmp', { file: '/bin/sh', args: ['-c', 'read x; echo "got:$x"; exit 3'] });
    const c = collect(`${url}?key=${encodeURIComponent(KEY)}&cols=100&rows=30`);
    await new Promise<void>((resolve) => c.ws.on('open', () => resolve()));
    c.ws.send(JSON.stringify({ type: 'data', data: 'hello\r' }));
    expect(await c.closed).toBe(1000);
    const text = c.frames.filter((f) => f.type === 'data').map((f) => (f as { data: string }).data).join('');
    expect(text).toContain('got:hello');
    expect(c.frames.at(-1)).toEqual({ type: 'exit', code: 3 });
  });

  it('a pty that already exited still reports its code to a late attach', async () => {
    const url = await serve(() => true);
    await term!.ensure(KEY, '/tmp', { file: '/bin/sh', args: ['-c', 'echo done; exit 0'] });
    await new Promise<void>((resolve) => { if (term!.status(KEY).status === 'exited') resolve(); else term!.onExit(KEY, () => resolve()); });
    const c = collect(`${url}?key=${encodeURIComponent(KEY)}`);
    expect(await c.closed).toBe(1000);
    expect(c.frames.at(-1)).toEqual({ type: 'exit', code: 0 });
    expect(c.frames.some((f) => f.type === 'data' && f.data.includes('done'))).toBe(true);
  });

  it('jobOwnsKey: only a running ssh-setup job owns its key', () => {
    const jobs = new Map<string, { kind: string; status: string }>([
      ['job-1', { kind: 'ssh-setup', status: 'running' }],
      ['job-2', { kind: 'ssh-setup', status: 'done' }],
      ['job-3', { kind: 'worktree-create', status: 'running' }],
    ]);
    const owns = jobOwnsKey({ get: (id: string) => jobs.get(id) as never });
    expect(owns(`${SSH_SETUP_KEY_PREFIX}job-1`)).toBe(true);
    expect(owns(`${SSH_SETUP_KEY_PREFIX}job-2`)).toBe(false);
    expect(owns(`${SSH_SETUP_KEY_PREFIX}job-3`)).toBe(false);
    expect(owns(`${SSH_SETUP_KEY_PREFIX}nope`)).toBe(false);
    expect(owns('job-1')).toBe(false);
  });

  it('sameOrigin: loopback on the same port only', () => {
    expect(sameOrigin('http://127.0.0.1:7777', '127.0.0.1:7777')).toBe(true);
    expect(sameOrigin('http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(sameOrigin('http://127.0.0.1:5999', '127.0.0.1:7777')).toBe(false);
    expect(sameOrigin('https://evil.example', '127.0.0.1:7777')).toBe(false);
    expect(sameOrigin(undefined, '127.0.0.1:7777')).toBe(false);
    expect(sameOrigin('null', '127.0.0.1:7777')).toBe(false);
  });
});
