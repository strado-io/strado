import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let worktreesDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let worktree: string;
let baseUrl: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-runcmd-')));
  repo = path.join(tmp, 'repo');
  worktreesDir = path.join(tmp, 'home', 'worktrees', 'r');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'pkg.json'), '{}');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  worktree = path.join(worktreesDir, 'FD-1_hi');
  await exec('git', ['-C', repo, 'worktree', 'add', worktree, '-b', 'FD-1_hi', 'main']);
  await fs.writeFile(
    path.join(worktree, 'server.js'),
    "const p=process.env.PORT;console.log('serve on http://localhost:'+p);setInterval(()=>{},1e6);",
  );

  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'r',
      name: 'r',
      path: repo,
      projectSubdir: null,
      startCommand: 'node server.js',
      defaultPort: 9500,
      editor: 'code',
    },
  });
  await app.inject({
    method: 'POST',
    url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/adopt`,
    payload: { repoId: 'r', ticketId: 'FD-1', title: 'hi', port: 9561 },
  });
  await fs.writeFile(path.join(worktree, 'api.js'), "console.log('api up port=['+(process.env.PORT||'')+'] db='+process.env.DB_URL);setInterval(()=>{},1e6);");
  await fs.writeFile(path.join(worktree, '.env.api'), 'DB_URL=postgres://local\n');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/stop`, payload: { runId: 'api' } }).catch(() => undefined);
  await app
    .inject({ method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/stop` })
    .catch(() => undefined);
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

// Named run commands: several per worktree, each in its own Run terminal; the
// first is the default (port, PORT, proxy). They replaced env profiles.
const enc = () => encodeURIComponent(worktree);
const url = (what: string) => `/api/w/default/worktrees/${enc()}/${what}`;
const post = (what: string, payload?: unknown) => app.inject({ method: 'POST', url: url(what), ...(payload ? { payload } : {}) });
const status = async (runId?: string) => (await app.inject({ method: 'GET', url: url(`status${runId ? `?runId=${runId}` : ''}`) })).json();
const putRuns = (runCommands: unknown) => app.inject({ method: 'PUT', url: '/api/w/default/repos/r/run-commands', payload: { runCommands } });

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 10_000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await pred()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout');
}


describe('run commands on the repo', () => {
  it('an old repo serves one "dev" from its start command', async () => {
    const repos = (await app.inject({ method: 'GET', url: '/api/w/default/repos' })).json().repos;
    expect(repos[0].runCommands).toEqual([{ id: 'dev', name: 'dev', command: 'node server.js' }]);
  });

  it('PUT replaces the list, minting missing ids; startCommand follows the first', async () => {
    const res = await putRuns([{ name: 'Web App', command: 'node server.js' }, { name: 'api', command: 'node api.js', envFile: '.env.api' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().runCommands).toEqual([
      { id: 'web-app', name: 'Web App', command: 'node server.js' },
      { id: 'api', name: 'api', command: 'node api.js', envFile: '.env.api' },
    ]);
    const repo = (await app.inject({ method: 'GET', url: '/api/w/default/repos' })).json().repos[0];
    expect(repo.startCommand).toBe('node server.js');
  });

  it.each([
    ['name_required', [{ name: ' ', command: 'x' }], 0],
    ['command_required', [{ name: 'a', command: 'x' }, { name: 'b', command: '' }], 1],
    ['name_taken', [{ name: 'api', command: 'x' }, { name: 'API', command: 'y' }], 1],
  ])('rejects %s, naming the row', async (reason, list, index) => {
    const res = await putRuns(list);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION', details: { reason, index } });
  });

  it('the env-profile route is gone', async () => {
    expect((await post('env-profile', { profile: 'x' })).statusCode).toBe(404);
  });
});

describe('running them', () => {
  beforeEach(async () => {
    expect((await putRuns([{ id: 'dev', name: 'dev', command: 'node server.js' }, { id: 'api', name: 'api', command: 'node api.js', envFile: '.env.api' }])).statusCode).toBe(200);
  });

  it('Run with no runId is the default: the worktree port, as before', async () => {
    expect((await post('start')).statusCode).toBe(200);
    await waitFor(async () => (await status()).status === 'running');
    expect(await status()).toMatchObject({ runId: 'dev', name: 'dev', port: 9561, detectedUrl: 'http://localhost:9561' });
  });

  it('another runs alongside it, in its own terminal: no PORT, its env file injected', async () => {
    await post('start');
    const res = await post('start', { runId: 'api' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runId: 'api', name: 'api', status: 'running', port: null, tab: 'run' });
    await waitFor(() => app.deps.terminal.snapshot(`${worktree}\0run:api`).includes('api up'));
    expect(app.deps.terminal.snapshot(`${worktree}\0run:api`)).toContain('api up port=[] db=postgres://local');
    await waitFor(async () => (await status()).status === 'running');
    const listing = (await app.inject({ method: 'GET', url: '/api/w/default/worktrees' })).json();
    const wt = (listing.worktrees ?? listing).find((w: { path: string }) => w.path === worktree);
    expect(wt.process).toMatchObject({ runId: 'dev' });
    expect(wt.runs.map((r: { runId: string }) => r.runId)).toEqual(['dev', 'api']);
    expect((await post('stop', { runId: 'api' })).statusCode).toBe(204);
    expect((await status('api')).status).toBe('stopped');
    expect((await status()).status).toBe('running');
  });

  it('an unknown run is a 404', async () => {
    expect((await post('start', { runId: 'nope' })).statusCode).toBe(404);
  });

  it('a worktree start-command override replaces only the default', async () => {
    await app.inject({ method: 'PATCH', url: `/api/w/default/worktrees/${enc()}`, payload: { startCommand: 'node api.js' } });
    await post('start');
    await waitFor(() => app.deps.terminal.snapshot(`${worktree}\0run`).includes('api up'));
    expect(app.deps.terminal.snapshot(`${worktree}\0run`)).toContain('port=[9561]');
  });

  it('/ws/run?run=api attaches to that run', async () => {
    await post('start', { runId: 'api' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/run?ws=default&path=${enc()}&run=api`);
    let text = '';
    ws.on('message', (d) => { text += d.toString(); });
    await waitFor(() => text.includes('api up'));
    ws.close();
  });
});
