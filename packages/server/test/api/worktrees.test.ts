import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let worktreesDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-wt-')));
  repo = path.join(tmp, 'repo');
  worktreesDir = path.join(tmp, 'home', 'worktrees', 'react-app');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'pkg.json'), '{}');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  app = await buildApp(deps);

  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'react-app',
      name: 'React App',
      path: repo,
      projectSubdir: null,
      startCommand: 'true',
      defaultPort: 9100,
      editor: 'code',
    },
  });
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/w/default/worktrees', () => {
  it('lists the main worktree initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.worktrees)).toBe(true);
    const main = body.worktrees.find((w: any) => w.path === repo);
    expect(main).toBeTruthy();
    expect(main.repoId).toBe('react-app');
    // The repo's main worktree is auto-adopted (tracked) with an empty
    // ticketId so its Settings work without a manual Adopt step.
    expect(main.tracked).toBe(true);
    expect(main.meta.ticketId).toBe('');
  });

  it('excludes worktrees outside the Strado-managed root', async () => {
    const managed = path.join(worktreesDir, 'STR-16_managed');
    const claude = path.join(tmp, '.claude', 'worktrees', 'claude-task');
    const codex = path.join(tmp, '.codex', 'worktrees', 'codex-task');
    await fs.mkdir(path.dirname(claude), { recursive: true });
    await fs.mkdir(path.dirname(codex), { recursive: true });
    await exec('git', ['-C', repo, 'worktree', 'add', managed, '-b', 'strado-task', 'main']);
    await exec('git', ['-C', repo, 'worktree', 'add', claude, '-b', 'claude-task', 'main']);
    await exec('git', ['-C', repo, 'worktree', 'add', codex, '-b', 'codex-task', 'main']);

    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    expect(res.statusCode).toBe(200);
    const paths = res.json().worktrees.map((w: { path: string }) => w.path);
    expect(paths).toContain(repo);
    expect(paths).toContain(managed);
    expect(paths).not.toContain(claude);
    expect(paths).not.toContain(codex);
  });

  it('does not expose endpoints for discovering or importing external worktrees', async () => {
    const unmanaged = await app.inject({ method: 'GET', url: '/api/w/default/worktrees/unmanaged' });
    const move = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(path.join(tmp, 'external'))}/move`,
    });
    expect(unmanaged.statusCode).toBe(404);
    expect(move.statusCode).toBe(404);
  });
});

describe('POST /api/w/default/worktrees', () => {
  it('creates a worktree, links node_modules, writes state', async () => {
    await fs.mkdir(path.join(repo, 'node_modules', 'lodash'), { recursive: true });
    await fs.writeFile(path.join(repo, 'package-lock.json'), '{"v":1}');

    const create = await app.inject({
      method: 'POST',
      url: '/api/w/default/worktrees',
      payload: {
        repoId: 'react-app',
        ticketId: 'FD-1',
        title: 'Test feature',
        sourceBranch: 'main',
        sourceWorktree: repo,
        env: {},
      },
    });
    expect(create.statusCode).toBe(202);
    const { jobId } = create.json();

    const final = await app.deps.jobs.wait(jobId);
    expect(final.status).toBe('done');

    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    // the main worktree is now auto-adopted too, so match the created one by id
    const tracked = list.json().worktrees.find((w: any) => w.meta?.ticketId === 'FD-1');
    expect(tracked.meta.ticketId).toBe('FD-1');
    expect(tracked.path).toContain('FD-1_Test_feature');

    const linkPath = path.join(tracked.path, 'node_modules');
    const stat = await fs.lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('rejects invalid ticket id with VALIDATION job error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/worktrees',
      payload: {
        repoId: 'react-app',
        ticketId: 'bad-id',
        title: 'x',
        sourceBranch: 'main',
        sourceWorktree: repo,
      },
    });
    expect(res.statusCode).toBe(202);
    const final = await app.deps.jobs.wait(res.json().jobId);
    expect(final.status).toBe('error');
  });
});

describe('DELETE /api/w/default/worktrees/:encodedPath', () => {
  it('removes worktree, unlinks symlink, clears state', async () => {
    await fs.mkdir(path.join(repo, 'node_modules', 'a'), { recursive: true });
    await fs.writeFile(path.join(repo, 'package-lock.json'), '{}');

    const create = await app.inject({
      method: 'POST',
      url: '/api/w/default/worktrees',
      payload: {
        repoId: 'react-app',
        ticketId: 'FD-2',
        title: 'delete me',
        sourceBranch: 'main',
        sourceWorktree: repo,
      },
    });
    await app.deps.jobs.wait(create.json().jobId);

    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const target = list.json().worktrees.find((w: any) => w.meta?.ticketId === 'FD-2').path;
    const encoded = encodeURIComponent(target);

    const del = await app.inject({ method: 'DELETE', url: `/api/w/default/worktrees/${encoded}` });
    expect(del.statusCode).toBe(202);
    const final = await app.deps.jobs.wait(del.json().jobId);
    expect(final.status).toBe('done');

    await expect(fs.stat(target)).rejects.toThrow();
    const defaultStores = await app.deps.registry.get('default');
    expect(await defaultStores.state.get(target)).toBeNull();
  });

  it('drops the sandbox identity as soon as the container is gone, even if the rest of the delete fails', async () => {
    await fs.mkdir(path.join(repo, 'node_modules', 'a'), { recursive: true });
    await fs.writeFile(path.join(repo, 'package-lock.json'), '{}');

    const create = await app.inject({
      method: 'POST',
      url: '/api/w/default/worktrees',
      payload: {
        repoId: 'react-app',
        ticketId: 'FD-3',
        title: 'sandboxed',
        sourceBranch: 'main',
        sourceWorktree: repo,
      },
    });
    const created = await app.deps.jobs.wait(create.json().jobId);
    expect(created.status, JSON.stringify(created)).toBe('done');
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const target = list.json().worktrees.find((w: any) => w.meta?.ticketId === 'FD-3').path;

    // Make it look like a runner's sandboxed worktree (this box has no
    // container runtime, so creation left meta.sandbox null).
    const stores = await app.deps.registry.get('default');
    await stores.state.patch(target, { sandbox: { slug: 'sandboxed-deadbeef' } });
    app.deps.sandboxSlugs.set(target, 'sandboxed-deadbeef');
    const removed: string[] = [];
    app.deps.sandbox = {
      containerName: (slug: string) => `strado-sbx-${slug}`,
      envFilePath: (slug: string) => path.join(tmp, `${slug}.env`),
      create: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      remove: async (slug: string) => { removed.push(slug); },
      worktreeOf: async () => target,
      status: async () => 'running' as const,
      listRunning: async () => [],
    };
    // A dirty worktree makes `git worktree remove` throw — the delete fails
    // AFTER the container is already gone.
    app.deps.git.remove = async () => {
      throw new Error('worktree contains modified or untracked files');
    };

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/w/default/worktrees/${encodeURIComponent(target)}`,
    });
    const final = await app.deps.jobs.wait(del.json().jobId);
    expect(final.status).toBe('error');
    expect(removed).toEqual(['sandboxed-deadbeef']);

    // The worktree is still tracked (nothing removed it) — but it must no
    // longer claim a container, or every terminal in it fails forever and a
    // restart re-hydrates the dead slug.
    expect((await stores.state.get(target))?.sandbox ?? null).toBeNull();
    expect(app.deps.sandboxSlugs.slugOf(target)).toBeNull();
    expect(app.deps.sandboxSlugs.slugOf(path.join(target, 'apps', 'web'))).toBeNull();
  });
});

