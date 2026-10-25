import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../shell.js';
import { classifyDefinitions, isDefinition, searchFiles, searchWord } from './search.js';
import type { NavHit } from '../lsp/types.js';

let tmp: string;
let repo: string;

const git = (...args: string[]) => exec('git', args, { cwd: repo });
const write = async (rel: string, text: string | Buffer) => {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await fs.writeFile(path.join(repo, rel), text);
};

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'search-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'x@y.z');
  await git('config', 'user.name', 'x');
  await write('src/app.ts', 'import { loadUser } from "./user";\nconst user = loadUser(1);\nexport { user };\n');
  await write('src/user.ts', 'export function loadUser(id: number) {\n  return { id, name: "é loadUser" };\n}\n');
  await write('src/userLoader.ts', 'const loadUserLater = 1;\n');
  await write('py/models.py', 'class Account:\n    pass\n\ndef open_account():\n    return Account()\n');
  await write('README.md', 'Call loadUser to get one.\nLOADUSER shouting\n');
  await write('.gitignore', 'dist/\n');
  await write('dist/bundle.js', 'function loadUser(){}\n');
  await write('img.bin', Buffer.from([0, 1, 2, 0x6c, 0x6f, 0x61, 0x64, 0x55, 0x73, 0x65, 0x72]));
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  // Untracked (not ignored) files are searched too.
  await write('src/new.ts', 'loadUser(2);\n');
  // A symlink out of the worktree is never followed.
  await fs.writeFile(path.join(tmp, 'outside.ts'), 'loadUser outside\n');
  await fs.symlink(path.join(tmp, 'outside.ts'), path.join(repo, 'src/escape.ts'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const where = (hits: NavHit[]) => hits.map((h) => `${h.path}:${h.line}:${h.col}`);

describe.each(['rg', 'git-grep'] as const)('searchFiles (%s)', (engine) => {
  it('literal by default, case-insensitive, sorted by path then line; skips ignored, binary, .git and symlinks out', async () => {
    const r = await searchFiles(repo, { q: 'loaduser' }, { engine });
    expect(r.engine).toBe(engine);
    expect(r.truncated).toBe(false);
    expect(where(r.hits)).toEqual([
      'README.md:1:6', 'README.md:2:1',
      'src/app.ts:1:10', 'src/app.ts:2:14',
      'src/new.ts:1:1',
      'src/user.ts:1:17', 'src/user.ts:2:25',
      'src/userLoader.ts:1:7',
    ]);
  });

  it('columns count characters, not bytes; the preview is the line', async () => {
    const r = await searchFiles(repo, { q: 'loadUser', case: true, glob: 'src/user.ts' }, { engine });
    expect(r.hits[1]).toEqual({ path: 'src/user.ts', line: 2, col: 25, preview: '  return { id, name: "é loadUser" };' });
  });

  it('word and case', async () => {
    const word = await searchFiles(repo, { q: 'loadUser', word: true, case: true }, { engine });
    expect(word.hits.map((h) => h.path)).not.toContain('src/userLoader.ts');
    expect(word.hits.map((h) => `${h.path}:${h.line}`)).not.toContain('README.md:2');
  });

  it('regex only when asked; a literal query is never a pattern', async () => {
    expect((await searchFiles(repo, { q: 'load.ser', case: true }, { engine })).hits).toEqual([]);
    expect((await searchFiles(repo, { q: 'load.ser', case: true, regex: true }, { engine })).hits.length).toBeGreaterThan(0);
    expect((await searchFiles(repo, { q: '-e', case: true }, { engine })).hits).toEqual([]);
  });

  it('glob narrows the files', async () => {
    const r = await searchFiles(repo, { q: 'loadUser', glob: '*.md' }, { engine });
    expect([...new Set(r.hits.map((h) => h.path))]).toEqual(['README.md']);
  });

  it('caps at the limit and says truncated', async () => {
    const r = await searchFiles(repo, { q: 'loadUser' }, { engine, limit: 3 });
    expect(r.hits).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it('a bad regex is a fixed 400', async () => {
    await expect(searchFiles(repo, { q: 'a(', regex: true }, { engine })).rejects.toMatchObject({ httpStatus: 400, message: 'bad search pattern' });
  });
});

describe('searchFiles input', () => {
  it.each([
    [{ q: '' }],
    [{ q: 'x'.repeat(1001) }],
    [{ q: 'a', glob: '../x' }],
    [{ q: 'a', glob: '/etc/*' }],
    [{ q: 'a', glob: '.git/*' }],
    [{ q: 'a\nb' }],
  ])('refuses %j', async (q) => {
    await expect(searchFiles(repo, q)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('defaults to rg when it is on PATH', async () => {
    expect((await searchFiles(repo, { q: 'Account' })).engine).toBe('rg');
  });
});

describe('searchWord + classifyDefinitions (the LSP fallback)', () => {
  it('whole word, case-sensitive; definitions float to the top', async () => {
    const r = await searchWord(repo, 'loadUser');
    const sorted = classifyDefinitions(r.hits, 'loadUser');
    expect(sorted[0]!.path).toBe('src/user.ts');
    expect(sorted[0]!.line).toBe(1);
    expect(sorted.filter((h) => isDefinition(h, 'loadUser'))).toHaveLength(1);
    expect(sorted.map((h) => h.path)).not.toContain('src/userLoader.ts');
  });

  it('python def and class', async () => {
    const hits = classifyDefinitions((await searchWord(repo, 'Account')).hits, 'Account');
    expect(where(hits)[0]).toBe('py/models.py:1:7');
    expect(isDefinition(hits[0]!, 'Account')).toBe(true);
    expect(isDefinition(hits[1]!, 'Account')).toBe(false);
  });

  const hit = (p: string, preview: string): NavHit => ({ path: p, line: 1, col: 1, preview });
  it.each([
    ['a.ts', 'export async function foo(x) {'],
    ['a.ts', 'const foo = () => 1;'],
    ['a.tsx', 'export default class foo extends X {'],
    ['a.ts', 'export type foo = string;'],
    ['a.ts', 'interface foo {'],
    ['a.go', 'func (s *Server) foo(w http.ResponseWriter) {'],
    ['a.go', 'type foo struct {'],
    ['a.rs', 'pub(crate) async fn foo() -> u8 {'],
    ['a.py', '    async def foo(self):'],
    ['a.rb', 'def self.foo'],
    ['a.java', '  public static void foo(int a) {'],
    ['a.c', '#define foo 1'],
    ['a.lua', 'local function foo()'],
    ['a.sh', 'foo() {'],
  ])('%s: %j is a definition', (p, line) => {
    expect(isDefinition(hit(p, line), 'foo')).toBe(true);
  });

  it.each([
    ['a.ts', 'foo(1);'],
    ['a.ts', 'const bar = foo;'],
    ['a.go', 'x := foo()'],
    ['a.py', 'return foo()'],
    ['a.txt', 'def foo'],
    ['a.ts', 'function food() {'],
  ])('%s: %j is not', (p, line) => {
    expect(isDefinition(hit(p, line), 'foo')).toBe(false);
  });

  it('a name that is not an identifier classifies nothing, and never builds a pattern from it', () => {
    const hits = [hit('a.ts', 'function a.b() {'), hit('a.ts', 'x')];
    expect(classifyDefinitions(hits, 'a.b')).toEqual(hits);
    expect(isDefinition(hit('a.ts', 'function (.*) {'), '(.*)')).toBe(false);
  });
});
