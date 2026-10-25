import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { createEditors, type SpawnFn } from '../../src/services/editors/open';
import { createEditorStore } from '../../src/services/editors/store';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let calls: string[][];

const local = { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000' };
const post = (url: string, payload: unknown, headers: Record<string, string> = local) =>
  app.inject({ method: 'POST', url, headers, payload: payload as object });

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-editors-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'x\n');
  await fs.writeFile(path.join(tmp, 'secret.ts'), 's');
  calls = [];
  const spawn: SpawnFn = async (file, args) => void calls.push([file, ...args]);
  const editors = createEditors({
    detect: { dirs: async () => ['/fake/bin'], which: async (n) => (n === 'code' ? '/fake/bin/code' : null) },
    store: createEditorStore(() => path.join(tmp, 'editors.json')),
    platform: 'darwin',
    appDirs: [path.join(tmp, 'Applications')],
    spawn,
    icons: {
      cacheDir: path.join(tmp, 'icons'),
      finderApp: path.join(tmp, 'nope', 'Finder.app'),
      run: async (cmd, args) => {
        if (cmd === 'plutil') return { code: 0, stdout: 'Cursor.icns\n' };
        await fs.writeFile(args[args.indexOf('--out') + 1]!, 'PNGDATA');
        return { code: 0, stdout: '' };
      },
    },
  });
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp({ ...deps, editors });
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

describe('GET /api/editors, POST /api/editors/preferred', () => {
  it('lists the editors and keeps the choice', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/editors' })).json();
    expect(list.preferred).toBeNull();
    expect(list.editors.find((e: { id: string }) => e.id === 'vscode')).toEqual({ id: 'vscode', label: 'VS Code', available: true, lines: true });
    expect((await post('/api/editors/preferred', { editor: 'vscode' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/editors' })).json().preferred).toBe('vscode');
    expect((await post('/api/editors/preferred', { editor: null })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/editors' })).json().preferred).toBeNull();
  });

  it('refuses an unknown editor, a relayed window and a foreign origin', async () => {
    expect((await post('/api/editors/preferred', { editor: 'emacs' })).statusCode).toBe(400);
    expect((await post('/api/editors/preferred', { editor: 'zed' }, { host: '127.0.0.1:4000', 'x-strado-via': 'relay' })).statusCode).toBe(403);
    expect((await post('/api/editors/preferred', { editor: 'zed' }, { host: '127.0.0.1:4000', origin: 'https://evil.example' })).statusCode).toBe(403);
  });
});

describe('GET /api/editors/:id/icon', () => {
  it("serves the app's icon as a cached PNG; 404 for no bundle or an unknown id", async () => {
    const res0 = path.join(tmp, 'Applications', 'Cursor.app', 'Contents', 'Resources');
    await fs.mkdir(res0, { recursive: true });
    await fs.writeFile(path.join(res0, 'Cursor.icns'), 'ICNS');
    const res = await app.inject({ method: 'GET', url: '/api/editors/cursor/icon' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('max-age=86400');
    expect(res.body).toBe('PNGDATA');
    expect((await app.inject({ method: 'GET', url: '/api/editors/zed/icon' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/editors/system/icon' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/editors/..%2F..%2Fetc/icon' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/editors/emacs/icon' })).statusCode).toBe(404);
  });
});

describe('POST /api/w/:ws/open-in-editor', () => {
  const url = '/api/w/default/open-in-editor';

  it('opens a file at a line, or the worktree', async () => {
    expect((await post(url, { worktreePath: repo, path: 'src/a.ts', line: 3, col: 2 })).statusCode).toBe(204);
    expect((await post(url, { worktreePath: repo })).statusCode).toBe(204);
    expect(calls).toEqual([
      ['/fake/bin/code', repo, '-g', `${path.join(repo, 'src', 'a.ts')}:3:2`],
      ['/fake/bin/code', repo],
    ]);
  });

  it('refuses paths that leave the worktree, and worktrees no repo owns', async () => {
    await fs.symlink(path.join(tmp, 'secret.ts'), path.join(repo, 'link.ts'));
    expect((await post(url, { worktreePath: repo, path: '../secret.ts' })).statusCode).toBe(400);
    expect((await post(url, { worktreePath: repo, path: 'link.ts' })).statusCode).toBe(403);
    expect((await post(url, { worktreePath: repo, path: 'nope.ts' })).statusCode).toBe(404);
    expect((await post(url, { worktreePath: tmp })).statusCode).toBe(404);
    expect((await post(url, { worktreePath: path.join(tmp, 'other') })).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it('refuses a request forwarded by the relay (how rpc reaches a runner)', async () => {
    const res = await post(url, { worktreePath: repo }, { host: '127.0.0.1:7777', 'x-strado-via': 'relay' });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('bad bodies: a line without a path, a col without a line, extra keys, an unknown or uninstalled editor', async () => {
    expect((await post(url, { worktreePath: repo, line: 3 })).statusCode).toBe(400);
    expect((await post(url, { worktreePath: repo, path: 'src/a.ts', col: 3 })).statusCode).toBe(400);
    expect((await post(url, { worktreePath: repo, argv: ['rm'] })).statusCode).toBe(400);
    expect((await post(url, { worktreePath: repo, editor: 'emacs' })).statusCode).toBe(400);
    const missing = await post(url, { worktreePath: repo, editor: 'cursor' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toBe('Cursor is not installed');
    expect(calls).toEqual([]);
  });
});
