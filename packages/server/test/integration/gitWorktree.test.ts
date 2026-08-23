import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { createGitWorktreeService } from '../../src/services/gitWorktree';

let tmp: string;
let repo: string;
let worktreesDir: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wt-')));
  repo = path.join(tmp, 'repo');
  worktreesDir = path.join(tmp, 'home', 'worktrees', 'repo');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'test'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'README.md'), 'hi');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('git worktree service', () => {
  it('creates a worktree on a new branch', async () => {
    const svc = createGitWorktreeService();
    const dest = path.join(worktreesDir, 'FD-1_thing');
    await svc.create({ repoPath: repo, branch: 'FD-1_thing', sourceBranch: 'main', targetPath: dest });
    expect((await fs.stat(dest)).isDirectory()).toBe(true);
  });

  it('lists worktrees with branch info', async () => {
    const svc = createGitWorktreeService();
    const dest = path.join(worktreesDir, 'FD-1_thing');
    await svc.create({ repoPath: repo, branch: 'FD-1_thing', sourceBranch: 'main', targetPath: dest });
    const list = await svc.list(repo);
    expect(list.find((w) => w.path === dest)?.branch).toBe('FD-1_thing');
  });

  it('removes a worktree', async () => {
    const svc = createGitWorktreeService();
    const dest = path.join(worktreesDir, 'FD-1_thing');
    await svc.create({ repoPath: repo, branch: 'FD-1_thing', sourceBranch: 'main', targetPath: dest });
    await svc.remove({ repoPath: repo, targetPath: dest, force: false });
    await expect(fs.stat(dest)).rejects.toThrow();
  });

  it('refuses to remove a dirty worktree without force', async () => {
    const svc = createGitWorktreeService();
    const dest = path.join(worktreesDir, 'FD-1_thing');
    await svc.create({ repoPath: repo, branch: 'FD-1_thing', sourceBranch: 'main', targetPath: dest });
    await fs.writeFile(path.join(dest, 'dirty.txt'), 'x');
    await expect(
      svc.remove({ repoPath: repo, targetPath: dest, force: false }),
    ).rejects.toMatchObject({ code: 'GIT_DIRTY' });
  });
});
