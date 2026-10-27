import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../shell.js';
import crypto from 'node:crypto';
import { languageFor, listFiles, parseMarks, readFile, readMarks, readTree, safeRel, writeFile } from './files.js';
import { FILES_LIMITS } from './types.js';

let tmp: string;
let repo: string;

const git = (...args: string[]) => exec('git', args, { cwd: repo });
const write = async (rel: string, text: string | Buffer) => {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await fs.writeFile(path.join(repo, rel), text);
};

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'files-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'x@y.z');
  await git('config', 'user.name', 'x');
  await write('a.txt', 'one\ntwo\nthree\n');
  await write('src/app.ts', 'export const a = 1;\n');
  await write('src/deep/x.ts', 'x\n');
  await write('docs/readme.md', '# hi\n');
  await write('.gitignore', 'dist/\n*.log\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('safeRel', () => {
  it.each(['', 'a.txt', 'src/app.ts', 'src/', './src'])('accepts %j', (p) => {
    expect(() => safeRel(p)).not.toThrow();
  });
  it('normalizes', () => {
    expect(safeRel('src/')).toBe('src');
    expect(safeRel('./src')).toBe('src');
    expect(safeRel('')).toBe('');
  });
  it.each(['..', '../x', 'src/../../x', 'a/..', '/etc/passwd', 'src\\app.ts', 'a\0b', '.git', '.git/config', 'sub/.git/HEAD', 'C:/x', '//x'])(
    'rejects %j with 400',
    (p) => {
      expect(() => safeRel(p)).toThrow(expect.objectContaining({ httpStatus: 400 }));
    },
  );
});

