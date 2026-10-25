import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Detect } from '../lsp/detect.js';
import { listEditors } from './detect.js';
import { createEditors, type SpawnFn } from './open.js';
import { createEditorStore } from './store.js';
import type { EditorId } from './types.js';

let tmp: string;
let root: string;
let apps: string;

const detect = (clis: Record<string, string>): Detect => ({
  dirs: async () => ['/fake/bin'],
  which: async (name) => clis[name] ?? null,
});

type Spawned = { file: string; args: string[]; opts: Parameters<SpawnFn>[2] };

function recorder(fail = false): { spawn: SpawnFn; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const spawn: SpawnFn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return fail ? Promise.reject(new Error('ENOENT')) : Promise.resolve();
  };
  return { spawn, calls };
}

function make(o: { clis?: Record<string, string>; platform?: NodeJS.Platform; fail?: boolean } = {}) {
  const rec = recorder(o.fail);
  const editors = createEditors({
    detect: detect(o.clis ?? {}),
    store: createEditorStore(() => path.join(tmp, 'editors.json')),
    platform: o.platform ?? 'darwin',
    appDirs: [apps],
    spawn: rec.spawn,
  });
  return { editors, calls: rec.calls };
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'editors-')));
  root = path.join(tmp, 'wt');
  apps = path.join(tmp, 'Applications');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x\n');
  await fs.mkdir(apps);
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('listEditors', () => {
  it('a CLI or (macOS) an app makes it available; lines only with a CLI; system always', async () => {
    await fs.mkdir(path.join(apps, 'Zed.app'));
    const list = await listEditors({ detect: detect({ code: '/bin/code', webstorm: '/bin/webstorm' }), platform: 'darwin', appDirs: [apps] });
    const by = Object.fromEntries(list.map((e) => [e.id, e]));
    expect(by.vscode).toEqual({ id: 'vscode', label: 'VS Code', available: true, lines: true });
    expect(by.zed).toEqual({ id: 'zed', label: 'Zed', available: true, lines: false });
    expect(by.webstorm).toMatchObject({ available: true, lines: true });
    expect(by.cursor).toMatchObject({ available: false, lines: false });
    expect(by.system).toEqual({ id: 'system', label: 'Finder', available: true, lines: false });
    expect(list.map((e) => e.id)).toEqual(['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'antigravity', 'zed', 'sublime', 'webstorm', 'idea', 'pycharm', 'goland', 'xcode', 'system']);
  });

  it('VS Code Insiders on its own: its CLI, or its app bundle', async () => {
    const byCli = await listEditors({ detect: detect({ 'code-insiders': '/usr/local/bin/code-insiders' }), platform: 'darwin', appDirs: [apps] });
    expect(byCli.find((e) => e.id === 'vscode-insiders')).toEqual({ id: 'vscode-insiders', label: 'VS Code Insiders', available: true, lines: true });
    expect(byCli.find((e) => e.id === 'vscode')!.available).toBe(false);
    await fs.mkdir(path.join(apps, 'Visual Studio Code - Insiders.app'));
    const byApp = await listEditors({ detect: detect({}), platform: 'darwin', appDirs: [apps] });
    expect(byApp.find((e) => e.id === 'vscode-insiders')).toMatchObject({ available: true, lines: false });
  });

  it('app bundles count only on macOS; the default app is the File manager on Linux', async () => {
    await fs.mkdir(path.join(apps, 'Zed.app'));
    const list = await listEditors({ detect: detect({}), platform: 'linux', appDirs: [apps] });
    expect(list.find((e) => e.id === 'zed')!.available).toBe(false);
    expect(list.find((e) => e.id === 'system')!.label).toBe('File manager');
  });

  it('Antigravity: by its CLI (vscode-style lines) or its app', async () => {
    const byCli = await listEditors({ detect: detect({ antigravity: '/bin/antigravity' }), platform: 'darwin', appDirs: [apps] });
    expect(byCli.find((e) => e.id === 'antigravity')).toEqual({ id: 'antigravity', label: 'Antigravity', available: true, lines: true });
    await fs.mkdir(path.join(apps, 'Antigravity.app'));
    const byApp = await listEditors({ detect: detect({}), platform: 'darwin', appDirs: [apps] });
    expect(byApp.find((e) => e.id === 'antigravity')).toMatchObject({ available: true, lines: false });
  });
});

describe('open: argv per goto style', () => {
  const file = () => path.join(root, 'src', 'a.ts');
  const cases: [EditorId, Record<string, string>, () => string[]][] = [
    ['vscode', { code: '/bin/code' }, () => ['/bin/code', root, '-g', `${file()}:12:3`]],
    ['vscode-insiders', { 'code-insiders': '/bin/code-insiders' }, () => ['/bin/code-insiders', root, '-g', `${file()}:12:3`]],
    ['cursor', { cursor: '/bin/cursor' }, () => ['/bin/cursor', root, '-g', `${file()}:12:3`]],
    ['antigravity', { antigravity: '/bin/antigravity' }, () => ['/bin/antigravity', root, '-g', `${file()}:12:3`]],
    ['zed', { zed: '/bin/zed' }, () => ['/bin/zed', `${file()}:12:3`]],
    ['sublime', { subl: '/bin/subl' }, () => ['/bin/subl', `${file()}:12:3`]],
    ['webstorm', { webstorm: '/bin/webstorm' }, () => ['/bin/webstorm', '--line', '12', '--column', '3', file()]],
    ['xcode', { xed: '/usr/bin/xed' }, () => ['/usr/bin/xed', '-l', '12', file()]],
  ];
  it.each(cases)('%s at a line', async (id, clis, want) => {
    const { editors, calls } = make({ clis });
    await editors.open({ worktreePath: root, path: 'src/a.ts', line: 12, col: 3, editor: id });
    expect([calls[0]!.file, ...calls[0]!.args]).toEqual(want());
  });

  it('a folder inside the worktree opens as a folder', async () => {
    const { editors, calls } = make({ clis: { code: '/bin/code' } });
    await editors.open({ worktreePath: root, path: 'src', line: 4, editor: 'vscode' });
    expect([calls[0]!.file, ...calls[0]!.args]).toEqual(['/bin/code', path.join(root, 'src')]);
  });

  it('a file without a line, and the worktree folder', async () => {
    const { editors, calls } = make({ clis: { code: '/bin/code', webstorm: '/bin/webstorm' } });
    await editors.open({ worktreePath: root, path: 'src/a.ts', editor: 'vscode' });
    await editors.open({ worktreePath: root, editor: 'vscode' });
    await editors.open({ worktreePath: root, path: 'src/a.ts', editor: 'webstorm' });
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      ['/bin/code', root, file()],
      ['/bin/code', root],
      ['/bin/webstorm', file()],
    ]);
  });

  it('col defaults to 1 for the file:line:col styles', async () => {
    const { editors, calls } = make({ clis: { code: '/bin/code' } });
    await editors.open({ worktreePath: root, path: 'src/a.ts', line: 7, editor: 'vscode' });
    expect(calls[0]!.args).toEqual([root, '-g', `${file()}:7:1`]);
  });

  it('an app with no CLI: open -a, no line', async () => {
    await fs.mkdir(path.join(apps, 'Zed.app'));
    const { editors, calls } = make();
    await editors.open({ worktreePath: root, path: 'src/a.ts', line: 12, editor: 'zed' });
    expect([calls[0]!.file, ...calls[0]!.args]).toEqual(['/usr/bin/open', '-a', 'Zed', file()]);
  });

  it('system: open on macOS, xdg-open on Linux, never a line', async () => {
    const mac = make({ platform: 'darwin' });
    await mac.editors.open({ worktreePath: root, path: 'src/a.ts', line: 3, editor: 'system' });
    expect([mac.calls[0]!.file, ...mac.calls[0]!.args]).toEqual(['/usr/bin/open', file()]);
    const linux = make({ platform: 'linux', clis: { 'xdg-open': '/usr/bin/xdg-open' } });
    await linux.editors.open({ worktreePath: root, editor: 'system' });
    expect([linux.calls[0]!.file, ...linux.calls[0]!.args]).toEqual(['/usr/bin/xdg-open', root]);
  });

  it('detached, no stdio, in the worktree, with the same scrubbed env as language servers', async () => {
    const prev = { ...process.env };
    Object.assign(process.env, { STRADO_AGENT_TOKEN: 't', GITHUB_TOKEN: 'g', DATABASE_URL: 'postgres://u:p@h/d', GOPATH: '/go' });
    try {
      const { editors, calls } = make({ clis: { code: '/bin/code' } });
      await editors.open({ worktreePath: root, editor: 'vscode' });
      const { opts } = calls[0]!;
      expect(opts).toMatchObject({ cwd: root, detached: true, stdio: 'ignore' });
      expect(opts.env.STRADO_AGENT_TOKEN).toBeUndefined();
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
      expect(opts.env.DATABASE_URL).toBeUndefined();
      expect(opts.env.GOPATH).toBe('/go');
      expect(opts.env.PATH).toBe('/fake/bin');
    } finally {
      for (const k of ['STRADO_AGENT_TOKEN', 'GITHUB_TOKEN', 'DATABASE_URL', 'GOPATH']) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});

describe('open: which editor, and refusals', () => {
  it('no choice: the preferred one, else the first available, else the default app', async () => {
    const a = make({ clis: { zed: '/bin/zed', code: '/bin/code' } });
    await a.editors.open({ worktreePath: root });
    expect(a.calls[0]!.file).toBe('/bin/code');
    await a.editors.setPreferred('zed');
    await a.editors.open({ worktreePath: root });
    expect(a.calls[1]!.file).toBe('/bin/zed');
    expect((await a.editors.list()).preferred).toBe('zed');
    await a.editors.setPreferred(null);
    const b = make();
    await b.editors.open({ worktreePath: root });
    expect([b.calls[0]!.file, ...b.calls[0]!.args]).toEqual(['/usr/bin/open', root]);
  });

  it('an editor that is not installed is a 400 naming it', async () => {
    const { editors } = make();
    await expect(editors.open({ worktreePath: root, editor: 'cursor' })).rejects.toMatchObject({ httpStatus: 400, message: 'Cursor is not installed' });
  });

  it('a preferred editor that has since been uninstalled falls back, as the web does', async () => {
    const { editors, calls } = make({ clis: { cursor: '/bin/cursor' } });
    await editors.setPreferred('zed');
    await editors.open({ worktreePath: root });
    expect(calls[0]!.file).toBe('/bin/cursor');
  });

  it('paths: escape refused, missing 404, .git refused', async () => {
    await fs.writeFile(path.join(tmp, 'secret.ts'), 's');
    await fs.symlink(path.join(tmp, 'secret.ts'), path.join(root, 'out.ts'));
    const { editors, calls } = make({ clis: { code: '/bin/code' } });
    await expect(editors.open({ worktreePath: root, path: '../secret.ts', editor: 'vscode' })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(editors.open({ worktreePath: root, path: 'out.ts', editor: 'vscode' })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(editors.open({ worktreePath: root, path: 'nope.ts', editor: 'vscode' })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(editors.open({ worktreePath: root, path: '.git/config', editor: 'vscode' })).rejects.toMatchObject({ httpStatus: 400 });
    expect(calls).toEqual([]);
  });

  it('a launch that fails is reported', async () => {
    const { editors } = make({ clis: { code: '/bin/code' }, fail: true });
    await expect(editors.open({ worktreePath: root, editor: 'vscode' })).rejects.toMatchObject({ message: 'Could not start VS Code' });
  });
});

describe('open: a real CLI on PATH', () => {
  it('runs it with the argv, detached', async () => {
    const bin = path.join(tmp, 'bin');
    await fs.mkdir(bin);
    const out = path.join(tmp, 'argv.txt');
    await fs.writeFile(path.join(bin, 'code'), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > '${out}'\n`, { mode: 0o755 });
    const editors = createEditors({
      detect: { dirs: async () => [bin, '/usr/bin', '/bin'], which: async (n) => (n === 'code' ? path.join(bin, 'code') : null) },
      store: createEditorStore(() => path.join(tmp, 'editors.json')),
      platform: process.platform,
      appDirs: [],
    });
    await editors.open({ worktreePath: root, path: 'src/a.ts', line: 2, editor: 'vscode' });
    const end = Date.now() + 3000;
    while (Date.now() < end && !(await fs.stat(out).catch(() => null))) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 50));
    expect((await fs.readFile(out, 'utf8')).trim().split('\n')).toEqual([root, root, '-g', `${path.join(root, 'src', 'a.ts')}:2:1`]);
  });
});

describe('createEditorStore', () => {
  it('keeps the choice; an unknown id reads as none', async () => {
    const file = path.join(tmp, 'h', 'editors.json');
    const s = createEditorStore(() => file);
    expect(await s.get()).toBeNull();
    await s.set('cursor');
    expect(await createEditorStore(() => file).get()).toBe('cursor');
    await s.set(null);
    expect(await s.get()).toBeNull();
    await fs.writeFile(file, JSON.stringify({ preferred: 'emacs' }));
    expect(await s.get()).toBeNull();
  });
});
