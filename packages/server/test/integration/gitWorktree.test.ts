import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { createGitWorktreeService, currentBranch } from '../../src/services/gitWorktree';

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

  it('with no source branch, branches from whatever the repo is on (master here, not a guessed main)', async () => {
    await exec('git', ['branch', '-m', 'main', 'master'], { cwd: repo });
    expect(await currentBranch(repo)).toBe('master');
    const svc = createGitWorktreeService();
    const dest = path.join(worktreesDir, 'FD-2');
    await svc.create({ repoPath: repo, branch: 'FD-2', targetPath: dest });
    expect((await fs.stat(path.join(dest, 'README.md'))).isFile()).toBe(true);
  });

  it('says why it failed: a repo with no commits, or git\'s own reason, never "git exited 128"', async () => {
    const svc = createGitWorktreeService();
    await expect(svc.create({ repoPath: repo, branch: 'x', sourceBranch: 'nope', targetPath: path.join(worktreesDir, 'x') }))
      .rejects.toThrow(/^could not create worktree: .*nope/);
    const empty = path.join(tmp, 'empty');
    await fs.mkdir(empty);
    await exec('git', ['init', '-q', '-b', 'master'], { cwd: empty });
    await expect(svc.create({ repoPath: empty, branch: 'y', sourceBranch: 'master', targetPath: path.join(worktreesDir, 'y') }))
      .rejects.toThrow('This repo has no commits yet. Make a first commit, then create a worktree.');
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
