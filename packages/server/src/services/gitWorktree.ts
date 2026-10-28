import { exec } from '../shell.js';
import { AppError } from '../errors.js';

export type WorktreeListItem = {
  path: string;
  branch: string | null;
  head: string;
  prunable: boolean;
};

export type CreateOptions = {
  repoPath: string;
  branch: string;
  /** Omitted: branch from the repo's HEAD, whatever branch that is. */
  sourceBranch?: string;
  targetPath: string;
};

export type RemoveOptions = {
  repoPath: string;
  targetPath: string;
  force: boolean;
};

export type GitWorktreeService = {
  list(repoPath: string): Promise<WorktreeListItem[]>;
  create(opts: CreateOptions): Promise<void>;
  remove(opts: RemoveOptions): Promise<void>;
  deleteBranch(repoPath: string, branch: string): Promise<void>;
};

export function createGitWorktreeService(): GitWorktreeService {
  return {
    async list(repoPath) {
      const { stdout } = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
      return parsePorcelain(stdout);
    },
    async create({ repoPath, branch, sourceBranch, targetPath }) {
      const args = ['-C', repoPath, 'worktree', 'add', targetPath, '-b', branch];
      if (sourceBranch) args.push(sourceBranch);
      try {
        await exec('git', args);
      } catch (err) {
        throw await explainCreateFailure(repoPath, err);
      }
    },
    async remove({ repoPath, targetPath, force }) {
      try {
        const args = ['-C', repoPath, 'worktree', 'remove', targetPath];
        if (force) args.push('--force');
        await exec('git', args);
      } catch (err) {
        const details = err instanceof AppError && err.details && typeof err.details === 'object'
          ? err.details as { stderr?: unknown }
          : null;
        const stderr = typeof details?.stderr === 'string' ? details.stderr.trim() : '';
        if (
          err instanceof AppError &&
          err.code === 'SHELL_FAILED' &&
          /dirty|modified|uncommitted/i.test(stderr || JSON.stringify(err.details))
        ) {
          throw new AppError('GIT_DIRTY', 'worktree has uncommitted changes', err.details);
        }
        if (err instanceof AppError && err.code === 'SHELL_FAILED' && stderr) {
          throw new AppError('SHELL_FAILED', `could not remove worktree: ${stderr}`, err.details);
        }
        throw err;
      }
    },
    async deleteBranch(repoPath, branch) {
      await exec('git', ['-C', repoPath, 'branch', '-D', branch]);
    },
  };
}

/** The branch a repo's checkout is on, or null when HEAD is detached. */
export async function currentBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', repoPath, 'symbolic-ref', '--short', '-q', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// "git exited 128" tells a person nothing. A repo with no commits gets a plain
// sentence (a fresh `git init` is the usual cause); anything else carries git's
// own last line.
async function explainCreateFailure(repoPath: string, err: unknown): Promise<unknown> {
  if (!(err instanceof AppError) || err.code !== 'SHELL_FAILED') return err;
  const hasCommit = await exec('git', ['-C', repoPath, 'rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
  if (!hasCommit) {
    return new AppError('VALIDATION', 'This repo has no commits yet. Make a first commit, then create a worktree.', err.details);
  }
  const details = err.details && typeof err.details === 'object' ? err.details as { stderr?: unknown } : null;
  const stderr = typeof details?.stderr === 'string' ? details.stderr.trim() : '';
  const line = stderr.split('\n').filter(Boolean).pop()?.replace(/^(fatal|error):\s*/, '');
  return line ? new AppError('SHELL_FAILED', `could not create worktree: ${line}`, err.details) : err;
}

function parsePorcelain(stdout: string): WorktreeListItem[] {
  const blocks = stdout.split(/\n\n+/).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n');
    let path = '';
    let head = '';
    let branch: string | null = null;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        branch = ref.replace(/^refs\/heads\//, '');
      } else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
    }
    return { path, branch, head, prunable };
  });
}
