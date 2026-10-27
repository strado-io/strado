import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const base = () => `/api/w/default/worktrees/${encodeURIComponent(repo)}/files`;
const get = (url: string) => app.inject({ method: 'GET', url });
const local = { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000' };
const write = (payload: object, headers: Record<string, string> = local) =>
  app.inject({ method: 'POST', url: `${base()}/write`, headers, payload });
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-files-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'one\n');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'one\ntwo\n');
  await fs.writeFile(path.join(tmp, 'secret.txt'), 'secret');

  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  const res = await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: { id: 'r', name: 'r', path: repo, projectSubdir: null, startCommand: 'npm start', defaultPort: 8080, editor: 'code' },
  });
  expect(res.statusCode).toBe(200);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('Files routes', () => {
  it('tree, list, read and marks', async () => {
    const tree = await get(`${base()}/tree`);
    expect(tree.statusCode).toBe(200);
    expect(tree.json()).toEqual({ dir: '', truncated: false, entries: [{ name: 'src', path: 'src', kind: 'dir', change: 'M' }] });

    const sub = await get(`${base()}/tree?dir=src`);
    expect(sub.json().entries).toEqual([{ name: 'a.ts', path: 'src/a.ts', kind: 'file', size: 8, change: 'M' }]);

    expect((await get(`${base()}/list`)).json()).toEqual({ files: ['src/a.ts'], truncated: false });

    const read = await get(`${base()}/read?path=${encodeURIComponent('src/a.ts')}`);
    expect(read.json()).toMatchObject({ path: 'src/a.ts', text: 'one\ntwo\n', language: 'typescript', change: 'M' });

    const marks = await get(`${base()}/marks?path=${encodeURIComponent('src/a.ts')}`);
    expect(marks.json()).toEqual({ path: 'src/a.ts', added: [[2, 2]], modified: [], deletedAfter: [] });
  });

  it.each(['../secret.txt', '/etc/passwd', 'src\\a.ts', '.git/config', 'a\0b'])('read %j → 400', async (p) => {
    expect((await get(`${base()}/read?path=${encodeURIComponent(p)}`)).statusCode).toBe(400);
  });

  it('a symlink out of the worktree → 403', async () => {
    await fs.symlink(path.join(tmp, 'secret.txt'), path.join(repo, 'link'));
    const res = await get(`${base()}/read?path=link`);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('secret');
  });

  it('a worktree no repo owns → 404', async () => {
    const other = path.join(tmp, 'other');
    await fs.mkdir(other);
    expect((await get(`/api/w/default/worktrees/${encodeURIComponent(other)}/files/tree`)).statusCode).toBe(404);
  });

  it('a missing path param → 400', async () => {
    expect((await get(`${base()}/read`)).statusCode).toBe(400);
    expect((await get(`${base()}/marks`)).statusCode).toBe(400);
  });

  it('nothing but GET', async () => {
    for (const r of ['tree', 'list', 'read', 'marks']) {
      expect((await app.inject({ method: 'POST', url: `${base()}/${r}`, payload: {} })).statusCode).toBe(404);
    }
  });
});

describe('POST files/write', () => {
  it('read gives a version; write replaces the text and returns the new one', async () => {
    const read = (await get(`${base()}/read?path=src/a.ts`)).json();
    expect(read.version).toBe(sha('one\ntwo\n'));
    const res = await write({ path: 'src/a.ts', text: 'one\ntwo\nthree\n', baseVersion: read.version });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: 'src/a.ts', version: sha('one\ntwo\nthree\n'), size: 14 });
    expect(await fs.readFile(path.join(repo, 'src', 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('409 with the current version on a stale baseVersion; force overwrites', async () => {
    const stale = sha('old');
    const res = await write({ path: 'src/a.ts', text: 'mine\n', baseVersion: stale });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'conflict', path: 'src/a.ts', version: sha('one\ntwo\n') });
    expect((await write({ path: 'src/a.ts', text: 'mine\n', baseVersion: stale, force: true })).statusCode).toBe(200);
    expect(await fs.readFile(path.join(repo, 'src', 'a.ts'), 'utf8')).toBe('mine\n');
  });

  it('refused: a relayed window, a foreign origin, bad bodies, paths that leave, a symlink out, a worktree no repo owns', async () => {
    const ok = { path: 'src/a.ts', text: 'x', baseVersion: sha('one\ntwo\n') };
    expect((await write(ok, { host: '127.0.0.1:4000', 'x-strado-via': 'relay' })).statusCode).toBe(403);
    expect((await write(ok, { host: '127.0.0.1:4000', origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await write({ ...ok, extra: 1 })).statusCode).toBe(400);
    expect((await write({ ...ok, baseVersion: 'not-a-sha' })).statusCode).toBe(400);
    expect((await write({ ...ok, path: '../secret.txt' })).statusCode).toBe(400);
    expect((await write({ ...ok, path: path.join(tmp, 'secret.txt') })).statusCode).toBe(400);
    expect((await write({ ...ok, path: '.git/config' })).statusCode).toBe(400);
    expect((await write({ ...ok, path: 'src/new.ts' })).statusCode).toBe(404);
    await fs.symlink(path.join(tmp, 'secret.txt'), path.join(repo, 'src', 'out.txt'));
    expect((await write({ ...ok, path: 'src/out.txt', baseVersion: sha('secret') })).statusCode).toBe(403);
    expect(await fs.readFile(path.join(tmp, 'secret.txt'), 'utf8')).toBe('secret');
    const other = await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent(tmp)}/files/write`, headers: local, payload: ok });
    expect(other.statusCode).toBe(404);
    expect(await fs.readFile(path.join(repo, 'src', 'a.ts'), 'utf8')).toBe('one\ntwo\n');
  });

  it('takes a body as large as the biggest file, escaped', async () => {
    const big = '"'.repeat(1024 * 1024 - 10);
    const res = await write({ path: 'src/a.ts', text: big, baseVersion: sha('one\ntwo\n') });
    expect(res.statusCode).toBe(200);
    expect(res.json().size).toBe(big.length);
  });
});
