// Drop the bundled strado-window extension into serve-web's extensions dir so
// every window's extension host loads it. Same per-CLI layout the settings
// seeding uses (vscodeSettings.ts); code-server differs and is skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hooksDir } from './claudeHooks.js';

const ID = 'strado.strado-window';

export function stradoExtensionSource(): string {
  return path.join(hooksDir(), 'vscode-extension');
}

export function serverExtensionsDir(cli: string, home = os.homedir()): string | null {
  const dir =
    cli === 'code-insiders' ? '.vscode-server-insiders'
    : cli === 'code' ? '.vscode-server'
    : null;
  return dir ? path.join(home, dir, 'extensions') : null;
}

/** Installs (or refreshes) the extension; returns its folder, or null when skipped. Never throws. */
export function installStradoExtension(cli: string, deps: { home?: string } = {}): string | null {
  const extDir = serverExtensionsDir(cli, deps.home);
  if (!extDir) return null;
  try {
    const src = stradoExtensionSource();
    const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')) as { version: string };
    const dest = path.join(extDir, `${ID}-${pkg.version}`);
    fs.mkdirSync(extDir, { recursive: true });
    for (const entry of fs.readdirSync(extDir)) {
      if (entry.startsWith(`${ID}-`) && entry !== path.basename(dest)) {
        fs.rmSync(path.join(extDir, entry), { recursive: true, force: true });
      }
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const file of ['package.json', 'extension.js']) {
      fs.copyFileSync(path.join(src, file), path.join(dest, file));
    }
    return dest;
  } catch {
    return null; // never block editor open on an install hiccup
  }
}
