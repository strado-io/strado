import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editorIcon, type IconDeps, type RunFn } from './icons.js';

let tmp: string;
let apps: string;
let cache: string;

/** A fake app bundle with an Info.plist naming its icon, and the .icns itself. */
async function bundle(dir: string, name: string, iconFile = 'App.icns'): Promise<string> {
  const app = path.join(dir, `${name}.app`);
  await fs.mkdir(path.join(app, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), `<plist>${iconFile}</plist>`);
  await fs.writeFile(path.join(app, 'Contents', 'Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`), 'ICNS');
  return app;
}

/** plutil reads the name out of the fake plist; sips "converts" by writing a PNG marker. */
function fakeRun(): { run: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'plutil') {
      const plist = await fs.readFile(args[args.length - 1]!, 'utf8').catch(() => '');
      const m = /<plist>(.*)<\/plist>/.exec(plist);
      return m ? { code: 0, stdout: `${m[1]}\n` } : { code: 1, stdout: '' };
    }
    if (cmd === 'sips') {
      const out = args[args.indexOf('--out') + 1]!;
      await fs.writeFile(out, `PNG of ${args[5]}`);
      return { code: 0, stdout: '' };
    }
    return { code: 127, stdout: '' };
  };
  return { run, calls };
}

const deps = (over: Partial<IconDeps> = {}): IconDeps => ({
  detect: { dirs: async () => [], which: async () => null },
  platform: 'darwin',
  appDirs: [apps],
  cacheDir: cache,
  finderApp: path.join(tmp, 'Finder.app'),
  run: fakeRun().run,
  ...over,
});

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'editor-icons-')));
  apps = path.join(tmp, 'Applications');
  cache = path.join(tmp, 'cache', 'editor-icons');
  await fs.mkdir(apps);
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('editorIcon', () => {
  it("reads the bundle's icon name, converts it once to a 64px PNG, then serves the cached file", async () => {
    const app = await bundle(apps, 'Cursor', 'Cursor.icns');
    const { run, calls } = fakeRun();
    const first = await editorIcon('cursor', deps({ run }));
    const icns = path.join(app, 'Contents', 'Resources', 'Cursor.icns');
    const { mtimeMs } = await fs.stat(icns);
    expect(first).toBe(path.join(cache, `cursor-${Math.floor(mtimeMs)}.png`));
    expect(await fs.readFile(first!, 'utf8')).toBe(`PNG of ${icns}`);
    expect(calls).toEqual([
      ['plutil', '-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')],
      ['sips', '-s', 'format', 'png', '-Z', '64', icns, '--out', first!],
    ]);
    expect(await editorIcon('cursor', deps({ run }))).toBe(first);
    expect(calls).toHaveLength(3); // plutil again, no second sips
  });

  it('an icon name without .icns gets it', async () => {
    await bundle(apps, 'Zed', 'Zed');
    expect(await editorIcon('zed', deps())).toMatch(/zed-\d+\.png$/);
  });

  it('finds the bundle through a CLI symlinked into it (code-insiders)', async () => {
    const elsewhere = path.join(tmp, 'Elsewhere');
    await fs.mkdir(elsewhere);
    const app = await bundle(elsewhere, 'Visual Studio Code - Insiders', 'Code - Insiders.icns');
    const bin = path.join(app, 'Contents', 'Resources', 'app', 'bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'code'), '');
    const link = path.join(tmp, 'code-insiders');
    await fs.symlink(path.join(bin, 'code'), link);
    const out = await editorIcon('vscode-insiders', deps({ detect: { dirs: async () => [], which: async (n) => (n === 'code-insiders' ? link : null) } }));
    expect(out).toMatch(/vscode-insiders-\d+\.png$/);
  });

  it("system is Finder's icon on macOS", async () => {
    await bundle(tmp, 'Finder', 'Finder.icns');
    expect(await editorIcon('system', deps())).toMatch(/system-\d+\.png$/);
  });

  it('null: not macOS, no bundle, no icon name, an icon name that leaves Resources, a failed conversion', async () => {
    await bundle(apps, 'Cursor', 'Cursor.icns');
    expect(await editorIcon('cursor', deps({ platform: 'linux' }))).toBeNull();
    expect(await editorIcon('zed', deps())).toBeNull();
    await bundle(apps, 'Zed', '../../../evil.icns');
    expect(await editorIcon('zed', deps())).toBeNull();
    const failing: RunFn = async (cmd, args) => (cmd === 'sips' ? { code: 1, stdout: '' } : fakeRun().run(cmd, args));
    expect(await editorIcon('cursor', deps({ run: failing }))).toBeNull();
    const noName: RunFn = async () => ({ code: 1, stdout: '' });
    expect(await editorIcon('cursor', deps({ run: noName }))).toBeNull();
  });
});
