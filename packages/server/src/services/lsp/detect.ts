// Is a language server (or the tool that installs one) on this machine?
// PATH alone is not enough: Strado is often launched from the dock with a
// bare PATH, while the user's npm, go and cargo binaries live in their home.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LspInstall, LspServerSpec } from './types.js';

export type Detect = {
  /** Absolute path of an executable named `name`, or null. */
  which(name: string): Promise<string | null>;
  /** The dirs searched, in order: PATH first, then the common bin dirs. */
  dirs(): Promise<string[]>;
};

function npmGlobalBin(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', ['prefix', '-g'], { timeout: 5000, env: process.env }, (err, stdout) => {
      const prefix = String(stdout ?? '').trim();
      resolve(err || !prefix ? null : path.join(prefix, 'bin'));
    });
  });
}

/** "v22.1.10" → [22, 1, 10]; anything else sorts last. */
function versionOf(name: string): number[] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}

/** Node version managers keep their bins out of a dock-launched app's PATH:
 *  nvm (newest version first), volta, fnm, asdf. */
async function versionManagerDirs(env: NodeJS.ProcessEnv, home: string): Promise<string[]> {
  const nvmDir = env.NVM_DIR || path.join(home, '.nvm');
  const versions = (await fs.readdir(path.join(nvmDir, 'versions', 'node')).catch(() => [] as string[]))
    .sort((a, b) => {
      const [x, y] = [versionOf(a), versionOf(b)];
      return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
    })
    .map((v) => path.join(nvmDir, 'versions', 'node', v, 'bin'));
  const fnmDirs = [env.FNM_DIR, path.join(home, '.local', 'share', 'fnm'), path.join(home, 'Library', 'Application Support', 'fnm')]
    .filter((d): d is string => !!d)
    .map((d) => path.join(d, 'aliases', 'default', 'bin'));
  return [
    ...(env.NVM_BIN ? [env.NVM_BIN] : []),
    ...versions,
    path.join(env.VOLTA_HOME || path.join(home, '.volta'), 'bin'),
    ...fnmDirs,
    path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'shims'),
  ];
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function createDetect(o: { env?: NodeJS.ProcessEnv; home?: string; npmBin?: () => Promise<string | null> } = {}): Detect {
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  let dirsP: Promise<string[]> | null = null;
  const dirs = () =>
    (dirsP ??= (async () => {
      const common = [
        path.join(home, '.npm-global', 'bin'),
        path.join(home, 'go', 'bin'),
        path.join(home, '.cargo', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(home, '.local', 'bin'),
      ];
      const managers = await versionManagerDirs(env, home);
      const npm = await (o.npmBin ?? npmGlobalBin)().catch(() => null);
      const all = [...(env.PATH ?? '').split(path.delimiter), ...common, ...managers, ...(npm ? [npm] : [])];
      return [...new Set(all.filter((d) => d && path.isAbsolute(d)))];
    })());
  return {
    dirs,
    async which(name) {
      // A bare name only: an argv[0] with a slash is a path we were given.
      if (name.includes('/')) return path.isAbsolute(name) && (await isExecutable(name)) ? name : null;
      for (const d of await dirs()) {
        const p = path.join(d, name);
        if (await isExecutable(p)) return p;
      }
      return null;
    },
  };
}

/** The spec's install commands for this OS, each with whether its tool is here. */
export async function installOptions(
  spec: LspServerSpec,
  detect: Detect,
  platform: NodeJS.Platform = process.platform,
): Promise<(LspInstall & { available: boolean })[]> {
  const mine = spec.install.filter((i) => !i.os || i.os === platform);
  return Promise.all(mine.map(async (i) => ({ ...i, available: !i.needs || (await detect.which(i.needs)) !== null })));
}
