// Which serve-web window (extension-host pid) is showing which folder.
//
// Fed by the bundled strado-window extension (hooks/vscode-extension), which
// posts its pid + workspace folder on activation and every 30s after. The
// Sessions view attributes each host's process tree to that worktree.
export type VsCodeWindow = { pid: number; folder: string };

export type VsCodeWindowRegistry = {
  report(pid: number, folder: string): void;
  forget(pid: number): void;
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
