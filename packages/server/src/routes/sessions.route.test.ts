// System-wide session view for Settings → Sessions: every live pty the daemon
// holds with its process-tree CPU/memory, plus a kill that works by manager
// key (so orphans from deleted worktrees — no owning repo — can still be
// ended, unlike the per-worktree DELETE).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
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
    // The embedded VS Code is gone, and its rows with it.
    expect(body.app.vscode).toBeUndefined();
    expect(body.vscodeWindows).toBeUndefined();
    const row = body.sessions.find((s: { key: string }) => s.key === `${orphan}\0shell`);
    expect(row).toMatchObject({ path: orphan, mode: 'shell', id: '1' });
    expect(row.pid).toBeGreaterThan(0);
    expect(row.processes).toBeGreaterThanOrEqual(1);
    expect(row.rssBytes).toBeGreaterThan(0);
  }, 20_000);
});

describe('GET /api/sessions/metrics: language servers', () => {
  it("lists the LSP manager's running servers with their process-tree usage", async () => {
    await app.close();
    const deps = await buildDeps({ configDir: path.join(tmp, 'config2'), homeStateDir: state });
    // A real process of its own, not this test runner, stands in for the server.
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    onTestFinished(() => void child.kill('SIGKILL'));
    const running = [{
      id: 'typescript' as const, lang: 'TypeScript and JavaScript', worktreePath: '/wt/a', pid: child.pid!,
      startedAt: '2026-10-25T10:00:00.000Z', lastUsedAt: '2026-10-25T10:05:00.000Z',
    }];
    const lsp = {
      running: () => running,
      definition: async () => ({ source: 'lsp' as const, hits: [] }),
      references: async () => ({ source: 'lsp' as const, hits: [] }),
      hover: async () => null,
      outline: async () => ({ server: null, symbols: [] as [] }),
      fileWritten: async () => {},
      servers: async () => [],
      setEnabled: async () => {},
      stop: async () => {},
      sweep: async () => {},
      closeAll: async () => {},
    };
    app = await buildApp({ ...deps, lsp });
    const body = (await app.inject({ method: 'GET', url: '/api/sessions/metrics' })).json();
    expect(body.app.languageServers).toEqual([
      expect.objectContaining({ ...running[0], processes: expect.any(Number), rssBytes: expect.any(Number), cpu: expect.any(Number) }),
    ]);
    expect(body.app.languageServers[0].rssBytes).toBeGreaterThan(0);
  });
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

