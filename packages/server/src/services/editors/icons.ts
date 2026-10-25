// The real app icon for an editor (macOS only), for the Open in editor menu.
// The app bundle is found the way detection finds editors, or through a CLI
// that is a symlink into one (code-insiders → …/Visual Studio Code -
// Insiders.app/…). Its icon (CFBundleIconFile) is converted once to a 64px
// PNG with sips and cached under STRADO_HOME/cache/editor-icons. Only ids
// from EDITORS come in; no path is ever taken from a request.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Detect } from '../lsp/detect.js';
import { EDITORS, type EditorId } from './types.js';

export type RunFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export type IconDeps = {
  detect: Detect;
  platform?: NodeJS.Platform;
  appDirs?: string[];
  cacheDir?: string;
  /** The 'system' editor's icon on macOS. */
  finderApp?: string;
  run?: RunFn;
};

const realRun: RunFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

export function editorIconCacheDir(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'cache', 'editor-icons');
}

const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);

/** The innermost-first `<…>.app` a path lies inside, or null. */
function bundleOf(p: string): string | null {
  const parts = p.split(path.sep);
  for (let i = parts.length - 1; i > 0; i--) if (parts[i]!.endsWith('.app')) return parts.slice(0, i + 1).join(path.sep);
  return null;
}

async function appBundle(id: EditorId, deps: IconDeps): Promise<string | null> {
  if (id === 'system') return deps.finderApp ?? '/System/Library/CoreServices/Finder.app';
  const spec = EDITORS.find((e) => e.id === id);
  if (!spec) return null;
  if (spec.macApp) {
    for (const dir of deps.appDirs ?? ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const app = path.join(dir, `${spec.macApp}.app`);
      if (await isDir(app)) return app;
    }
  }
  if (spec.cli) {
    const cli = await deps.detect.which(spec.cli);
    const real = cli ? await fs.realpath(cli).catch(() => null) : null;
    const app = real ? bundleOf(real) : null;
    if (app && (await isDir(app))) return app;
  }
  return null;
}

/** The cached PNG's path, or null (not macOS, no bundle, no icon, conversion failed). */
export async function editorIcon(id: EditorId, deps: IconDeps): Promise<string | null> {
  if ((deps.platform ?? process.platform) !== 'darwin') return null;
  const run = deps.run ?? realRun;
  const app = await appBundle(id, deps);
  if (!app) return null;
  const plist = await run('plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
  const name = plist.stdout.trim();
  if (plist.code !== 0 || !name || name.includes('/') || name.startsWith('.')) return null;
  const icns = path.join(app, 'Contents', 'Resources', name.endsWith('.icns') ? name : `${name}.icns`);
  const st = await fs.stat(icns).catch(() => null);
  if (!st?.isFile()) return null;
  const cacheDir = deps.cacheDir ?? editorIconCacheDir();
  // Keyed by the icon's mtime: an app update with a new icon converts again.
  const out = path.join(cacheDir, `${id}-${Math.floor(st.mtimeMs)}.png`);
  if (await fs.stat(out).then((s) => s.size > 0, () => false)) return out;
  await fs.mkdir(cacheDir, { recursive: true });
  const conv = await run('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out]);
  if (conv.code !== 0 || !(await fs.stat(out).then((s) => s.size > 0, () => false))) {
    await fs.rm(out, { force: true }).catch(() => {});
    return null;
  }
  return out;
}
