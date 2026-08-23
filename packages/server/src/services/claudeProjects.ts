import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The directory name Claude Code files a cwd's conversations under
 * (`~/.claude/projects/<name>`). Observed from real dirs: EVERY
 * non-alphanumeric byte becomes '-' — slashes, dots and underscores alike
 * (`.../strado.worktree/handling_worktree_path` →
 * `-Users-...-strado-worktree-handling-worktree-path`). Note this is broader
 * than the `[/.]`-only encoding in routes/claudeSessions.ts, which misses
 * underscores; worktree slugs (`FD-1_fix_thing`) always contain them.
 */
export function claudeProjectDirName(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

export type ChatHistoryMove = 'moved' | 'none' | 'conflict';

/**
 * Carry Claude Code's conversation history along when a worktree moves, so
 * `claude --resume` in the new location still sees its past sessions. The
 * transcripts live under a directory named for the cwd, so a move is just a
 * rename of that directory.
 *
 * 'none' = the old path never had conversations; 'conflict' = the NEW path
 * already has its own project dir — merging two histories is not ours to
 * decide, so the old one is left where it is (recoverable by hand).
 */
export async function moveClaudeProjectHistory(
  oldWorktreePath: string,
  newWorktreePath: string,
  claudeDir: string = path.join(os.homedir(), '.claude'),
): Promise<ChatHistoryMove> {
  const root = path.join(claudeDir, 'projects');
  const from = path.join(root, claudeProjectDirName(oldWorktreePath));
  const to = path.join(root, claudeProjectDirName(newWorktreePath));
  try {
    await fsp.access(from);
  } catch {
    return 'none';
  }
  try {
    await fsp.access(to);
    return 'conflict';
  } catch {
    // target free — proceed
  }
  await fsp.rename(from, to);
  return 'moved';
}
