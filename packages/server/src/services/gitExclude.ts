import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec } from '../shell.js';

// Append `pattern` to the worktree's git info/exclude once. Best-effort:
// silently does nothing if this isn't a git worktree or git is unavailable.
export async function addGitExclude(worktreePath: string, pattern: string): Promise<void> {
  try {
    const { stdout } = await exec('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude']);
    const rel = stdout.trim();
    const excludePath = path.isAbsolute(rel) ? rel : path.join(worktreePath, rel);
    let current = '';
    try { current = await fsp.readFile(excludePath, 'utf8'); } catch { /* none yet */ }
    if (!current.split('\n').some((l) => l.trim() === pattern)) {
      const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
      await fsp.appendFile(excludePath, `${prefix}${pattern}\n`);
    }
  } catch {
    // not a git repo / git unavailable — leave as-is
  }
}
