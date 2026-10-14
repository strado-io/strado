import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec } from '../../shell.js';
import { withGitAskPass, type HttpGitCredential } from '../gitAskPass.js';

const GIT_TIMEOUT_MS = 10 * 60_000;

async function git(args: string[], cwd?: string, credential?: HttpGitCredential) {
  const run = (env?: NodeJS.ProcessEnv) => exec('git', args, {
    ...(cwd ? { cwd } : {}),
    timeoutMs: GIT_TIMEOUT_MS,
    ...(env ? { env } : { env: { GIT_TERMINAL_PROMPT: '0' } }),
  });
  return credential ? withGitAskPass(credential, run) : run();
}

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
// One clone at a time per bare repo: two first creates for the same repo
// both saw no HEAD and both ran `git clone --bare` into the same directory,
// and the second died with "already exists and is not an empty directory".
const inFlight = new Map<string, Promise<string>>();

export async function ensureBareRepo(opts: EnsureBareRepoOptions): Promise<string> {
  const key = path.join(opts.reposDir, opts.repoId);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = ensureBareRepoNow(opts);
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

export type EnsureBareRepoOptions = {
  reposDir: string;
  repoId: string;
  cloneUrl: string;
  credential?: HttpGitCredential;
  /** 'best-effort': an existing clone is used even if its fetch fails (the
   * credential source is unreachable); `onStale` hears why. A missing clone
   * still has to clone, and still fails loudly. */
  fetch?: 'required' | 'best-effort';
  onStale?: (reason: string) => void;
};

async function ensureBareRepoNow(opts: EnsureBareRepoOptions): Promise<string> {
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
    // The origin follows the URL we can authenticate NOW. A bare clone made
    // before any token was connected has an SSH origin that no token can use,
    // and inside the container (no ~/.ssh) it could never fetch or push.
    const current = await git(['remote', 'get-url', 'origin'], target);
    if (current.code === 0 && current.stdout.trim() !== opts.cloneUrl) {
      await git(['remote', 'set-url', 'origin', opts.cloneUrl], target);
    }
    // Reuse is the common case, and a bare clone is otherwise frozen at the
    // moment the FIRST sandboxed worktree for this repo was created — every
    // later one would silently branch from a stale origin/main. Loud on
    // failure: branching from a stale tip without saying so is the bug —
    // unless the caller already knows it is offline and said so.
    try {
      await git(['fetch', 'origin'], target, opts.credential);
    } catch (err) {
      if (opts.fetch !== 'best-effort') throw err;
      opts.onStale?.((err as Error).message);
    }
    return target;
  }
  await git(['clone', '--bare', opts.cloneUrl, target], undefined, opts.credential);
  // A bare clone has no remote-tracking fetch refspec by default; add one so
  // later fetches see origin branches the way a normal clone would.
  await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], target);
  await git(['fetch', 'origin'], target, opts.credential);
  return target;
}

export async function addSandboxWorktree(opts: {
  bareRepo: string; targetPath: string; branch: string; sourceBranch: string;
}): Promise<void> {
  await fsp.mkdir(path.dirname(opts.targetPath), { recursive: true });
  const src = `origin/${opts.sourceBranch}`;
  await git(['worktree', 'add', '-b', opts.branch, opts.targetPath, src], opts.bareRepo);
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
