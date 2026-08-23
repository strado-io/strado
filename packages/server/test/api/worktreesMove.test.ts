import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let home: string;
let unmanagedWt: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const enc = (p: string) => encodeURIComponent(p);

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-move-')));
  repo = path.join(tmp, 'repo');
  home = path.join(tmp, 'home');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'pkg.json'), '{}');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  // The scattered case: a worktree in the legacy sibling folder — git lists
  // it, but it is outside the canonical root, so the sidebar hides it.
  unmanagedWt = path.join(tmp, 'repo.worktrees', 'FD-1_hi');
  await fs.mkdir(path.dirname(unmanagedWt), { recursive: true });
  await exec('git', ['-C', repo, 'worktree', 'add', unmanagedWt, '-b', 'FD-1_hi', 'main']);

  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: home });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'r',
      name: 'r',
      path: repo,
      projectSubdir: null,
      startCommand: 'true',
      defaultPort: 9600,
      editor: 'code',
    },
  });
  // Adopt records ticket/port meta for the unmanaged path — the move must
  // carry this along, so seed it up front.
  await app.inject({
    method: 'POST',
    url: `/api/w/default/worktrees/${enc(unmanagedWt)}/adopt`,
    payload: { repoId: 'r', ticketId: 'FD-1', title: 'hi', port: 9611 },
  });
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const canonical = () => path.join(home, 'worktrees', 'r', 'FD-1_hi');

describe('GET /worktrees/unmanaged', () => {
  it('lists worktrees outside the canonical root, never the checkout itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees/unmanaged' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().worktrees as { path: string; repoId: string; branch: string | null }[];
    expect(rows).toEqual([{ repoId: 'r', repoName: 'r', path: unmanagedWt, branch: 'FD-1_hi' }]);
  });

  it('does not list worktrees already in the managed folder', async () => {
    await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(unmanagedWt)}/move` });
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees/unmanaged' });
    expect(res.json().worktrees).toEqual([]);
  });
});

describe('POST /worktrees/:encodedPath/move', () => {
  it('moves the checkout, rekeys state meta, and the row becomes owned', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(unmanagedWt)}/move` });
    expect(res.statusCode).toBe(200);
    // 'none' — this test box's worktree has no Claude conversations to carry.
    expect(res.json()).toEqual({ path: canonical(), chatHistory: 'none' });

    // git's registry followed the move.
    const { stdout } = await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
    expect(stdout).toContain(canonical());
    expect(stdout).not.toContain(unmanagedWt);

    // The sidebar now shows it, with the adopted meta intact at the new key.
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = (list.json().worktrees as { path: string; tracked: boolean; meta: { ticketId?: string; port?: number } | null }[])
      .find((w) => w.path === canonical());
    expect(row).toBeTruthy();
    expect(row!.tracked).toBe(true);
    expect(row!.meta?.ticketId).toBe('FD-1');
    expect(row!.meta?.port).toBe(9611);

    // And the worktree is genuinely operable there — the old path is not.
    const stores = await app.deps.registry.get('default');
    expect(await stores.state.get(unmanagedWt)).toBeNull();
  });

  it('refuses a worktree already in the managed folder', async () => {
    await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(unmanagedWt)}/move` });
    const again = await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(canonical())}/move` });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toMatch(/already in the managed folder/);
  });

  it('refuses the repo checkout itself', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(repo)}/move` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/repo checkout/);
  });

  it('404s a path no repo registry lists — arbitrary directories cannot be moved', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(path.join(tmp, 'not-a-worktree'))}/move` });
    expect(res.statusCode).toBe(404);
  });

  it('refuses while a terminal session is live on the worktree', async () => {
    const real = app.deps.terminal.liveSessions;
    app.deps.terminal.liveSessions = (() =>
      [{ path: unmanagedWt }] as unknown as ReturnType<typeof real>) as typeof real;
    try {
      const res = await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(unmanagedWt)}/move` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('WORKTREE_HAS_SESSIONS');
    } finally {
      app.deps.terminal.liveSessions = real;
    }
  });

  it('refuses when the destination already exists', async () => {
    await fs.mkdir(canonical(), { recursive: true });
    const res = await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(unmanagedWt)}/move` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/destination already exists/);
  });
});
