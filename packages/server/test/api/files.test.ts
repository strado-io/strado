import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const base = () => `/api/w/default/worktrees/${encodeURIComponent(repo)}/files`;
const get = (url: string) => app.inject({ method: 'GET', url });

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