describe('PATCH + adopt', () => {
  it('patches port and adopts untracked worktrees', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'untracked'), '-b', 'untracked', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const untracked = list.json().worktrees.find((w: any) => w.branch === 'untracked');
    expect(untracked.tracked).toBe(false);

    const encoded = encodeURIComponent(untracked.path);
    const adopt = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encoded}/adopt`,
      payload: { repoId: 'react-app', ticketId: 'FD-9', title: 'adopted', port: 9200 },
    });
    expect(adopt.statusCode).toBe(200);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/w/default/worktrees/${encoded}`,
      payload: { port: 9300 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().port).toBe(9300);
  });

  it('PATCH with note auto-adopts an untracked worktree', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'FD-77_thing'), '-b', 'FD-77_thing', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const wt = list.json().worktrees.find((w: any) => w.branch === 'FD-77_thing');
    expect(wt.tracked).toBe(false);
    const encoded = encodeURIComponent(wt.path);
    const res = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { note: 'adopted by patch' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toBe('adopted by patch');
    const after = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = after.json().worktrees.find((w: any) => w.path === wt.path);
    expect(row.tracked).toBe(true);
    expect(row.meta.note).toBe('adopted by patch');
    expect(row.meta.ticketId).toBe('FD-77');
  });

  it('PATCH accepts and clears workflowStatus', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'FD-50_ws'), '-b', 'FD-50_ws', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const wt = list.json().worktrees.find((w: any) => w.branch === 'FD-50_ws');
    const encoded = encodeURIComponent(wt.path);
    await app.inject({
      method: 'POST', url: `/api/w/default/worktrees/${encoded}/adopt`,
      payload: { repoId: 'react-app', ticketId: 'FD-50', title: 'ws' },
    });
    const set = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { workflowStatus: 'ready_for_qa' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().workflowStatus).toBe('ready_for_qa');

    const cleared = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { workflowStatus: null },
    });
    expect(cleared.json().workflowStatus).toBeNull();
  });

  it('rejects an invalid workflowStatus', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'FD-51_bad'), '-b', 'FD-51_bad', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const wt = list.json().worktrees.find((w: any) => w.branch === 'FD-51_bad');
    const encoded = encodeURIComponent(wt.path);
    const res = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { workflowStatus: 'shipped' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH with workflowStatus auto-adopts an untracked worktree', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'FD-52_auto'), '-b', 'FD-52_auto', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const wt = list.json().worktrees.find((w: any) => w.branch === 'FD-52_auto');
    expect(wt.tracked).toBe(false);
    const encoded = encodeURIComponent(wt.path);
    const res = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { workflowStatus: 'in_progress' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().workflowStatus).toBe('in_progress');
    const after = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = after.json().worktrees.find((w: any) => w.path === wt.path);
    expect(row.tracked).toBe(true);
    expect(row.meta.workflowStatus).toBe('in_progress');
    expect(row.meta.ticketId).toBe('FD-52');
  });

  it('PATCH accepts and clears note', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'FD-60_note'), '-b', 'FD-60_note', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const wt = list.json().worktrees.find((w: any) => w.branch === 'FD-60_note');
    const encoded = encodeURIComponent(wt.path);
    await app.inject({
      method: 'POST', url: `/api/w/default/worktrees/${encoded}/adopt`,
      payload: { repoId: 'react-app', ticketId: 'FD-60', title: 'note' },
    });
    const set = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { note: 'fix the dropdown bug' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().note).toBe('fix the dropdown bug');

    const cleared = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { note: null },
    });
    expect(cleared.json().note).toBeNull();
  });

  it('PATCH with note auto-adopts an untracked worktree', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'FD-61_auto'), '-b', 'FD-61_auto', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const wt = list.json().worktrees.find((w: any) => w.branch === 'FD-61_auto');
    expect(wt.tracked).toBe(false);
    const encoded = encodeURIComponent(wt.path);
    const res = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { note: 'needs review' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toBe('needs review');
    const after = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = after.json().worktrees.find((w: any) => w.path === wt.path);
    expect(row.tracked).toBe(true);
    expect(row.meta.note).toBe('needs review');
    expect(row.meta.ticketId).toBe('FD-61');
  });

  it('PATCH accepts and clears order', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'FD-70_ord'), '-b', 'FD-70_ord', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const wt = list.json().worktrees.find((w: any) => w.branch === 'FD-70_ord');
    const encoded = encodeURIComponent(wt.path);
    await app.inject({
      method: 'POST', url: `/api/w/default/worktrees/${encoded}/adopt`,
      payload: { repoId: 'react-app', ticketId: 'FD-70', title: 'ord' },
    });
    const set = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { order: 2.5 },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().order).toBe(2.5);

    const cleared = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { order: null },
    });
    expect(cleared.json().order).toBeNull();
  });

  it('PATCH with order auto-adopts an untracked worktree', async () => {
    await exec('git', ['-C', repo, 'worktree', 'add', path.join(worktreesDir, 'FD-71_auto'), '-b', 'FD-71_auto', 'main']);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const wt = list.json().worktrees.find((w: any) => w.branch === 'FD-71_auto');
    expect(wt.tracked).toBe(false);
    const encoded = encodeURIComponent(wt.path);
    const res = await app.inject({
      method: 'PATCH', url: `/api/w/default/worktrees/${encoded}`,
      payload: { order: 1.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().order).toBe(1.5);
    const after = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = after.json().worktrees.find((w: any) => w.path === wt.path);
    expect(row.tracked).toBe(true);
    expect(row.meta.order).toBe(1.5);
    expect(row.meta.ticketId).toBe('FD-71');
  });

  it('upload writes an image under .strado-uploads and returns its path', async () => {
    const dataBase64 = Buffer.from('hello').toString('base64');
    const res = await app.inject({
      method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/upload`,
      payload: { name: 'shot 1.png', dataBase64 },
    });
    expect(res.statusCode).toBe(200);
    const { path: saved } = res.json();
    const fsp = await import('node:fs/promises');
    expect(saved.includes(`${path.sep}.strado-uploads${path.sep}`)).toBe(true);
    expect(saved.endsWith('shot_1.png')).toBe(true);
    expect(await fsp.readFile(saved, 'utf8')).toBe('hello');
    const exclude = await fsp.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').some((l) => l.trim() === '.strado-uploads/')).toBe(true);
  });

  it('upload rejects a file over 10MB', async () => {
    const dataBase64 = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    const res = await app.inject({
      method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/upload`,
      payload: { name: 'big.png', dataBase64 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('upload 404s for a path no repo owns', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent('/etc')}/upload`,
      payload: { name: 'x.png', dataBase64: Buffer.from('x').toString('base64') },
    });
    expect(res.statusCode).toBe(404);
  });

  it('upload rejects a path-traversal target (..)', async () => {
    // Use a raw un-normalized string with .. embedded so it passes the literal
    // startsWith(worktreesDir + sep) check but resolves outside the allowed roots
    // when path.resolve collapses the .. segments.
    const evil = worktreesDir + path.sep + '..' + path.sep + '..' + path.sep + 'evil-upload-target';
    const res = await app.inject({
      method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent(evil)}/upload`,
      payload: { name: 'x.png', dataBase64: Buffer.from('x').toString('base64') },
    });
    // assertPathUnder fires (after the owning-repo check passes the raw string)
    // and returns PATH_FORBIDDEN → 403. Pin the wire contract here, once, for
    // every PATH_FORBIDDEN call site: toResponse strips details for this code,
    // but nothing exercises setErrorHandler's serialized JSON except this test —
    // errors.test.ts only checks toResponse in isolation.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toContain(worktreesDir);
  });
});
