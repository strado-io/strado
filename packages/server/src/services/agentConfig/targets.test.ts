import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTarget, resolvePath, allowedFiles, assertAllowedFile } from './targets.js';
import { claudeDescriptor } from './descriptors/claude.js';

const ctx = { home: '/home/u', worktree: '/wt/repo' };

describe('resolveTarget', () => {
  it('expands a leading ~', () => {
    expect(resolveTarget({ file: '~/.claude.json', path: [], format: 'json' }, ctx))
      .toBe('/home/u/.claude.json');
  });

  it('expands the <worktree> token', () => {
    expect(resolveTarget({ file: '<worktree>/.mcp.json', path: [], format: 'json' }, ctx))
      .toBe('/wt/repo/.mcp.json');
  });

  it('throws when <worktree> is used with no worktree in context', () => {
    expect(() =>
      resolveTarget({ file: '<worktree>/.mcp.json', path: [], format: 'json' }, { home: '/home/u' }),
    ).toThrow(/worktree/);
  });
});

describe('resolvePath', () => {
  it('passes through a path with no placeholder unchanged', () => {
    expect(resolvePath({ file: '~/.claude.json', path: ['mcpServers'], format: 'json' }, ctx))
      .toEqual(['mcpServers']);
  });

  it('resolves <worktree> as the second segment to the absolute worktree path', () => {
    expect(
      resolvePath({ file: '~/.claude.json', path: ['projects', '<worktree>'], format: 'json' }, ctx),
    ).toEqual(['projects', '/wt/repo']);
  });

  it('throws when <worktree> appears in the path with no worktree in context', () => {
    expect(() =>
      resolvePath(
        { file: '~/.claude.json', path: ['projects', '<worktree>'], format: 'json' },
        { home: '/home/u' },
      ),
    ).toThrow(/worktree/);
  });
});

describe('worktree value validation', () => {
  it('rejects a <worktree> substitution whose value contains ".." traversal', () => {
    expect(() =>
      resolveTarget(
        { file: '<worktree>/.mcp.json', path: [], format: 'json' },
        { home: '/home/u', worktree: '/wt/repo/../../etc' },
      ),
    ).toThrow(/worktree/);
  });

  it('rejects the same malformed worktree value in resolvePath', () => {
    expect(() =>
      resolvePath(
        { file: '~/.claude.json', path: ['projects', '<worktree>'], format: 'json' },
        { home: '/home/u', worktree: '/wt/repo/../../etc' },
      ),
    ).toThrow(/worktree/);
  });
});

describe('allowlist', () => {
  it('accepts a file the descriptor declares', async () => {
    await expect(
      assertAllowedFile(claudeDescriptor, '/home/u/.claude.json', ctx),
    ).resolves.toBeUndefined();
  });

  it('rejects an undeclared file with PATH_FORBIDDEN', async () => {
    await expect(
      assertAllowedFile(claudeDescriptor, '/home/u/.ssh/id_rsa', ctx),
    ).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' });
  });

  it('rejects traversal that resolves outside the allowlist', async () => {
    await expect(
      assertAllowedFile(claudeDescriptor, '/home/u/../../etc/passwd', ctx),
    ).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' });
  });

  it('manages a config file that is itself a symlink (dotfiles farm)', async () => {
    // A declared config path being a symlink is the normal shape of a
    // chezmoi/stow/yadm-managed dotfiles setup, not an attack — symlinks are
    // followed deliberately (see the comment on assertAllowedFile).
    const home = await mkdtemp(path.join(tmpdir(), 'home-'));
    const dotfiles = path.join(home, 'dotfiles');
    await mkdir(dotfiles, { recursive: true });
    const real = path.join(dotfiles, 'claude.json');
    await writeFile(real, '{}');
    const link = path.join(home, '.claude.json');
    await symlink(real, link);
    await expect(
      assertAllowedFile(claudeDescriptor, link, { home }),
    ).resolves.toBeUndefined();
  });

  it('accepts a symlink whose target is itself an allowed path', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'home-'));
    await mkdir(path.join(home, '.claude'), { recursive: true });
    // CLAUDE.md is itself a declared, allowed global target for this descriptor.
    const realClaudeMd = path.join(home, '.claude', 'CLAUDE.md');
    await writeFile(realClaudeMd, '# notes');
    const link = path.join(home, '.claude', 'settings.json');
    await symlink(realClaudeMd, link);
    await expect(
      assertAllowedFile(claudeDescriptor, link, { home }),
    ).resolves.toBeUndefined();
  });

  it('accepts a path that differs only by a trailing slash (same real file)', async () => {
    // A trailing slash normalizes away to the identical file — it names no
    // different filesystem entity, so there is nothing here for the
    // allowlist to police. (A real fs.open on a non-directory path with a
    // trailing slash fails with ENOTDIR downstream, independent of this.)
    await expect(
      assertAllowedFile(claudeDescriptor, '/home/u/.claude.json/', ctx),
    ).resolves.toBeUndefined();
  });

  it('never lists .claude/settings.local.json as writable', () => {
    const files = allowedFiles(claudeDescriptor, ctx);
    expect(files.some((f) => f.endsWith('settings.local.json'))).toBe(false);
  });

  it('rejects settings.local.json explicitly even though settings.json is allowed', async () => {
    await expect(
      assertAllowedFile(claudeDescriptor, '/home/u/.claude/settings.local.json', ctx),
    ).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' });
  });
});
