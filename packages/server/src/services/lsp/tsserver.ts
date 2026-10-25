// typescript-language-server needs a TypeScript install and looks only in the
// workspace root's node_modules. A plain-JS repo, or one whose project sits
// in a subfolder (dashboard/), has none there, and it refuses to start. We
// find one for it: the project's own first, then the TypeScript installed
// globally beside the server, then npm's global root.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const TSSERVER = path.join('typescript', 'lib', 'tsserver.js');

const isFile = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);

/** Shown when the only TypeScript around is 7+, the native one with no tsserver. */
export const TS7_ONLY =
  'TypeScript 7 has no tsserver — install typescript@5 globally (npm install -g typescript@5) or add typescript to the project';

export type TsserverLookup = {
  /** The tsserver.js to hand over; null = the root has its own, or none was found. */
  path: string | null;
  /** None was usable, but a TypeScript without tsserver.js (7+) was there. */
  onlyTs7: boolean;
};

export function npmGlobalRoot(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', ['root', '-g'], { timeout: 5000, env }, (err, stdout) => {
      const root = String(stdout ?? '').trim();
      resolve(err || !root ? null : root);
    });
  });
}

/**
 * The tsserver.js to hand typescript-language-server. A TypeScript with no
 * lib/tsserver.js (7+, native) is passed over wherever it is, the root's too:
 * typescript-language-server cannot run on it.
 */
export async function tsserverPathFor(
  root: string,
  binary: string,
  npmRoot: () => Promise<string | null>,
): Promise<TsserverLookup> {
  let sawTs7 = false;
  /** The tsserver.js under `nodeModules`, noting a TypeScript that has none. */
  const at = async (nodeModules: string): Promise<string | null> => {
    const p = path.join(nodeModules, TSSERVER);
    if (await isFile(p)) return p;
    if (await isFile(path.join(nodeModules, 'typescript', 'package.json')) || (await isFile(path.join(nodeModules, 'typescript', 'lib', 'tsc.js')))) {
      sawTs7 = true;
    }
    return null;
  };
  const found = (p: string): TsserverLookup => ({ path: p, onlyTs7: false });

  if (await at(path.join(root, 'node_modules'))) return { path: null, onlyTs7: false };

  // The project one folder down (a monorepo app, a projectSubdir).
  const dirs = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => d.name)
    .sort();
  for (const d of dirs) {
    const p = await at(path.join(root, d, 'node_modules'));
    if (p) return found(p);
  }

  // Installed globally with the server: <prefix>/lib/node_modules/typescript-language-server
  // beside <prefix>/lib/node_modules/typescript (npm i -g typescript-language-server typescript).
  const real = await fs.realpath(binary).catch(() => binary);
  for (let d = path.dirname(real); d !== path.dirname(d); d = path.dirname(d)) {
    if (path.basename(d) === 'typescript-language-server' && path.basename(path.dirname(d)) === 'node_modules') {
      const p = await at(path.dirname(d));
      if (p) return found(p);
      break;
    }
  }

  const global = await npmRoot().catch(() => null);
  if (global) {
    const p = await at(global);
    if (p) return found(p);
  }
  return { path: null, onlyTs7: sawTs7 };
}
