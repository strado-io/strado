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

export function npmGlobalRoot(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', ['root', '-g'], { timeout: 5000, env }, (err, stdout) => {
      const root = String(stdout ?? '').trim();
      resolve(err || !root ? null : root);
    });
  });
}

/**
 * The tsserver.js to hand typescript-language-server, or null when the root
 * has its own (the server finds that itself) or none can be found.
 */
export async function tsserverPathFor(
  root: string,
  binary: string,
  npmRoot: () => Promise<string | null>,
): Promise<string | null> {
  if (await isFile(path.join(root, 'node_modules', TSSERVER))) return null;

  // The project one folder down (a monorepo app, a projectSubdir).
  const dirs = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => d.name)
    .sort();
  for (const d of dirs) {
    const p = path.join(root, d, 'node_modules', TSSERVER);
    if (await isFile(p)) return p;
  }

  // Installed globally with the server: <prefix>/lib/node_modules/typescript-language-server
  // beside <prefix>/lib/node_modules/typescript (npm i -g typescript-language-server typescript).
  const real = await fs.realpath(binary).catch(() => binary);
  for (let d = path.dirname(real); d !== path.dirname(d); d = path.dirname(d)) {
    if (path.basename(d) === 'typescript-language-server' && path.basename(path.dirname(d)) === 'node_modules') {
      const p = path.join(path.dirname(d), TSSERVER);
      if (await isFile(p)) return p;
      break;
    }
  }

  const global = await npmRoot().catch(() => null);
  if (global) {
    const p = path.join(global, TSSERVER);
    if (await isFile(p)) return p;
  }
  return null;
}
