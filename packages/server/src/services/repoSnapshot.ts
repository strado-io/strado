import { exec as shellExec } from '../shell.js';

// Step 9a: a bounded, best-effort look at the source worktree for a fork
// package. Never throws: any failure (not a repo, git missing, budget
// exceeded) collapses to the same empty-with-`error` shape so the caller can
// render `(unavailable: <reason>)` without a try/catch of its own.
export type RepoSnapshot = {
  worktreePath: string;
  branch: string | null;
  head: string;
  status: string[];
  diffStat: string;
  error?: string;
};

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const defaultExec: ExecFn = (command, args, options) => shellExec(command, args, options);

function raceWithBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`repoSnapshot timed out after ${budgetMs}ms`)), budgetMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export async function repoSnapshot(
  worktreePath: string,
  exec: ExecFn = defaultExec,
  budgetMs = 10_000,
): Promise<RepoSnapshot> {
  try {
    const run = async (...args: string[]): Promise<string> => {
      const { stdout } = await exec('git', args, { cwd: worktreePath });
      // Trailing newline only: git porcelain output (status --short) uses a
      // leading space as a meaningful column, so a plain .trim() would eat it.
      return stdout.replace(/\r?\n+$/, '');
    };
    const work = (async (): Promise<RepoSnapshot> => {
      const [head, branchRaw, statusRaw, diffStat, diffCachedStat] = await Promise.all([
        run('rev-parse', 'HEAD'),
        run('rev-parse', '--abbrev-ref', 'HEAD'),
        run('status', '--short'),
        run('diff', '--stat'),
        run('diff', '--cached', '--stat'),
      ]);
      const branch = branchRaw.length === 0 || branchRaw === 'HEAD' ? null : branchRaw;
      const status = statusRaw.length > 0 ? statusRaw.split('\n') : [];
      const diffStatCombined = [diffStat, diffCachedStat].filter((s) => s.length > 0).join('\n');
      return { worktreePath, branch, head, status, diffStat: diffStatCombined };
    })();
    return await raceWithBudget(work, budgetMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { worktreePath, branch: null, head: '', status: [], diffStat: '', error: message };
  }
}
