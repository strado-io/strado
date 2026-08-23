import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectDirName, moveClaudeProjectHistory } from './claudeProjects.js';

describe('claudeProjectDirName', () => {
  it('encodes every non-alphanumeric byte as a dash, like Claude Code does', () => {
    // Verified against real ~/.claude/projects entries: underscores and dots
    // become dashes too, not just slashes — worktree slugs always carry
    // underscores, so a /.-only encoding misses every one of them.
    expect(claudeProjectDirName('/Users/me/dev/strado.worktree/handling_worktree_path')).toBe(
      '-Users-me-dev-strado-worktree-handling-worktree-path',
    );
    expect(claudeProjectDirName('/u/wt/FD-1_fix_thing')).toBe('-u-wt-FD-1-fix-thing');
  });
});

describe('moveClaudeProjectHistory', () => {
  let claudeDir: string;
  const oldWt = '/u/dev/site.worktrees/FD-1_hi';
  const newWt = '/u/.strado/worktrees/site/FD-1_hi';

  beforeEach(async () => {
    claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-projects-'));
  });
  afterEach(async () => {
    await fs.rm(claudeDir, { recursive: true, force: true });
  });

  const projDir = (wt: string) => path.join(claudeDir, 'projects', claudeProjectDirName(wt));

  it('renames the project dir so --resume finds the history at the new path', async () => {
    await fs.mkdir(projDir(oldWt), { recursive: true });
    await fs.writeFile(path.join(projDir(oldWt), 'session.jsonl'), '{}\n');

    expect(await moveClaudeProjectHistory(oldWt, newWt, claudeDir)).toBe('moved');
    await expect(fs.readFile(path.join(projDir(newWt), 'session.jsonl'), 'utf8')).resolves.toBe('{}\n');
    await expect(fs.access(projDir(oldWt))).rejects.toThrow();
  });

  it('reports none when the old path never had conversations', async () => {
    expect(await moveClaudeProjectHistory(oldWt, newWt, claudeDir)).toBe('none');
  });

  it('refuses to clobber existing history at the destination', async () => {
    await fs.mkdir(projDir(oldWt), { recursive: true });
    await fs.mkdir(projDir(newWt), { recursive: true });
    await fs.writeFile(path.join(projDir(newWt), 'theirs.jsonl'), 'x');

    expect(await moveClaudeProjectHistory(oldWt, newWt, claudeDir)).toBe('conflict');
    // Both survive: merging two histories is not this function's call to make.
    await expect(fs.access(projDir(oldWt))).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(projDir(newWt), 'theirs.jsonl'), 'utf8')).resolves.toBe('x');
  });
});
