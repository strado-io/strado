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
let targetPath: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-link-')));
  repo = path.join(tmp, 'repo');
  worktreesDir = path.join(tmp, 'home', 'worktrees', 'r');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'package.json'), '{}');
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{}');
  await fs.mkdir(path.join(repo, 'node_modules'));
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

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
      startCommand: 'true',
      defaultPort: 9400,
      editor: 'code',
    },
  });

  targetPath = path.join(worktreesDir, 'FD-9_thing');
  await exec('git', ['-C', repo, 'worktree', 'add', targetPath, '-b', 'FD-9_thing', 'main']);
  await fs.writeFile(path.join(targetPath, 'package-lock.json'), '{}');
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('linking', () => {
  it('links node_modules', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(targetPath)}/link`,
      payload: { sourceWorktree: repo, replace: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual([]);
  });

  it('unlinks node_modules', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(targetPath)}/link`,
      payload: { sourceWorktree: repo, replace: false },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(targetPath)}/unlink`,
    });
    expect(res.statusCode).toBe(204);
  });

  it('refuses to unlink a real directory', async () => {
    await fs.mkdir(path.join(targetPath, 'node_modules'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(targetPath)}/unlink`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_SYMLINK');
  });
});
