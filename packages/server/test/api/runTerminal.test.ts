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
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-run-')));
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
    payload: { repoId: 'r', ticketId: 'FD-1', title: 'hi', port: 9557 },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await app
    .inject({ method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/stop` })
    .catch(() => undefined);
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

// Run in a real terminal: the start command's output is the worktree's Run
// tab (/ws/run), not a log panel. Attaching never starts anything.
const enc = () => encodeURIComponent(worktree);
const post = (what: string) => app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc()}/${what}` });
const status = async () => (await app.inject({ method: 'GET', url: `/api/w/default/worktrees/${enc()}/status` })).json();

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 10_000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await pred()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout');
}

function attach(query = `ws=default&path=${enc()}&cols=100&rows=30`) {
  const ws = new WebSocket(`${baseUrl}/ws/run?${query}`);
  const got = { text: '', closed: false, code: 0 };
  ws.on('message', (d) => { got.text += d.toString(); });
  ws.on('close', (code) => { got.closed = true; got.code = code; });
  const open = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return { ws, got, open };
}

describe('the Run terminal (/ws/run)', () => {
  it('Run starts the command in a terminal; the tab streams its output and takes input', async () => {
    expect((await post('start')).statusCode).toBe(200);
    expect(await status()).toMatchObject({ tab: 'run' });
    const { ws, got, open } = attach();
    await open;
    await waitFor(() => got.text.includes('serve on http://localhost:9557'));
    ws.send(JSON.stringify({ type: 'data', data: 'typed-in-tab' }));
    await waitFor(() => got.text.includes('typed-in-tab')); // the tty echoes it: it reached the program's terminal
    await waitFor(async () => (await status()).status === 'running');
    ws.close();
  });

  it('the log routes still work, fed from the terminal', async () => {
    await post('start');
    await waitFor(async () => (await status()).status === 'running');
    const logs = (await app.inject({ method: 'GET', url: `/api/w/default/worktrees/${enc()}/logs?tail=50` })).json();
    expect(logs.lines).toContain('serve on http://localhost:9557');
  });

  it('Stop ends it; a tab attached after shows the last output and how it ended, and stays open', async () => {
    await post('start');
    await waitFor(async () => (await status()).status === 'running');
    expect((await post('stop')).statusCode).toBe(204);
    expect((await status()).status).toBe('stopped');
    const { ws, got, open } = attach();
    await open;
    await waitFor(() => got.text.includes('[process exited'));
    expect(got.text).toContain('serve on http://localhost:9557');
    await new Promise((r) => setTimeout(r, 200));
    expect(got.closed).toBe(false);
    ws.close();
  });

  it('a live tab hears the end and stays open', async () => {
    await post('start');
    const { ws, got, open } = attach();
    await open;
    await waitFor(() => got.text.includes('serve on'));
    await post('stop');
    await waitFor(() => got.text.includes('[process exited'));
    expect(got.closed).toBe(false);
    ws.close();
  });

  it('the next Run hands the tab over: close code 4000, then a fresh attach sees the new run', async () => {
    await post('start');
    await waitFor(async () => (await status()).status === 'running');
    await post('stop');
    const { got, open } = attach();
    await open;
    await post('start');
    await waitFor(() => got.closed);
    expect(got.code).toBe(4000);
  });

  it('nothing ever ran: a notice, then it closes; it does not start anything', async () => {
    const { got, open } = attach();
    await open;
    await waitFor(() => got.closed);
    expect(got.text).toMatch(/Run/);
    expect(got.code).toBe(4404); // final: the tab stops reconnecting
    expect((await status()).status).toBe('idle');
  });

  it('refuses a path no repo owns', async () => {
    const { got, open } = attach(`ws=default&path=${encodeURIComponent('/etc')}`);
    await open;
    await waitFor(() => got.closed);
    expect(got.text).toMatch(/no repo owns/);
    expect(got.code).toBe(4404);
  });
});

describe('after the run, the tab is a shell', () => {
  const del = (q = '') => app.inject({ method: 'DELETE', url: `/api/w/default/worktrees/${enc()}/run-tab${q}` });
  const startWith = (payload?: unknown) => app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc()}/start`, ...(payload ? { payload } : {}) });

  it('Stop → the same socket shows the exit line, then a shell you can type in (no reconnect)', async () => {
    await post('start');
    const { ws, got, open } = attach();
    await open;
    await waitFor(() => got.text.includes('serve on'));
    await post('stop');
    await waitFor(() => got.text.includes('[process exited with code'));
    expect((await status()).status).toBe('stopped');
    ws.send(JSON.stringify({ type: 'data', data: 'echo "hi-[$PORT]"\r' }));
    await waitFor(() => got.text.includes('hi-[]'), 20_000);
    expect(got.closed).toBe(false);
    ws.close();
  }, 30_000);

  it('Run again: an idle shell is replaced; a busy one is refused (run_tab_busy) unless forced', async () => {
    await post('start');
    await waitFor(async () => (await status()).status === 'running');
    await post('stop');
    const { ws, got, open } = attach();
    await open;
    // Output, not the tty's echo of what was typed: the shell is up and reading.
    ws.send(JSON.stringify({ type: 'data', data: 'echo $((6*7))-ready\r' }));
    await waitFor(() => got.text.includes('42-ready'), 20_000);
    expect(await app.deps.proc.runTabBusy(worktree)).toBe(false);
    ws.send(JSON.stringify({ type: 'data', data: 'sleep 30\r' }));
    await waitFor(async () => app.deps.proc.runTabBusy(worktree));
    const refused = await startWith();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toMatchObject({ reason: 'run_tab_busy' });
    expect((await startWith({ force: true })).statusCode).toBe(200);
    await waitFor(async () => (await status()).status === 'running');
    ws.close();
  }, 40_000);

  it('closing the tab: refused while the run is live; after it, the shell is killed and the tab forgotten', async () => {
    await post('start');
    const live = await del();
    expect(live.statusCode).toBe(409);
    expect(live.json().error.details).toMatchObject({ reason: 'running' });
    await post('stop');
    expect((await del()).statusCode).toBe(204);
    expect((await status()).tab).toBeNull();
    await waitFor(() => app.deps.terminal.status(`${worktree}\0run`).status === 'exited');
  });
});
