// Which serve-web window (extension-host pid) is showing which folder.
//
// Fed by the bundled strado-window extension (hooks/vscode-extension), which
// posts its pid + workspace folder on activation and every 30s after. The
// Sessions view attributes each host's process tree to that worktree.
import { sampleProcesses } from './sessionMetrics.js';

export type VsCodeWindow = { pid: number; folder: string };

/** SIGTERM `pid` and every descendant (an extension host leads no process group). */
export async function killProcessTree(pid: number): Promise<void> {
  const procs = await sampleProcesses();
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const order: number[] = [];
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    order.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  // leaves first, so nothing reparents to init mid-kill
  for (const p of order.reverse()) {
    try { process.kill(p, 'SIGTERM'); } catch { /* already gone */ }
  }
}

export type VsCodeWindowRegistry = {
  report(pid: number, folder: string): void;
  forget(pid: number): void;
  /** end every window showing `folder` (its tab closed); returns how many */
  closeFolder(folder: string, kill?: (pid: number) => Promise<void>): Promise<number>;
  /** live windows: host still running and heard from within the TTL */
  list(): VsCodeWindow[];
};

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export function createVsCodeWindowRegistry(deps: {
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  ttlMs?: number;
} = {}): VsCodeWindowRegistry {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 90_000; // three missed heartbeats
  const windows = new Map<number, { folder: string; seenAt: number }>();
  return {
    report(pid, folder) {
      windows.set(pid, { folder, seenAt: now() });
    },
    forget(pid) {
      windows.delete(pid);
    },
    async closeFolder(folder, kill = killProcessTree) {
      const pids = [...windows].filter(([, w]) => w.folder === folder).map(([pid]) => pid);
      for (const pid of pids) {
        windows.delete(pid);
        await kill(pid);
      }
      return pids.length;
    },
    list() {
      const t = now();
      const out: VsCodeWindow[] = [];
      for (const [pid, w] of windows) {
        if (t - w.seenAt > ttl || !isAlive(pid)) { windows.delete(pid); continue; }
        out.push({ pid, folder: w.folder });
      }
      return out.sort((a, b) => a.pid - b.pid);
    },
  };
}

export const vscodeWindows = createVsCodeWindowRegistry();
