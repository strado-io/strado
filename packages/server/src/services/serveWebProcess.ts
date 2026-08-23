import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Spawn-time env tag. macOS does NOT expose a process's environment via `ps`
// (any format), so this is NOT usable for cross-restart orphan discovery — it
// survives only as a human-greppable marker (and a Linux /proc cross-check).
// Orphan discovery is pidfile-based instead (see the daemon registry below).
export const MARKER = 'STRADO_SERVE_WEB';

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

// Kill the whole process group led by `pid` (daemon + serve-web's per-workspace
// backend children). Requires the child to have been spawned `detached: true`
// so it leads its own group. Best-effort.
export function killTree(
  pid: number,
  kill: (pid: number, sig: NodeJS.Signals) => void = (p, s) => process.kill(p, s),
): void {
  if (!pid || !Number.isInteger(pid)) return;
  try { kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
}

// ── Daemon registry (pidfile) ────────────────────────────────────────────────
// We persist every serve-web daemon we spawn to a small JSON file so that after
// a crash / force-quit (which skip the in-process closeAll), the next launch can
// find and reap the orphans. This works identically on macOS and Linux, and is
// strictly "only ours" — we only ever kill a pid we recorded, and only after a
// command-line sanity check guards against PID reuse.

export type DaemonEntry = { pid: number; port: number };

export function daemonFilePath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'serve-web-daemons.json');
}

export function readDaemonFile(file: string): DaemonEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is DaemonEntry =>
        e && typeof e.pid === 'number' && typeof e.port === 'number',
    );
  } catch { return []; }
}

export function writeDaemonFile(file: string, list: DaemonEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, file); // atomic replace
  } catch { /* best-effort — a lost record just means a possible future orphan */ }
}

// Persisted serve-web port. serve-web keeps the workbench's USER settings in
// browser storage keyed by origin (host:port) — a fresh random port every app
// start means a fresh origin and silently wiped user settings/theme/layout.
// Pinning the app's shared instance to its first allocated port keeps the
// origin (and therefore the user's editor state) stable across restarts.
export function portsFilePath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'serve-web-ports.json');
}

export function readPortsFile(file: string): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

export function writePortsFile(file: string, map: Record<string, number>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, file); // atomic replace
  } catch { /* best-effort — a lost record just means one more origin change */ }
}

export function recordDaemon(file: string, entry: DaemonEntry): void {
  const list = readDaemonFile(file).filter((e) => e.pid !== entry.pid);
  list.push(entry);
  writeDaemonFile(file, list);
}

export function forgetDaemon(file: string, pid: number): void {
  writeDaemonFile(file, readDaemonFile(file).filter((e) => e.pid !== pid));
}

export function isAlive(pid: number): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// PID-reuse guard: confirm the pid is (still) a serve-web process before we kill
// it. `ps -o command=` returns the command line on both macOS and Linux (unlike
// env, which macOS hides). Injectable for tests.
export function looksLikeServeWeb(
  pid: number,
  readCmd: (pid: number) => string = defaultReadCmd,
): boolean {
  return readCmd(pid).includes('serve-web');
}

function defaultReadCmd(pid: number): string {
  try {
    // Runs on the startup path (reapOrphans) — bound it so a wedged `ps` can
    // never stall boot.
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      maxBuffer: 1024 * 1024,
      timeout: 2000,
    }).toString();
  } catch { return ''; }
}
