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
      const npm = await (o.npmBin ?? npmGlobalBin)().catch(() => null);
      const all = [...(env.PATH ?? '').split(path.delimiter), ...common, ...(npm ? [npm] : [])];
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
