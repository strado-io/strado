import { mkdtemp } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureBareRepo, addSandboxWorktree, gitMountPaths } from './bareRepo.js';

const run = promisify(execFile);

let origin: string; // a real upstream repo to clone from
beforeAll(async () => {
  origin = await mkdtemp(path.join(tmpdir(), 'sbx-origin-'));
  await run('git', ['init', '-b', 'main'], { cwd: origin });
  await fsp.writeFile(path.join(origin, 'a.txt'), 'hello\n');
  await run('git', ['add', '.'], { cwd: origin });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: origin });
});

describe('bare repo + worktree', () => {
  it('clones bare on first use, is idempotent after', async () => {
    const reposDir = await mkdtemp(path.join(tmpdir(), 'sbx-repos-'));
    const p1 = await ensureBareRepo({ reposDir, repoId: 'r1', cloneUrl: origin });
    const p2 = await ensureBareRepo({ reposDir, repoId: 'r1', cloneUrl: origin });
    expect(p1).toBe(p2);
    expect((await fsp.stat(path.join(p1, 'HEAD'))).isFile()).toBe(true);
  });

  it('re-fetches on reuse, so worktree #2 branches from a fresh tip', async () => {
    // Without this the bare clone is a snapshot of whenever the FIRST sandboxed
    // worktree for this repo was created, and every later one silently branches
    // from a stale main.
    const reposDir = await mkdtemp(path.join(tmpdir(), 'sbx-repos-'));
    const bare = await ensureBareRepo({ reposDir, repoId: 'r1', cloneUrl: origin });
    const before = (await run('git', ['rev-parse', 'origin/main'], { cwd: bare })).stdout.trim();

    await fsp.writeFile(path.join(origin, 'b.txt'), 'later\n');
    await run('git', ['add', '.'], { cwd: origin });
    await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'later'], { cwd: origin });
    const tip = (await run('git', ['rev-parse', 'HEAD'], { cwd: origin })).stdout.trim();
    expect(tip).not.toBe(before);

    await ensureBareRepo({ reposDir, repoId: 'r1', cloneUrl: origin });
    expect((await run('git', ['rev-parse', 'origin/main'], { cwd: bare })).stdout.trim()).toBe(tip);
  });

  it('worktree add produces a .git POINTER FILE naming the bare repo', async () => {
    const reposDir = await mkdtemp(path.join(tmpdir(), 'sbx-repos-'));
    const bare = await ensureBareRepo({ reposDir, repoId: 'r1', cloneUrl: origin });
    const wt = path.join(await mkdtemp(path.join(tmpdir(), 'sbx-wt-')), 'feat-x');
    await addSandboxWorktree({ bareRepo: bare, targetPath: wt, branch: 'feat-x', sourceBranch: 'main' });
    const gitFile = await fsp.readFile(path.join(wt, '.git'), 'utf8');
    expect(gitFile).toMatch(/^gitdir: /);
    expect(gitFile).toContain(bare); // absolute path INTO the bare repo — this is why mounts must be path-identical
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: wt });
    expect(stdout).toBe('');
  });

  it('gitMountPaths returns exactly worktree + bare repo', async () => {
    const reposDir = await mkdtemp(path.join(tmpdir(), 'sbx-repos-'));
    const bare = await ensureBareRepo({ reposDir, repoId: 'r1', cloneUrl: origin });
    const wt = path.join(await mkdtemp(path.join(tmpdir(), 'sbx-wt-')), 'feat-y');
    await addSandboxWorktree({ bareRepo: bare, targetPath: wt, branch: 'feat-y', sourceBranch: 'main' });
    expect(await gitMountPaths(wt)).toEqual([wt, bare]);
  });

  it('PINS THE FAILURE: git breaks when the worktree is relocated (path mismatch)', async () => {
    // This is what a wrong mount looks like from inside the container. If a
    // refactor makes this test pass, the identical-path rule got broken.
    const reposDir = await mkdtemp(path.join(tmpdir(), 'sbx-repos-'));
    const bare = await ensureBareRepo({ reposDir, repoId: 'r1', cloneUrl: origin });
    const wt = path.join(await mkdtemp(path.join(tmpdir(), 'sbx-wt-')), 'feat-z');
    await addSandboxWorktree({ bareRepo: bare, targetPath: wt, branch: 'feat-z', sourceBranch: 'main' });
    const moved = wt + '-moved';
    await fsp.cp(wt, moved, { recursive: true });
    await fsp.rm(path.join(moved, '.git')); // simulate: worktree mounted, bare repo NOT
    await fsp.writeFile(path.join(moved, '.git'), `gitdir: /nonexistent/repo.git/worktrees/feat-z\n`);
    await expect(run('git', ['status'], { cwd: moved })).rejects.toThrow();
  });
});
