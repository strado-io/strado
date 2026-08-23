import { exec } from '../shell.js';

export type GitStatus = {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
};

export type GitStatusService = {
  status(worktreePath: string): Promise<GitStatus>;
};

export function createGitStatusService(): GitStatusService {
  return {
    async status(worktreePath) {
      const branchResult = await exec('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchResult.stdout.trim();
      const porcelain = await exec('git', ['-C', worktreePath, 'status', '--porcelain']);
      const dirty = porcelain.stdout.trim().length > 0;
      let ahead = 0;
      let behind = 0;
      try {
        const counts = await exec('git', [
          '-C',
          worktreePath,
          'rev-list',
          '--left-right',
          '--count',
          `HEAD...origin/${branch}`,
        ]);
        const parts = counts.stdout.trim().split(/\s+/);
        ahead = Number(parts[0] ?? 0);
        behind = Number(parts[1] ?? 0);
      } catch {
        ahead = 0;
        behind = 0;
      }
      return { branch, dirty, ahead, behind };
    },
  };
}
