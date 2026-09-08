import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat, lstat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeSurface, readSurfaces } from './engine.js';
import { claudeDescriptor } from './descriptors/claude.js';
import type { AgentDescriptor } from './types.js';

async function home(): Promise<string> {
  const h = await mkdtemp(path.join(tmpdir(), 'home-'));
  await mkdir(path.join(h, '.claude'), { recursive: true });
  return h;
}

// Root bypasses permission bits entirely, so EACCES-based tests cannot
// discriminate anything when run as root (some CI containers do). Skip
// rather than leave a test that silently passes for the wrong reason.
const skipIfRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('writeSurface', () => {
  it('creates the file and parent directories on first write', async () => {
    const h = await mkdtemp(path.join(tmpdir(), 'home-'));
    await writeSurface(claudeDescriptor, 'effortLevel', 'global', 'high', { home: h });
    const text = await readFile(path.join(h, '.claude/settings.json'), 'utf8');
    expect(JSON.parse(text).effortLevel).toBe('high');
  });

  it('preserves comments and unrelated keys', async () => {
    const h = await home();
    const file = path.join(h, '.claude/settings.json');
    await writeFile(file, '{\n  // mine\n  "theme": "dark"\n}\n');
    await writeSurface(claudeDescriptor, 'effortLevel', 'global', 'high', { home: h });
    const text = await readFile(file, 'utf8');
    expect(text).toContain('// mine');
    expect(text).toContain('"theme": "dark"');
  });

  it('backs up the previous version on every write', async () => {
    const h = await home();
    const file = path.join(h, '.claude/settings.json');
    await writeFile(file, '{"theme":"dark"}');
    await writeSurface(claudeDescriptor, 'theme', 'global', 'light', { home: h });
    await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });
    const backups = await readdir(path.join(h, '.claude/.backups'));
    // Two writes, two snapshots — the 5-minute throttle must be disabled.
    expect(backups.filter((f) => f.startsWith('settings.json.')).length).toBe(2);
  });

  it('preserves the original file mode', async () => {
    const h = await home();
    const file = path.join(h, '.claude/settings.json');
    await writeFile(file, '{}');
    await chmod(file, 0o600);
    await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('preserves a mode a common umask would otherwise alter', async () => {
    // 0600 survives virtually any umask on its own, so it can't tell a real
    // chmod-based fix apart from `open`'s mode argument merely being masked
    // by the umask down to something that happens to match. 0666 does not:
    // under a common `022` umask, `open(file, 'w', 0o666)` alone comes back
    // 0644, not 0666 — only an explicit `chmod` after the fact preserves it.
    const h = await home();
    const file = path.join(h, '.claude/settings.json');
    await writeFile(file, '{}');
    await chmod(file, 0o666);
    await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });
    expect((await stat(file)).mode & 0o777).toBe(0o666);
  });

  it('creates a brand-new config file at mode 0600, not world-readable 0644', async () => {
    const h = await mkdtemp(path.join(tmpdir(), 'home-'));
    await writeSurface(claudeDescriptor, 'effortLevel', 'global', 'high', { home: h });
    const mode = (await stat(path.join(h, '.claude/settings.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('removes the key entirely when value is undefined', async () => {
    const h = await home();
    const file = path.join(h, '.claude/settings.json');
    await writeFile(file, '{"theme":"dark","effortLevel":"high"}');
    await writeSurface(claudeDescriptor, 'theme', 'global', undefined, { home: h });
    const doc = JSON.parse(await readFile(file, 'utf8'));
    expect('theme' in doc).toBe(false);
    expect(doc.effortLevel).toBe('high');
  });

  it('is a no-op when removing a key that was already absent', async () => {
    const h = await home();
    const file = path.join(h, '.claude/settings.json');
    await writeFile(file, '{"effortLevel":"high"}');
    await writeSurface(claudeDescriptor, 'theme', 'global', undefined, { home: h });
    const doc = JSON.parse(await readFile(file, 'utf8'));
    expect('theme' in doc).toBe(false);
    expect(doc.effortLevel).toBe('high');
  });

  it('refuses to write an unknown surface', async () => {
    const h = await home();
    await expect(
      writeSurface(claudeDescriptor, 'not-a-real-surface', 'global', 'x', { home: h }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to write a surface with no target for the requested scope', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    // `plugins` declares only a global target.
    await expect(
      writeSurface(claudeDescriptor, 'plugins', 'project', ['x'], { home: h, worktree: wt }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses to write a read-only surface', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    await expect(
      writeSurface(claudeDescriptor, 'mcp-approved', 'project', {}, { home: h, worktree: wt }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses to write a directory-format surface', async () => {
    const h = await home();
    await expect(
      writeSurface(claudeDescriptor, 'skills', 'global', [], { home: h }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses to remove a whole-file text surface instead of blanking it', async () => {
    const h = await home();
    const file = path.join(h, '.claude/CLAUDE.md');
    await writeFile(file, '# my instructions\n');
    await expect(
      writeSurface(claudeDescriptor, 'instructions', 'global', undefined, { home: h }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // The file must be untouched — the old behavior silently truncated it.
    expect(await readFile(file, 'utf8')).toBe('# my instructions\n');
  });

  it('refuses a non-string value for a whole-file text surface', async () => {
    const h = await home();
    const file = path.join(h, '.claude/CLAUDE.md');
    await writeFile(file, '# my instructions\n');
    await expect(
      writeSurface(claudeDescriptor, 'instructions', 'global', { not: 'a string' }, { home: h }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await readFile(file, 'utf8')).toBe('# my instructions\n');
  });

  it('accepts a valid string value for a whole-file text surface', async () => {
    const h = await home();
    const file = path.join(h, '.claude/CLAUDE.md');
    await writeSurface(claudeDescriptor, 'instructions', 'global', '# new instructions\n', { home: h });
    expect(await readFile(file, 'utf8')).toBe('# new instructions\n');
  });

  it('refuses to write a file that does not parse', async () => {
    const h = await home();
    await writeFile(path.join(h, '.claude/settings.json'), '{ broken');
    await expect(
      writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h }),
    ).rejects.toMatchObject({ code: 'CONFIG_UNPARSEABLE' });
  });

  it('reports the declared path in CONFIG_UNPARSEABLE, never the resolved symlink target', async () => {
    const h = await mkdtemp(path.join(tmpdir(), 'home-'));
    await mkdir(path.join(h, '.claude'), { recursive: true });
    // Declared and resolved paths must differ for this to discriminate —
    // the direct (non-symlinked) unparseable test above can't, since there
    // they're identical.
    const real = path.join(h, 'secret-real-location', 'settings.json');
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, '{ broken');
    const declared = path.join(h, '.claude', 'settings.json');
    await symlink(real, declared);

    let caught: unknown;
    try {
      await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'CONFIG_UNPARSEABLE' });
    const message = (caught as Error).message;
    expect(message).toContain(declared);
    expect(message).not.toContain(real);
  });

  it('serialises concurrent writes to the same file', async () => {
    const h = await home();
    await writeFile(path.join(h, '.claude/settings.json'), '{}');
    await Promise.all([
      writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h }),
      writeSurface(claudeDescriptor, 'effortLevel', 'global', 'high', { home: h }),
      writeSurface(claudeDescriptor, 'alwaysThinking', 'global', true, { home: h }),
    ]);
    const doc = JSON.parse(await readFile(path.join(h, '.claude/settings.json'), 'utf8'));
    // Without the mutex, later writes would patch stale text and drop siblings.
    expect(doc).toMatchObject({ theme: 'dark', effortLevel: 'high', alwaysThinkingEnabled: true });
  });

  it('returns the re-read surfaces for the scope', async () => {
    const h = await home();
    const out = await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });
    expect(out.find((s) => s.id === 'theme')).toMatchObject({ value: 'dark', source: 'set' });
  });

  it('creates missing parent directories several levels deep', async () => {
    const h = await mkdtemp(path.join(tmpdir(), 'home-'));
    // Note: no `.claude` dir at all yet — writeSurface must mkdir -p it.
    await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });
    const text = await readFile(path.join(h, '.claude/settings.json'), 'utf8');
    expect(JSON.parse(text).theme).toBe('dark');
  });

  it('patches an existing but empty file', async () => {
    const h = await home();
    const file = path.join(h, '.claude/settings.json');
    await writeFile(file, '');
    await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });
    const doc = JSON.parse(await readFile(file, 'utf8'));
    expect(doc.theme).toBe('dark');
  });

  // A test-local descriptor with a WRITABLE surface whose `path` (not just
  // `file`) declares the `<worktree>` placeholder. `claudeDescriptor` can't
  // exercise this: the only surface with `<worktree>` in `path` is
  // `mcp-approved`, which is `readOnly` and rejected before path resolution
  // ever runs. Without this, `resolvePath(target, ctx)` vs. the buggy
  // `target.path` are indistinguishable on the write side.
  const worktreePlaceholderDescriptor: AgentDescriptor = {
    id: 'test-placeholder',
    label: 'Test placeholder',
    toolCheckId: 'test-placeholder',
    surfaces: [
      {
        id: 'projectFlag', label: 'Project flag', group: 'Test', kind: 'kv',
        project: { file: '~/.claude.json', path: ['projects', '<worktree>', 'someKey'], format: 'json' },
      },
    ],
  };

  it('resolves the <worktree> placeholder inside target.path, not just target.file', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    await writeSurface(worktreePlaceholderDescriptor, 'projectFlag', 'project', 'yes', {
      home: h, worktree: wt,
    });
    const doc = JSON.parse(await readFile(path.join(h, '.claude.json'), 'utf8'));
    expect(doc.projects[wt].someKey).toBe('yes');
    // The whole point: no literal '<worktree>' key anywhere in the document.
    expect(JSON.stringify(doc)).not.toContain('<worktree>');
  });

  it('lands the write on a symlinked target file and preserves its mode', async () => {
    const h = await mkdtemp(path.join(tmpdir(), 'home-'));
    await mkdir(path.join(h, '.claude'), { recursive: true });
    const real = path.join(h, '.claude', 'real-settings.json');
    await writeFile(real, '{}');
    await chmod(real, 0o640);
    await symlink(real, path.join(h, '.claude', 'settings.json'));

    await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });

    const doc = JSON.parse(await readFile(real, 'utf8'));
    expect(doc.theme).toBe('dark');
    expect((await stat(real)).mode & 0o777).toBe(0o640);
  });

  it('writes through a dangling symlink instead of destroying it', async () => {
    const h = await mkdtemp(path.join(tmpdir(), 'home-'));
    await mkdir(path.join(h, '.claude'), { recursive: true });
    // The symlink's target — including its parent directory — does not
    // exist yet, the common "dotfiles tree not materialized" case.
    const target = path.join(h, 'dotfiles', 'nested', 'settings.json');
    const linkPath = path.join(h, '.claude', 'settings.json');
    await symlink(target, linkPath);

    await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });

    const doc = JSON.parse(await readFile(target, 'utf8'));
    expect(doc.theme).toBe('dark');
    // The link itself must survive, still pointing at `target` — not be
    // replaced by a plain file.
    const linkStat = await lstat(linkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it('writes through a dangling symlink CHAIN, leaving every intermediate link intact', async () => {
    const h = await mkdtemp(path.join(tmpdir(), 'home-'));
    await mkdir(path.join(h, '.claude'), { recursive: true });
    await mkdir(path.join(h, 'mid-dir'), { recursive: true });
    // outer -> mid -> final, where `final` doesn't exist yet. A single-hop
    // resolution would follow `outer` to `mid` and, finding `mid` unresolvable
    // (realpath fails on the whole chain), write straight there — replacing
    // the intermediate link `mid` with a plain file.
    const finalTarget = path.join(h, 'dotfiles', 'nested', 'settings.json');
    const midLink = path.join(h, 'mid-dir', 'mid.json');
    const outerLink = path.join(h, '.claude', 'settings.json');
    await symlink(finalTarget, midLink);
    await symlink(midLink, outerLink);

    await writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h });

    const doc = JSON.parse(await readFile(finalTarget, 'utf8'));
    expect(doc.theme).toBe('dark');
    expect((await lstat(outerLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(midLink)).isSymbolicLink()).toBe(true);
  });

  it('refuses a circular symlink chain instead of spinning forever', async () => {
    const h = await home();
    const a = path.join(h, '.claude', 'settings.json');
    const b = path.join(h, '.claude', 'settings-b.json');
    await symlink(b, a);
    await symlink(a, b);
    await expect(
      writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects with a clear error naming the surface when the declared path is a directory', async () => {
    const h = await home();
    await mkdir(path.join(h, '.claude', 'settings.json'), { recursive: true });
    await expect(
      writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('theme') });
  });

  it('cleans up the orphaned temp file when rename fails', async () => {
    const h = await home();
    // The declared path being a directory makes `rename(tmp, file)` fail
    // (EISDIR) after the temp file has already been written — exercising
    // the failure path writeAtomic's cleanup exists for.
    await mkdir(path.join(h, '.claude', 'settings.json'), { recursive: true });
    await expect(
      writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const entries = await readdir(path.join(h, '.claude'));
    expect(entries.filter((f) => f.includes('strado-tmp-'))).toEqual([]);
  });

  it.skipIf(skipIfRoot)(
    'rejects with a clear error naming the surface when the parent directory is not writable',
    async () => {
      const h = await home();
      const dir = path.join(h, '.claude');
      await chmod(dir, 0o500);
      try {
        await expect(
          writeSurface(claudeDescriptor, 'theme', 'global', 'dark', { home: h }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  it('git-excludes the project-scope backups directory instead of polluting git status', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    execFileSync('git', ['init', '-q'], { cwd: wt });
    await mkdir(path.join(wt, '.claude'), { recursive: true });
    await writeFile(path.join(wt, '.claude/settings.json'), '{}');

    await writeSurface(claudeDescriptor, 'model', 'project', 'opus-5', { home: h, worktree: wt });

    const exclude = await readFile(path.join(wt, '.git/info/exclude'), 'utf8');
    expect(exclude).toContain('.claude/.backups/');

    const status = execFileSync('git', ['status', '--short', '--ignored'], { cwd: wt, encoding: 'utf8' });
    expect(status).toContain('!! .claude/.backups/');
  });

  it('git-excludes backups for a SYMLINKED project-scope config, even under a /var-style worktree', async () => {
    const h = await home();
    // `os.tmpdir()` is exactly where the `/var` -> `/private/var` macOS
    // normalization bites: `wt` here is the unresolved `/var/folders/...`
    // form, same as `ctx.worktree` passed below.
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    execFileSync('git', ['init', '-q'], { cwd: wt });
    await mkdir(path.join(wt, '.claude'), { recursive: true });
    // The declared config file IS a symlink — the actual chezmoi/stow/yadm
    // dotfiles scenario the follow-symlinks policy exists for. `resolveWriteTarget`
    // calls `realpath` on it, which normalizes the whole path including `/var`
    // ancestor components, while `ctx.worktree` stays unresolved.
    const real = path.join(wt, '.claude', 'real-settings.json');
    await writeFile(real, '{}');
    await symlink(real, path.join(wt, '.claude', 'settings.json'));

    await writeSurface(claudeDescriptor, 'model', 'project', 'opus-5', { home: h, worktree: wt });

    const exclude = await readFile(path.join(wt, '.git/info/exclude'), 'utf8');
    expect(exclude).toContain('.claude/.backups/');

    const status = execFileSync('git', ['status', '--short', '--ignored'], { cwd: wt, encoding: 'utf8' });
    expect(status).toContain('!! .claude/.backups/');
  });
});
