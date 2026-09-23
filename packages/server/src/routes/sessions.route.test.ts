// System-wide session view for Settings → Sessions: every live pty the daemon
// holds with its process-tree CPU/memory, plus a kill that works by manager
// key (so orphans from deleted worktrees — no owning repo — can still be
// ended, unlike the per-worktree DELETE).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../app.js';

let tmp: string;
let state: string;
let prevHome: string | undefined;
let prevLicense: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-route-')));
  state = path.join(tmp, 'state');
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = path.join(tmp, 'strado-home');
  await fs.mkdir(process.env.STRADO_HOME, { recursive: true });
  prevLicense = process.env.STRADO_LICENSE_REQUIRED;
  delete process.env.STRADO_LICENSE_REQUIRED;
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: state });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  // The test daemon must not outlive the test.
  try {
    const { pid } = JSON.parse(await fs.readFile(path.join(state, 'ptyd', 'manifest.json'), 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch { /* no daemon spawned */ }
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  if (prevLicense === undefined) delete process.env.STRADO_LICENSE_REQUIRED;
  else process.env.STRADO_LICENSE_REQUIRED = prevLicense;
  await fs.rm(tmp, { recursive: true, force: true });
});

const sh = { file: '/bin/sh', args: ['-c', 'sleep 60'] };

describe('GET /api/sessions/metrics', () => {
  it('lists every live session with its pid and process-tree usage, plus server and daemon', async () => {
    const orphan = path.join(tmp, 'gone-project'); // no repo owns this path
    await app.deps.terminal.ensure(`${orphan}\0shell`, tmp, sh);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sampledAt).toBeGreaterThan(0);
    expect(body.app.server.pid).toBe(process.pid);
    expect(body.app.server.rssBytes).toBeGreaterThan(0);
    // The suite runs the in-process manager (STRADO_INPROC_PTY=1): no daemon.
    expect(body.app.daemon).toBeNull();
    expect(body.app.vscode).toBeNull(); // no workbench in tests
    const row = body.sessions.find((s: { key: string }) => s.key === `${orphan}\0shell`);
    expect(row).toMatchObject({ path: orphan, mode: 'shell', id: '1' });
    expect(row.pid).toBeGreaterThan(0);
    expect(row.processes).toBeGreaterThanOrEqual(1);
    expect(row.rssBytes).toBeGreaterThan(0);
  }, 20_000);
});

describe('DELETE /api/sessions/:key', () => {
  it('kills a live session by manager key even when no repo owns its path', async () => {
    const orphan = path.join(tmp, 'gone-project');
    const key = `${orphan}\0shell`;
    await app.deps.terminal.ensure(key, tmp, sh);
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${encodeURIComponent(key)}` });
    expect(res.statusCode).toBe(204);
    const start = Date.now();
    while (app.deps.terminal.status(key).status === 'running' && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(app.deps.terminal.status(key).status).toBe('exited');
  }, 20_000);

  it('rejects a key that is not a live session', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${encodeURIComponent('/nope\0shell')}` });
    expect(res.statusCode).toBe(404);
  }, 20_000);
});

describe('DELETE /api/sessions/vscode', () => {
  it('stops the shared VS Code workbench (idempotent when none is running)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/sessions/vscode' });
    expect(res.statusCode).toBe(204);
  }, 20_000);
});

describe('VS Code window reports', () => {
  it('POST /api/vscode/window attributes an extension host to a folder; metrics list it; DELETE withdraws it', async () => {
    const folder = path.join(tmp, 'wt-a');
    const post = await app.inject({ method: 'POST', url: '/api/vscode/window', payload: { pid: process.pid, folder } });
    expect(post.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/metrics' });
    const win = res.json().vscodeWindows.find((w: { path: string }) => w.path === folder);
    expect(win).toMatchObject({ pid: process.pid });
    expect(win.rssBytes).toBeGreaterThan(0);
    const del = await app.inject({ method: 'DELETE', url: '/api/vscode/window', payload: { pid: process.pid } });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/sessions/metrics' });
    expect(after.json().vscodeWindows).toEqual([]);
  }, 20_000);

  it('rejects a report without an absolute folder or a numeric pid', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/vscode/window', payload: { pid: 'x', folder: '/a' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/vscode/window', payload: { pid: 1, folder: 'rel' } })).statusCode).toBe(400);
  }, 20_000);
});

describe('closing a VS Code tab ends its window', () => {
  it('DELETE /api/vscode kills the extension-host tree that reported that folder', async () => {
    // VS Code keeps a disconnected window's extension host alive for hours
    // (reconnection grace), so closing the tab alone frees nothing.
    const { spawn } = await import('node:child_process');
    const host = spawn('/bin/sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore' });
    const folder = path.join(tmp, 'wt-close');
    await new Promise((r) => setTimeout(r, 200)); // let the child sleep spawn
    await app.inject({ method: 'POST', url: '/api/vscode/window', payload: { pid: host.pid, folder } });
    const exited = new Promise<void>((r) => host.once('exit', () => r()));
    const res = await app.inject({ method: 'DELETE', url: '/api/vscode', payload: { folder } });
    expect(res.statusCode).toBe(200);
    await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('host still alive')), 3000))]);
    const after = await app.inject({ method: 'GET', url: '/api/sessions/metrics' });
    expect(after.json().vscodeWindows.some((w: { path: string }) => w.path === folder)).toBe(false);
  }, 20_000);
});

describe('dev server usage', () => {
  it('GET /api/sessions/metrics?pids= returns each pid tree, ignoring junk', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/metrics?pids=${process.pid},abc,-3` });
    expect(res.statusCode).toBe(200);
    const procs = res.json().processes;
    expect(procs).toHaveLength(1);
    expect(procs[0].pid).toBe(process.pid);
    expect(procs[0].rssBytes).toBeGreaterThan(0);
  }, 20_000);
});