describe('readTree', () => {
  it('lists one level, dirs first then names, hiding .git and ignored', async () => {
    await write('dist/out.js', 'x');
    await write('err.log', 'x');
    await write('B.txt', 'b');
    const page = await readTree(repo, '', false);
    expect(page.dir).toBe('');
    expect(page.truncated).toBe(false);
    expect(page.entries.map((e) => `${e.kind}:${e.path}`)).toEqual([
      'dir:docs', 'dir:src', 'file:.gitignore', 'file:a.txt', 'file:B.txt',
    ]);
    const a = page.entries.find((e) => e.name === 'a.txt')!;
    expect(a).toEqual({ name: 'a.txt', path: 'a.txt', kind: 'file', size: 14 });
  });

  it('includes ignored entries, marked, when asked', async () => {
    await write('dist/out.js', 'x');
    await write('err.log', 'x');
    const page = await readTree(repo, '', true);
    expect(page.entries.find((e) => e.name === 'dist')).toMatchObject({ kind: 'dir', ignored: true });
    expect(page.entries.find((e) => e.name === 'err.log')).toMatchObject({ kind: 'file', ignored: true });
    expect(page.entries.find((e) => e.name === 'src')!.ignored).toBeUndefined();
    expect(page.entries.some((e) => e.name === '.git')).toBe(false);
  });

  it('a name that looks like pathspec magic is listed and checked like any other', async () => {
    await write(':(glob)x.log', 'x');
    await write(':keep.txt', 'x');
    const page = await readTree(repo, '', true);
    expect(page.entries.find((e) => e.name === ':(glob)x.log')).toMatchObject({ ignored: true });
    expect(page.entries.find((e) => e.name === ':keep.txt')).toMatchObject({ change: '?' });
  });

  it('lists a subfolder with paths relative to the root', async () => {
    const page = await readTree(repo, 'src', false);
    expect(page.entries.map((e) => e.path)).toEqual(['src/deep', 'src/app.ts']);
  });

  it('badges files and the folders above them', async () => {
    await write('src/deep/x.ts', 'changed\n');
    await write('docs/new.md', 'new\n');
    await write('fresh/one.txt', '1');
    await git('rm', '-q', 'a.txt');
    const root = await readTree(repo, '', false);
    const change = (n: string) => root.entries.find((e) => e.name === n)?.change;
    expect(change('src')).toBe('M');
    expect(change('docs')).toBe('?');
    expect(change('fresh')).toBe('?');
    expect(change('.gitignore')).toBeUndefined();
    const src = await readTree(repo, 'src', false);
    expect(src.entries.find((e) => e.name === 'deep')!.change).toBe('M');
    expect(src.entries.find((e) => e.name === 'app.ts')!.change).toBeUndefined();
    const fresh = await readTree(repo, 'fresh', false);
    expect(fresh.entries[0]).toMatchObject({ name: 'one.txt', change: '?' });
  });

  it('caps a huge folder', async () => {
    await fs.mkdir(path.join(repo, 'big'));
    await Promise.all(
      Array.from({ length: FILES_LIMITS.treeEntries + 5 }, (_, i) => fs.writeFile(path.join(repo, 'big', `f${i}`), '')),
    );
    const page = await readTree(repo, 'big', false);
    expect(page.entries).toHaveLength(FILES_LIMITS.treeEntries);
    expect(page.truncated).toBe(true);
  });

  it('a root name starting with ".." is an ordinary name', async () => {
    await write('..env', 'x=1\n');
    expect((await readTree(repo, '', false)).entries.some((e) => e.name === '..env')).toBe(true);
    expect((await readFile(repo, '..env')).text).toBe('x=1\n');
  });

  it('a symlink out of the worktree is listed without its target\'s kind or size', async () => {
    await fs.mkdir(path.join(tmp, 'outside'));
    await fs.writeFile(path.join(tmp, 'big'), 'x'.repeat(50));
    await fs.symlink(path.join(tmp, 'outside'), path.join(repo, 'outdir'));
    await fs.symlink(path.join(tmp, 'big'), path.join(repo, 'outfile'));
    const page = await readTree(repo, '', false);
    // '?' is the link itself being untracked, which is ours to show.
    expect(page.entries.find((e) => e.name === 'outdir')).toEqual({ name: 'outdir', path: 'outdir', kind: 'file', change: '?' });
    expect(page.entries.find((e) => e.name === 'outfile')).toEqual({ name: 'outfile', path: 'outfile', kind: 'file', change: '?' });
  });

  it('badges a subfolder from a status scoped to it', async () => {
    await write('src/deep/x.ts', 'changed\n');
    await write('docs/new.md', 'n');
    const src = await readTree(repo, 'src', false);
    expect(src.entries.find((e) => e.name === 'deep')!.change).toBe('M');
    expect(src.entries.find((e) => e.name === 'app.ts')!.change).toBeUndefined();
  });

  it('refuses a symlinked folder that leaves the worktree', async () => {
    await fs.mkdir(path.join(tmp, 'outside'));
    await fs.symlink(path.join(tmp, 'outside'), path.join(repo, 'out'));
    await expect(readTree(repo, 'out', false)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('a missing folder is 404, a file is 400', async () => {
    await expect(readTree(repo, 'nope', false)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(readTree(repo, 'a.txt', false)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('works outside git, with no badges', async () => {
    const plain = path.join(tmp, 'plain');
    await fs.mkdir(path.join(plain, 'd'), { recursive: true });
    await fs.writeFile(path.join(plain, 'f.txt'), 'x');
    const page = await readTree(plain, '', false);
    expect(page.entries).toEqual([
      { name: 'd', path: 'd', kind: 'dir' },
      { name: 'f.txt', path: 'f.txt', kind: 'file', size: 1 },
    ]);
  });
});

describe('listFiles', () => {
  it('lists tracked and untracked files, not ignored ones', async () => {
    await write('new.txt', 'n');
    await write('dist/out.js', 'x');
    const list = await listFiles(repo);
    expect(list.truncated).toBe(false);
    expect(list.files.sort()).toEqual(['.gitignore', 'a.txt', 'docs/readme.md', 'new.txt', 'src/app.ts', 'src/deep/x.ts']);
  });

  it('caps the list', async () => {
    await write('new.txt', 'n');
    const list = await listFiles(repo, 3);
    expect(list.files).toHaveLength(3);
    expect(list.truncated).toBe(true);
  });
});

describe('readFile', () => {
  it('reads text with a language hint and its change', async () => {
    await write('src/app.ts', 'export const a = 2;\n');
    expect(await readFile(repo, 'src/app.ts')).toEqual({
      path: 'src/app.ts',
      size: 20,
      binary: false,
      tooLarge: false,
      text: 'export const a = 2;\n',
      language: 'typescript',
      change: 'M',
      version: crypto.createHash('sha256').update('export const a = 2;\n').digest('hex'),
    });
  });

  it('flags binary and sends no text', async () => {
    await write('img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const f = await readFile(repo, 'img.bin');
    expect(f).toMatchObject({ binary: true, tooLarge: false, size: 4, change: '?' });
    expect(f.text).toBeUndefined();
  });

  it('flags a file over the cap and sends no text', async () => {
    await write('huge.txt', Buffer.alloc(FILES_LIMITS.readBytes + 1, 'a'));
    const f = await readFile(repo, 'huge.txt');
    expect(f).toMatchObject({ tooLarge: true, binary: false });
    expect(f.text).toBeUndefined();
  });

  it('refuses a symlink that escapes the worktree', async () => {
    await fs.writeFile(path.join(tmp, 'secret'), 's');
    await fs.symlink(path.join(tmp, 'secret'), path.join(repo, 'link'));
    await expect(readFile(repo, 'link')).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('refuses a symlink into .git', async () => {
    await fs.symlink(path.join(repo, '.git', 'config'), path.join(repo, 'cfg'));
    await expect(readFile(repo, 'cfg')).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('follows a symlink that stays inside', async () => {
    await fs.symlink('a.txt', path.join(repo, 'alias'));
    expect((await readFile(repo, 'alias')).text).toBe('one\ntwo\nthree\n');
  });

  it('a missing file is 404, a folder is 400, a bad path is 400', async () => {
    await expect(readFile(repo, 'nope.txt')).rejects.toMatchObject({ httpStatus: 404 });
    await expect(readFile(repo, 'src')).rejects.toMatchObject({ httpStatus: 400 });
    await expect(readFile(repo, '../x')).rejects.toMatchObject({ httpStatus: 400 });
    await expect(readFile(repo, '')).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe('writeFile', () => {
  const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
  const v = async (rel: string) => (await readFile(repo, rel)).version!;

  it('binary and too-large reads carry no version', async () => {
    await write('img.bin', Buffer.from([1, 0, 2]));
    expect((await readFile(repo, 'img.bin')).version).toBeUndefined();
  });

  it('replaces the text; the version is the new bytes\' sha-256', async () => {
    const r = await writeFile(repo, 'src/app.ts', 'export const a = 3;\n', await v('src/app.ts'));
    expect(r).toEqual({ ok: true, result: { path: 'src/app.ts', version: sha('export const a = 3;\n'), size: 20 }, real: path.join(repo, 'src', 'app.ts') });
    expect(await fs.readFile(path.join(repo, 'src/app.ts'), 'utf8')).toBe('export const a = 3;\n');
    expect(await v('src/app.ts')).toBe(sha('export const a = 3;\n'));
    expect((await fs.readdir(path.join(repo, 'src'))).sort()).toEqual(['app.ts', 'deep']); // no temp file left
  });

  it('a stale baseVersion is a conflict carrying the current version; force overwrites', async () => {
    const before = await v('a.txt');
    await write('a.txt', 'changed elsewhere\n');
    expect(await writeFile(repo, 'a.txt', 'mine\n', before)).toEqual({ ok: false, conflict: { error: 'conflict', path: 'a.txt', version: sha('changed elsewhere\n') } });
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('changed elsewhere\n');
    const forced = await writeFile(repo, 'a.txt', 'mine\n', before, true);
    expect(forced.ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('mine\n');
  });

  it("keeps the file's mode", async () => {
    await write('run.sh', '#!/bin/sh\necho hi\n');
    await fs.chmod(path.join(repo, 'run.sh'), 0o750);
    await writeFile(repo, 'run.sh', '#!/bin/sh\necho bye\n', await v('run.sh'));
    expect((await fs.stat(path.join(repo, 'run.sh'))).mode & 0o7777).toBe(0o750);
  });

  it('writes through a symlink that stays inside, and keeps the link', async () => {
    await fs.symlink('a.txt', path.join(repo, 'alias'));
    await writeFile(repo, 'alias', 'via link\n', await v('alias'));
    expect((await fs.lstat(path.join(repo, 'alias'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('via link\n');
  });

  it('refuses: missing, a folder, .git, .., absolute, a symlink out, binary, too large, read-only', async () => {
    const any = sha('');
    await expect(writeFile(repo, 'nope.txt', 'x', any)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(writeFile(repo, 'src', 'x', any)).rejects.toMatchObject({ httpStatus: 400, message: 'not a file' });
    await expect(writeFile(repo, '.git/config', 'x', any)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(writeFile(repo, '../secret.txt', 'x', any)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(writeFile(repo, path.join(repo, 'a.txt'), 'x', any)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(writeFile(repo, '', 'x', any)).rejects.toMatchObject({ httpStatus: 400 });
    await fs.writeFile(path.join(tmp, 'outside.txt'), 'outside\n');
    await fs.symlink(path.join(tmp, 'outside.txt'), path.join(repo, 'out'));
    await expect(writeFile(repo, 'out', 'x', sha('outside\n'))).rejects.toMatchObject({ httpStatus: 403 });
    expect(await fs.readFile(path.join(tmp, 'outside.txt'), 'utf8')).toBe('outside\n');
    await write('img.bin', Buffer.from([1, 0, 2]));
    await expect(writeFile(repo, 'img.bin', 'x', sha(Buffer.from([1, 0, 2])))).rejects.toMatchObject({ httpStatus: 400, message: 'binary file' });
    await expect(writeFile(repo, 'a.txt', 'nul\0inside', await v('a.txt'))).rejects.toMatchObject({ httpStatus: 400, message: 'binary text' });
    await expect(writeFile(repo, 'a.txt', 'x'.repeat(FILES_LIMITS.readBytes + 1), await v('a.txt'))).rejects.toMatchObject({ httpStatus: 400, message: 'text too large' });
    await write('huge.txt', 'x'.repeat(FILES_LIMITS.readBytes + 1));
    await expect(writeFile(repo, 'huge.txt', 'small', any)).rejects.toMatchObject({ httpStatus: 400, message: 'file too large' });
    await fs.chmod(path.join(repo, 'a.txt'), 0o444);
    await expect(writeFile(repo, 'a.txt', 'x', await v('a.txt'))).rejects.toMatchObject({ httpStatus: 400, message: 'file is read-only' });
  });

  it('atomic: a failed write leaves the old file whole and no temp file', async () => {
    const before = await v('src/app.ts');
    await fs.chmod(path.join(repo, 'src'), 0o555); // no new file can be made here
    try {
      await expect(writeFile(repo, 'src/app.ts', 'new text\n', before)).rejects.toMatchObject({ httpStatus: 400, message: 'could not write the file' });
    } finally {
      await fs.chmod(path.join(repo, 'src'), 0o755);
    }
    expect(await fs.readFile(path.join(repo, 'src/app.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect((await fs.readdir(path.join(repo, 'src'))).sort()).toEqual(['app.ts', 'deep']);
  });
});

describe('languageFor', () => {
  it.each([
    ['a.ts', 'typescript'], ['a.tsx', 'tsx'], ['a.js', 'javascript'], ['a.mjs', 'javascript'], ['a.jsx', 'jsx'],
    ['a.json', 'json'], ['a.md', 'markdown'], ['a.py', 'python'], ['a.go', 'go'], ['a.rs', 'rust'],
    ['a.css', 'css'], ['a.html', 'html'], ['a.yml', 'yaml'], ['a.sh', 'shell'], ['Dockerfile', 'dockerfile'],
    ['x/Dockerfile.dev', 'dockerfile'], ['a.toml', 'toml'], ['a.sql', 'sql'], ['a.unknown', null], ['README', null],
  ])('%s → %s', (p, lang) => {
    expect(languageFor(p)).toBe(lang);
  });
});

describe('parseMarks', () => {
  it('reads -U0 hunks into added, modified and deletions', () => {
    const diff = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
      '@@ -5 +7 @@',
      '-x',
      '+y',
      '@@ -9,2 +10,0 @@',
      '-p',
      '-q',
      '@@ -20,3 +20,1 @@',
      '-r',
      '-s',
      '-t',
      '+u',
    ].join('\n');
    expect(parseMarks('f', diff)).toEqual({
      path: 'f',
      added: [[1, 2]],
      modified: [[7, 7], [20, 20]],
      deletedAfter: [10],
    });
  });
});

describe('readMarks', () => {
  it('marks a working-copy edit against HEAD, staged or not', async () => {
    await write('a.txt', 'one\nTWO\nthree\nfour\n');
    await git('add', 'a.txt');
    await write('a.txt', 'zero\none\nTWO\nthree\nfour\n');
    expect(await readMarks(repo, 'a.txt')).toEqual({
      path: 'a.txt',
      added: [[1, 1], [5, 5]],
      modified: [[3, 3]],
      deletedAfter: [],
    });
  });

  it('an untracked file is all added', async () => {
    await write('new.txt', 'a\nb\nc');
    expect(await readMarks(repo, 'new.txt')).toEqual({ path: 'new.txt', added: [[1, 3]], modified: [], deletedAfter: [] });
  });

  it('a clean file has no marks; a deleted one has none either', async () => {
    expect(await readMarks(repo, 'a.txt')).toEqual({ path: 'a.txt', added: [], modified: [], deletedAfter: [] });
    await fs.rm(path.join(repo, 'a.txt'));
    expect(await readMarks(repo, 'a.txt')).toEqual({ path: 'a.txt', added: [], modified: [], deletedAfter: [] });
  });

  it('treats pathspec magic as a literal name', async () => {
    await write(':(glob)*', 'a\n');
    expect((await readMarks(repo, ':(glob)*')).added).toEqual([[1, 1]]);
  });

  it('refuses bad paths', async () => {
    await expect(readMarks(repo, '../x')).rejects.toMatchObject({ httpStatus: 400 });
    await expect(readMarks(repo, '.git/config')).rejects.toMatchObject({ httpStatus: 400 });
  });
});
