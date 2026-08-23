import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Where every repo's bare clone lives, under the machine's state dir. */
export function sandboxReposDir(homeStateDir: string): string {
  return path.join(homeStateDir, 'sandbox', 'repos');
}

/** The bare clone for one repo id. For callers that only READ — the worktree
 * listing and delete — where ensureBareRepo would clone one into existence. */
export function bareRepoPath(reposDir: string, repoId: string): string {
  return path.join(reposDir, `${repoId}.git`);
}

/** One bare clone per repo, shared object store for every sandboxed worktree.
 * Lives under the runner's state dir; existing NORMAL clones are untouched
 * (spec: both shapes coexist, no migration, no flag day). */
export async function ensureBareRepo(opts: { reposDir: string; repoId: string; cloneUrl: string }): Promise<string> {
  await fsp.mkdir(opts.reposDir, { recursive: true });
  // Resolve once, up front: on macOS (and anywhere state dirs live behind a
  // symlink) `git worktree add` canonicalizes the path it writes into the
  // worktree's .git pointer file. If we returned the un-resolved path here,
  // ensureBareRepo's result would silently stop matching what's actually in
  // that file — the exact path-identity mismatch this module exists to avoid.
  const reposDir = await fsp.realpath(opts.reposDir);
  const target = bareRepoPath(reposDir, opts.repoId);
  const cloned = await fsp.access(path.join(target, 'HEAD')).then(() => true, () => false);
  if (cloned) {
    // Reuse is the common case, and a bare clone is otherwise frozen at the
    // moment the FIRST sandboxed worktree for this repo was created — every
    // later one would silently branch from a stale origin/main. Loud on
    // failure: branching from a stale tip without saying so is the bug.
    await run('git', ['fetch', 'origin'], { cwd: target, timeout: 10 * 60_000 });
    return target;
  }
  await run('git', ['clone', '--bare', opts.cloneUrl, target], { timeout: 10 * 60_000 });
  // A bare clone has no remote-tracking fetch refspec by default; add one so
  // later fetches see origin branches the way a normal clone would.
  await run('git', ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: target });
  await run('git', ['fetch', 'origin'], { cwd: target, timeout: 10 * 60_000 });
  return target;
}

export async function addSandboxWorktree(opts: {
  bareRepo: string; targetPath: string; branch: string; sourceBranch: string;
}): Promise<void> {
  await fsp.mkdir(path.dirname(opts.targetPath), { recursive: true });
  const src = `origin/${opts.sourceBranch}`;
  await run('git', ['worktree', 'add', '-b', opts.branch, opts.targetPath, src], { cwd: opts.bareRepo });
}

/** The two absolute paths a sandbox must bind-mount at IDENTICAL paths:
 * the worktree, and the bare repo its .git pointer file names. */
export async function gitMountPaths(worktreePath: string): Promise<string[]> {
  const pointer = await fsp.readFile(path.join(worktreePath, '.git'), 'utf8');
  const m = pointer.match(/^gitdir: (.+)$/m);
  const gitdir = m?.[1];
  if (!gitdir) throw new Error(`${worktreePath}/.git is not a worktree pointer file`);
  // gitdir is <bare>/worktrees/<name>; the mount target is the bare repo root.
  const bare = path.resolve(gitdir.trim(), '..', '..');
  return [worktreePath, bare];
}
