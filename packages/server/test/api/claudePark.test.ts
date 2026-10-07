import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';
import { claudeKey, createTerminalManager, type SpawnSpec } from '../../src/services/terminalManager';
import { PARK_BANNER } from '../../src/services/claudePark';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let deps: Awaited<ReturnType<typeof buildDeps>>;
let baseUrl: string;
let spawned: SpawnSpec[];

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-park-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await fs.mkdir(path.join(tmp, 'home', 'worktrees', 'react-app'), { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['-c', 'user.email=x@y.z', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo });

  deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  spawned = [];
  // Record what WOULD have been spawned, then run `cat` instead of claude.
  deps.terminal = createTerminalManager(
    () => ({ file: 'claude', args: [] }),
    undefined,
    undefined,
    (_cwd, spec) => { spawned.push(spec); return { file: 'cat', args: [] }; },
  );
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: { id: 'react-app', name: 'React App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 9100, editor: 'code' },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const park = (sessionId = '1') =>
  deps.parked.add({ path: repo, sessionId, providerSessionId: 'conv-123', parkedAt: new Date().toISOString() });

function connect(extra = ''): Promise<{ ws: WebSocket; text: () => string; closed: Promise<void> }> {
  const ws = new WebSocket(`${baseUrl}/ws/terminal?ws=default&path=${encodeURIComponent(repo)}${extra}`);
  let acc = '';
  ws.on('message', (d) => { acc += d.toString(); });
  const closed = new Promise<void>((r) => ws.once('close', () => r()));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, text: () => acc, closed }));
    ws.once('error', reject);
  });
}

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
}

async function row() {
  const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
  return res.json().worktrees.find((w: { path: string }) => w.path === repo);
}

describe('parked Claude tabs', () => {
  it('keeps a parked tab listed and flagged', async () => {
    park('2');
    const r = await row();
    expect(r.claudeSessions).toEqual(['2']);
    expect(r.parkedClaudeSessions).toEqual(['2']);
    expect(r.hasClaudeSession).toBe(true);
  });

  it('a plain attach gets the parked notice and spawns nothing', async () => {
    park();
    const c = await connect();
    await c.closed;
    expect(c.text()).toContain(PARK_BANNER);
    expect(spawned).toEqual([]);
    expect(deps.terminal.status(claudeKey(repo, '1')).status).not.toBe('running');
  });

  it('resume=1 reopens the same conversation and un-parks the tab', async () => {
    park();
    const c = await connect('&resume=1');
    await until(() => spawned.length > 0);
    expect(spawned[0]!.args.join(' ')).toContain("claude --resume 'conv-123'");
    expect(deps.parked.get(claudeKey(repo, '1'))).toBeNull();
    const r = await row();
    expect(r.parkedClaudeSessions).toEqual([]);
    expect(r.claudeSessions).toEqual(['1']);
    c.ws.close();
  });

  it('waking a tab parked while empty starts a fresh Claude', async () => {
    deps.parked.add({ path: repo, sessionId: '1', parkedAt: new Date().toISOString() });
    const plain = await connect();
    await plain.closed;
    expect(plain.text()).toContain('start Claude again');
    const c = await connect('&resume=1');
    await until(() => spawned.length > 0);
    expect(spawned[0]).toEqual({ file: 'claude', args: [] }); // the default spec, no --resume
    expect(deps.parked.get(claudeKey(repo, '1'))).toBeNull();
    c.ws.close();
  });

  it('an attached pane is told the session was parked, not that it exited', async () => {
    const c = await connect();
    await until(() => spawned.length > 0);
    park();
    deps.terminal.kill(claudeKey(repo, '1'));
    await c.closed;
    expect(c.text()).toContain(PARK_BANNER);
    expect(c.text()).not.toContain('[process exited');
  });

  it('closing a parked tab forgets it', async () => {
    park('2');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/sessions/claude?id=2`,
    });
    expect(res.statusCode).toBe(204);
    expect(deps.parked.get(claudeKey(repo, '2'))).toBeNull();
    expect((await row()).claudeSessions).toEqual([]);
  });

  it('survives a restart through the parked-sessions file', async () => {
    park('3');
    await until(() => false, 100); // let the async write land
    const { createParkStore } = await import('../../src/services/claudePark');
    const reloaded = createParkStore(path.join(tmp, 'home', 'parked-sessions.json'));
    expect(reloaded.idsFor(repo)).toEqual(['3']);
  });
});
