// The embedded VS Code (`code serve-web`) is gone. A Strado that ran it may
// have left daemons behind, recorded in STRADO_HOME/serve-web-daemons.json,
// plus a port record. On start they are stopped and the records removed, once.
// VS Code's own CLI cache (~/.vscode/cli) is VS Code's and is never touched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type CleanupDeps = {
  home?: string;
  alive?: (pid: number) => boolean;
  /** The pid's command line ('' when unknown). */
  command?: (pid: number) => string;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandOf(pid: number): string {
  try {
    // On the startup path: bounded so a wedged ps can never stall boot.
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 2000, maxBuffer: 1024 * 1024 }).toString();
  } catch {
    return '';
  }
}

async function readPids(file: string): Promise<number[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) => (e && typeof e === 'object' ? (e as { pid?: unknown }).pid : undefined))
      .filter((p): p is number => typeof p === 'number' && Number.isInteger(p) && p > 1);
  } catch {
    return [];
  }
}

/** Never throws: a failure here must not stop the server starting. */
export async function cleanupServeWeb(deps: CleanupDeps = {}): Promise<{ stopped: number[] }> {
  const home = deps.home ?? (process.env.STRADO_HOME || path.join(os.homedir(), '.strado'));
  const alive = deps.alive ?? isAlive;
  const command = deps.command ?? commandOf;
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const daemons = path.join(home, 'serve-web-daemons.json');
  const stopped: number[] = [];
  for (const pid of await readPids(daemons)) {
    // Only a pid we recorded, and only while it still is a serve-web: a pid
    // can be reused by anything since.
    if (!alive(pid) || !command(pid).includes('serve-web')) continue;
    try {
      // It led its own process group (spawned detached): its workbench children go too.
      kill(-pid, 'SIGTERM');
    } catch {
      try {
        kill(pid, 'SIGTERM');
      } catch {
        continue;
      }
    }
    stopped.push(pid);
  }
  for (const f of ['serve-web-daemons.json', 'serve-web-ports.json']) {
    await fs.rm(path.join(home, f), { force: true }).catch(() => {});
  }
  return { stopped };
}
