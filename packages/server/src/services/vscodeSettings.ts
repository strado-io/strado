import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'typescript.tsserver.maxTsServerMemory';

// serve-web stores server-side user/machine settings under a per-CLI dir.
// Machine scope is right for a tsserver memory floor. code-server uses a
// different layout — return null and let the caller skip it.
export function serverSettingsPath(cli: string, home = os.homedir()): string | null {
  const dir =
    cli === 'code-insiders' ? '.vscode-server-insiders'
    : cli === 'code' ? '.vscode-server'
    : null;
  if (!dir) return null;
  return path.join(home, dir, 'data', 'Machine', 'settings.json');
}

// Merge the tsserver memory floor into the serve-web Machine settings, only if
// the user has not already set it. Preserves every other key. Best-effort.
export function ensureTsServerMemory(cli: string, deps: { home?: string; mb?: number } = {}): void {
  const p = serverSettingsPath(cli, deps.home);
  if (!p) return;
  const mb = deps.mb ?? 4096;
  try {
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { /* absent/corrupt → start fresh */ }
    if (Object.prototype.hasOwnProperty.call(current, KEY)) return; // respect the user
    current[KEY] = mb;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(current, null, 2));
  } catch { /* never block editor open on a settings write */ }
}
