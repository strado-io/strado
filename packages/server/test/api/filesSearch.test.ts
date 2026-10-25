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
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-search-')));
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

describe('Files search route', () => {
  it('literal, word, case, regex, glob; answers SearchAnswer', async () => {
    const r = await get(`${base()}/search?q=TWO&word=1`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ hits: [{ path: 'src/a.ts', line: 2, col: 1, preview: 'two' }], truncated: false, engine: expect.stringMatching(/^(rg|git-grep)$/) });
    expect((await get(`${base()}/search?q=TWO&case=1`)).json().hits).toEqual([]);
    expect((await get(`${base()}/search?q=t.o`)).json().hits).toEqual([]);
    expect((await get(`${base()}/search?q=t.o&regex=true`)).json().hits).toHaveLength(1);
    expect((await get(`${base()}/search?q=two&glob=*.md`)).json().hits).toEqual([]);
  });

  it('refuses a bad query or glob with fixed words, and never searches outside', async () => {
    for (const qs of ['', 'q=', `q=${'x'.repeat(1001)}`, 'q=a&glob=../*', 'q=a&glob=/etc/*', 'q=a&word=maybe', 'q=a&extra=1']) {
      const r = await get(`${base()}/search?${qs}`);
      expect(r.statusCode, qs).toBe(400);
    }
    expect((await get(`${base()}/search?q=secret`)).json().hits).toEqual([]);
    const bad = await get(`${base()}/search?q=a(&regex=1`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('bad search pattern');
  });

  it('a path no repo owns is 404', async () => {
    const r = await get(`/api/w/default/worktrees/${encodeURIComponent(tmp)}/files/search?q=a`);
    expect(r.statusCode).toBe(404);
  });
});
