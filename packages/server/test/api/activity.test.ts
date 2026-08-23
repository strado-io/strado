import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-act-')));
  repo = path.join(tmp, 'repo');
  const worktreesDir = path.join(tmp, 'home', 'worktrees', 'r');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'f'), '1');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'r', name: 'R', path: repo,
      projectSubdir: null, startCommand: 'true', defaultPort: 9100, editor: 'code',
    },
  });
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('POST /api/activity/beat', () => {
  it('accepts a known worktree path and beats its activity clock', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/activity/beat',
      payload: { path: repo },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // First beat opens the window; a later beat accrues from it.
    await new Promise((r) => setTimeout(r, 20));
    await app.inject({ method: 'POST', url: '/api/activity/beat', payload: { path: repo } });
    expect(app.deps.activity.get(repo)).toBeGreaterThanOrEqual(0);
  });

  it('rejects a path no repo owns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/activity/beat',
      payload: { path: '/etc' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('activitySeconds shows up on the worktrees listing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = res.json().worktrees.find((w: any) => w.path === repo);
    expect(row.activitySeconds).toBe(0);
  });
});

describe('DELETE /api/activity/:encodedPath', () => {
  it('zeroes tracked time and emits a worktree update', async () => {
    const events: any[] = [];
    app.deps.bus.on('worktrees', (e) => events.push(e));
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/activity/${encodeURIComponent(repo)}`,
    });
    expect(res.statusCode).toBe(204);
    expect(app.deps.activity.get(repo)).toBe(0);
    expect(events).toContainEqual({
      type: 'worktree.updated',
      data: { path: repo, activitySeconds: 0 },
    });
  });

  it('rejects a path no repo owns', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/activity/${encodeURIComponent('/etc')}` });
    expect(res.statusCode).toBe(404);
  });
});
