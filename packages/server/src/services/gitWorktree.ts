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
  sourceBranch: string;
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
  /** `git worktree move` — git rewrites its own pointer files; refuses locked
   * or submodule-bearing worktrees, which surfaces as SHELL_FAILED. */
  move(opts: { repoPath: string; from: string; to: string }): Promise<void>;
  deleteBranch(repoPath: string, branch: string): Promise<void>;
};

export function createGitWorktreeService(): GitWorktreeService {
  return {
    async list(repoPath) {
      const { stdout } = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
      return parsePorcelain(stdout);
    },
    async create({ repoPath, branch, sourceBranch, targetPath }) {
      await exec('git', ['-C', repoPath, 'worktree', 'add', targetPath, '-b', branch, sourceBranch]);
    },
    async move({ repoPath, from, to }) {
      await exec('git', ['-C', repoPath, 'worktree', 'move', from, to]);
    },
    async remove({ repoPath, targetPath, force }) {
      try {
        const args = ['-C', repoPath, 'worktree', 'remove', targetPath];
        if (force) args.push('--force');
        await exec('git', args);
      } catch (err) {
        if (
          err instanceof AppError &&
          err.code === 'SHELL_FAILED' &&
          /dirty|modified|uncommitted/i.test(JSON.stringify(err.details))
        ) {
          throw new AppError('GIT_DIRTY', 'worktree has uncommitted changes', err.details);
        }
        throw err;
      }
    },
    async deleteBranch(repoPath, branch) {
      await exec('git', ['-C', repoPath, 'branch', '-D', branch]);
    },
  };
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
