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
