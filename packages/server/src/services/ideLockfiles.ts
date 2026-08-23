import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockPid(file: string, raw: string): number | null {
  try {
    const j = JSON.parse(raw) as { pid?: number };
    if (typeof j.pid === 'number') return j.pid;
  } catch { /* fall through to filename */ }
  const stem = path.basename(file, '.lock');
  const n = Number(stem);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Delete only the `.lock` files whose owning PID is one we just killed AND is
// no longer alive. Never touches locks for live processes or PIDs we did not
// spawn. Best-effort; swallows all FS errors.
export function pruneDeadIdeLocks(
  pids: number[],
  deps: { dir?: string; isAlive?: (pid: number) => boolean } = {},
): void {
  const dir = deps.dir ?? path.join(os.homedir(), '.claude', 'ide');
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const ours = new Set(pids);
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(dir, name);
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* filename-only */ }
    const pid = lockPid(name, raw);
    if (pid === null || !ours.has(pid) || isAlive(pid)) continue;
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  }
}
