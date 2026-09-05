import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `code serve-web` ignores the installed CLI's version: on every launch it asks
// the update service for the LATEST commit of its quality and downloads that
// build (~650MB) if not cached — a 3-4 minute stall behind a placeholder page,
// daily on insiders. Passing `--commit-id <sha>` skips that lookup entirely and
// boots the cached build in ~1s. This module picks the sha to pin: the head of
// the CLI's own LRU list (most-recently-USED first — a manual `serve-web
// --commit-id <old>` run would put an old build there; the manager's warm-up
// run is what keeps the newest build at the head), provided its build dir
// actually exists (in-flight downloads live in `<sha>.staging` and are not in
// the LRU, so a plain existence check is enough).

type Deps = { home?: string; env?: NodeJS.ProcessEnv };

const SHA = /^[0-9a-f]{40}$/;

export function cliDataDir(cli: string, deps: Deps = {}): string | null {
  const env = deps.env ?? process.env;
  if (env.VSCODE_CLI_DATA_DIR) return env.VSCODE_CLI_DATA_DIR;
  const home = deps.home ?? os.homedir();
  const dir =
    cli === 'code-insiders' ? '.vscode-insiders'
    : cli === 'code' ? '.vscode'
    : null;
  return dir ? path.join(home, dir, 'cli') : null;
}

export function pinnedCommit(cli: string, deps: Deps = {}): string | null {
  const dataDir = cliDataDir(cli, deps);
  if (!dataDir) return null;
  const root = path.join(dataDir, 'serve-web');
  let lru: unknown;
  try { lru = JSON.parse(fs.readFileSync(path.join(root, 'lru.json'), 'utf8')); } catch { return null; }
  if (!Array.isArray(lru)) return null;
  for (const sha of lru) {
    if (typeof sha !== 'string' || !SHA.test(sha)) continue;
    try { if (fs.statSync(path.join(root, sha)).isDirectory()) return sha; } catch { /* missing → next */ }
  }
  return null;
}
