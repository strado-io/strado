import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors';
import { listMarkdownFiles, readMarkdownFile } from '../../src/services/markdownIndex';

const dirs: string[] = [];

function tmpWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  dirs.push(dir);
  return fs.realpathSync(dir);
}

function write(root: string, rel: string, body = '# hi\n'): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('listMarkdownFiles', () => {
  it('finds markdown at every depth, sorted, relative, POSIX-separated', async () => {
    const root = tmpWorktree();
    write(root, 'README.md');
    write(root, 'docs/architecture.md');
    write(root, 'docs/specs/deep/plan.markdown');
    write(root, 'packages/server/NOTES.mdx');

    const { files, truncated } = await listMarkdownFiles(root);

    expect(files.map((f) => f.path)).toEqual([
      'README.md',
      'docs/architecture.md',
      'docs/specs/deep/plan.markdown',
      'packages/server/NOTES.mdx',
    ]);
    expect(truncated).toBe(false);
    expect(files[0]!.size).toBeGreaterThan(0);
    expect(files[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it('ignores non-markdown files and matches extensions case-insensitively', async () => {
    const root = tmpWorktree();
    write(root, 'a.md');
    write(root, 'B.MD');
    write(root, 'code.ts', 'export {}');
    write(root, 'notes.txt', 'x');

    const files = (await listMarkdownFiles(root)).files.map((f) => f.path);
    expect(files).toEqual(['B.MD', 'a.md']);
  });

  it('never descends into skipped directories', async () => {
    const root = tmpWorktree();
    write(root, 'keep.md');
    write(root, 'node_modules/pkg/README.md');
    write(root, '.git/hooks/NOTES.md');
    write(root, 'dist/out.md');
    write(root, 'coverage/report.md');

    const files = (await listMarkdownFiles(root)).files.map((f) => f.path);
    expect(files).toEqual(['keep.md']);
  });

  it('does not follow symlinked directories', async () => {
    const root = tmpWorktree();
    const outside = tmpWorktree();
    write(outside, 'secret.md');
    write(root, 'inside.md');
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');

    const files = (await listMarkdownFiles(root)).files.map((f) => f.path);
    expect(files).toEqual(['inside.md']);
  });

  it('stops at the cap and reports truncated', async () => {
    const root = tmpWorktree();
    for (let i = 0; i < 2005; i++) write(root, `d${String(i).padStart(4, '0')}.md`);

    const { files, truncated, cap } = await listMarkdownFiles(root);
    expect(files).toHaveLength(2000);
    expect(truncated).toBe(true);
    expect(cap).toBe(2000);
  });

  it('returns an empty listing for a worktree with no markdown', async () => {
    const root = tmpWorktree();
    write(root, 'src/index.ts', 'export {}');

    expect(await listMarkdownFiles(root)).toEqual({ files: [], truncated: false, cap: 2000 });
  });

  it('logs a diagnostic when a directory cannot be read, without throwing', async () => {
    const root = tmpWorktree();
    write(root, 'keep.md');
    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(blocked);
    write(blocked, 'hidden.md');
    fs.chmodSync(blocked, 0o000);

    const debugLog = { log: vi.fn(), path: '' };
    try {
      const { files } = await listMarkdownFiles(root, debugLog);
      expect(files.map((f) => f.path)).toEqual(['keep.md']);
      expect(debugLog.log).toHaveBeenCalledWith('kb', expect.stringContaining(blocked));
    } finally {
      fs.chmodSync(blocked, 0o755); // restore so afterEach can remove the tmpdir
    }
  });

  it('excludes gitignored markdown in a git repo', async () => {
    const root = tmpWorktree();
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', 'scratch/\nTODO.md\n');
    write(root, 'keep.md');
    write(root, 'TODO.md');
    write(root, 'scratch/notes.md');

    const files = (await listMarkdownFiles(root)).files.map((f) => f.path);
    expect(files).toEqual(['keep.md']);
  });

  it('keeps every file when the worktree is not a git repo', async () => {
    const root = tmpWorktree();
    write(root, '.gitignore', 'TODO.md\n');
    write(root, 'keep.md');
    write(root, 'TODO.md');

    // No git repo → check-ignore cannot run → nothing is filtered. Asserting the
    // result alone doesn't prove this path fired — a stub that never spawns git
    // would look identical — so also assert the give-up line was logged, proving
    // git really was invoked, really exited non-zero, and the code took the
    // "filter unavailable, keep everything" branch.
    const debugLog = { log: vi.fn(), path: '' };
    const files = (await listMarkdownFiles(root, debugLog)).files.map((f) => f.path);
    expect(files).toEqual(['TODO.md', 'keep.md']);
    expect(debugLog.log).toHaveBeenCalledWith('kb', expect.stringContaining(root));
  });
});

describe('readMarkdownFile', () => {
  it('reads a markdown file and reports size and mtime', async () => {
    const root = tmpWorktree();
    write(root, 'docs/guide.md', '# Guide\n\nbody\n');

    const r = await readMarkdownFile(root, 'docs/guide.md');
    expect(r.content).toBe('# Guide\n\nbody\n');
    expect(r.size).toBe(14);
    expect(r.mtimeMs).toBeGreaterThan(0);
  });

  it('rejects traversal out of the worktree', async () => {
    const root = tmpWorktree();
    const err1 = await readMarkdownFile(root, '../../etc/passwd.md').catch((e) => e);
    expect(err1).toBeInstanceOf(AppError);
    expect(err1.code).toBe('PATH_FORBIDDEN');

    const err2 = await readMarkdownFile(root, '/etc/passwd.md').catch((e) => e);
    expect(err2).toBeInstanceOf(AppError);
    expect(err2.code).toBe('PATH_FORBIDDEN');
  });

  it('rejects a symlink that points outside the worktree', async () => {
    const root = tmpWorktree();
    const outside = tmpWorktree();
    write(outside, 'secret.md', 'classified');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'leak.md'));

    const err = await readMarkdownFile(root, 'leak.md').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('PATH_FORBIDDEN');
  });

  it('rejects non-markdown extensions', async () => {
    const root = tmpWorktree();
    write(root, '.env', 'SECRET=1');

    const err = await readMarkdownFile(root, '.env').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('VALIDATION');
  });

  it('rejects files over the size cap', async () => {
    const root = tmpWorktree();
    write(root, 'huge.md', 'x'.repeat(2 * 1024 * 1024 + 1));

    const err = await readMarkdownFile(root, 'huge.md').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('VALIDATION');
  });

  it('reports a missing file as NOT_FOUND', async () => {
    const root = tmpWorktree();
    const err = await readMarkdownFile(root, 'gone.md').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('NOT_FOUND');
  });

  // Finding 3: tmpWorktree() always hands back an already-canonical path
  // (fs.realpathSync in the helper), so a root comparison done without its own
  // realpath() call would never be exercised by any other test in this file.
  // Built directly in the fixture — a symlinked directory as the worktree root —
  // rather than relying on the platform's tmpdir happening to sit under a
  // symlinked ancestor (macOS /var -> /private/var; not true on every Linux box).
  // This test must fail if readMarkdownFile ever compares `real` against `root`
  // directly instead of `await fsp.realpath(root)`.
  it('reads successfully when the worktree root is not itself canonical', async () => {
    const parent = tmpWorktree(); // canonical, already auto-cleaned
    const actual = path.join(parent, 'real');
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, path.join(parent, 'link'), 'dir');
    write(actual, 'docs/g.md', 'hi\n');

    // root is <parent>/link, whose realpath is <parent>/real — comparing `real`
    // against a raw `root` cannot match.
    const r = await readMarkdownFile(path.join(parent, 'link'), 'docs/g.md');
    expect(r.content).toBe('hi\n');
  });

  // Finding 4: the other traversal test targets /etc/passwd.md, which doesn't
  // exist, so it only proves a 403 when there's nothing on the other side. Point
  // `../` at a sibling tmpdir that actually has content and assert both that the
  // call is rejected AND that the rejection never carries the real content.
  it('rejects traversal to a sibling directory that exists, without leaking its content', async () => {
    const root = tmpWorktree();
    const sibling = tmpWorktree();
    write(sibling, 'secret.md', 'classified');
    const siblingName = path.basename(sibling);

    const result = await readMarkdownFile(root, `../${siblingName}/secret.md`).catch((e) => e);
    expect(result).toBeInstanceOf(AppError);
    expect(result.code).toBe('PATH_FORBIDDEN');
    expect(result).not.toMatchObject({ content: 'classified' });
  });
});
