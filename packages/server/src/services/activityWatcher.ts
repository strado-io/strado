import fs from 'node:fs';
import path from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

// File saves are the editor-agnostic activity signal: embedded VS Code,
// native editors, and agents all hit the disk. Reads never fire events, so
// watching is beat-only — no content, no filenames leave this module.
//
// Two backends, picked by platform:
//
// - darwin: fs.watch({ recursive: true }) — one native FSEvents stream per
//   worktree. Setup is O(1) (no traversal, no per-directory descriptors), so
//   watching 30+ large worktrees is instant. The ignore list is applied in
//   the event callback. chokidar v5 is NOT used here: it is pure JS (no
//   fsevents), so it walks every directory and opens a watcher per dir —
//   on real repos that initial scan starved the server's event loop for
//   ~40s and froze the dashboard on "Loading…".
//
// - linux: chokidar with an `ignored` filter that runs DURING traversal, so
//   ignored subtrees (node_modules etc.) are never watched at all. This is
//   what keeps us under fs.inotify.max_user_watches — the native recursive
//   fs.watch on Linux registers one inotify watch per directory INCLUDING
//   all of node_modules, which exhausted the limit for a tester. Setup does
//   traverse the tree, so worktrees are scanned ONE AT A TIME (a queue) to
//   keep the event loop responsive while big trees warm up.
const IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.strado-uploads',
]);

function hasIgnoredSegment(rel: string): boolean {
  return rel.split(path.sep).some((seg) => IGNORED_SEGMENTS.has(seg));
}

export type WorktreeWatcher = {
  /** Additive: start watching any of these paths not already watched. */
  ensure(paths: string[]): void;
  remove(worktreePath: string): void;
  close(): void;
};

export function createWorktreeWatcher(opts: {
  touch(worktreePath: string): void;
  now?: () => number;
  throttleMs?: number;
  platform?: NodeJS.Platform;
}): WorktreeWatcher {
  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? 30_000;
  const platform = opts.platform ?? process.platform;
  const lastBeat = new Map<string, number>();

  function beat(p: string) {
    const t = now();
    const last = lastBeat.get(p);
    if (last !== undefined && t - last < throttleMs) return;
    lastBeat.set(p, t);
    opts.touch(p);
  }

  return platform === 'darwin'
    ? createNativeWatcher(beat, lastBeat)
    : createChokidarWatcher(beat, lastBeat);
}

// ── darwin: native FSEvents via fs.watch({recursive}) ───────────────────────

function createNativeWatcher(
  beat: (p: string) => void,
  lastBeat: Map<string, number>,
): WorktreeWatcher {
  const watchers = new Map<string, fs.FSWatcher>();

  function drop(worktreePath: string) {
    const w = watchers.get(worktreePath);
    if (!w) return;
    watchers.delete(worktreePath);
    lastBeat.delete(worktreePath);
    try { w.close(); } catch { /* already closed */ }
  }

  return {
    ensure(paths) {
      for (const p of paths) {
        if (watchers.has(p)) continue;
        let watcher: fs.FSWatcher;
        try {
          // filename is relative to the watch root; drop events from ignored
          // subtrees so builds/.git churn can't fake activity. A null filename
          // (rare, coalesced events) counts as a beat — better a false beat
          // than a missed one.
          watcher = fs.watch(p, { recursive: true }, (_event, filename) => {
            if (typeof filename === 'string' && filename && hasIgnoredSegment(filename)) return;
            beat(p);
          });
        } catch {
          continue; // path vanished between listing and watching
        }
        watcher.on('error', () => drop(p));
        watchers.set(p, watcher);
      }
    },
    remove: drop,
    close() {
      for (const p of [...watchers.keys()]) drop(p);
    },
  };
}

// ── linux (and anything non-darwin): chokidar, serialized setup ─────────────

function createChokidarWatcher(
  beat: (p: string) => void,
  lastBeat: Map<string, number>,
): WorktreeWatcher {
  const watchers = new Map<string, FSWatcher>();
  // Startup queue: initial scans run one worktree at a time. Kicking off many
  // big trees at once floods the event loop with readdir callbacks and starves
  // every in-flight request.
  const queue: string[] = [];
  const queued = new Set<string>();
  let draining = false;
  let closed = false;

  // Ignore the configured segments RELATIVE to the worktree root. Matching
  // against the absolute path would wrongly ignore an entire worktree that
  // happens to live under e.g. a `build/` directory. chokidar skips descending
  // into any directory this returns true for.
  function makeIgnored(root: string) {
    return (file: string): boolean => {
      const rel = path.relative(root, file);
      if (rel === '' || rel.startsWith('..')) return false; // root itself / outside
      return hasIgnoredSegment(rel);
    };
  }

  function drop(worktreePath: string) {
    if (queued.delete(worktreePath)) {
      const i = queue.indexOf(worktreePath);
      if (i >= 0) queue.splice(i, 1);
    }
    const w = watchers.get(worktreePath);
    if (!w) return;
    watchers.delete(worktreePath);
    lastBeat.delete(worktreePath);
    // Detach synchronously so no beat fires after remove(), regardless of when
    // the async close() settles; then tear the watcher down.
    w.removeAllListeners();
    void Promise.resolve(w.close()).catch(() => { /* already closing */ });
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !closed) {
        const p = queue.shift()!;
        queued.delete(p);
        if (watchers.has(p)) continue;
        let watcher: FSWatcher;
        try {
          watcher = chokidarWatch(p, {
            ignored: makeIgnored(p),
            ignoreInitial: true, // the startup scan must not fire a false beat
            persistent: true,
          });
        } catch {
          continue; // path vanished between listing and watching
        }
        // Any create/modify/delete of a non-ignored file is one activity beat,
        // throttled per worktree. No filename or content is used.
        watcher.on('all', () => beat(p));
        watcher.on('error', () => drop(p));
        watchers.set(p, watcher);
        // Wait for this tree's initial scan before starting the next one, with
        // a cap so one wedged scan can't stall the queue forever.
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(cap);
            resolve();
          };
          const cap = setTimeout(finish, 60_000);
          cap.unref?.();
          watcher.once('ready', finish);
          watcher.once('error', finish);
        });
      }
    } finally {
      draining = false;
    }
  }

  return {
    ensure(paths) {
      for (const p of paths) {
        if (watchers.has(p) || queued.has(p)) continue;
        queued.add(p);
        queue.push(p);
      }
      void drain();
    },
    remove: drop,
    close() {
      closed = true;
      queue.length = 0;
      queued.clear();
      for (const p of [...watchers.keys()]) drop(p);
    },
  };
}
