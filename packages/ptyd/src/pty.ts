import fs from 'node:fs';
import tty from 'node:tty';
import childProcess from 'node:child_process';
import * as nodePty from 'node-pty';
import type { SessionMeta } from './protocol.js';

export interface Pty {
  pid: number;
  cols: number;
  rows: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** SIGHUP now; process-group SIGKILL after 2s if the root is still alive. */
  kill(): void;
  /** Immediate SIGKILL — daemon shutdown path. */
  killNow(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
  pause(): void;
  resume(): void;
  /**
   * The kernel master fd backing this PTY — required for handoff fd
   * inheritance. node-pty 1.2.0-beta.14 exposes it as the public `fd`
   * getter (absent from IPty typings); asserted at spawn so a future
   * node-pty bump that drops it fails at first terminal open, not at
   * upgrade time months later.
   */
  getMasterFd(): number;
  /**
   * AdoptedPty only: release this process's copy of the master fd without
   * signaling the shell — failed-handoff rollback in the successor.
   */
  closeLocal?(): void;
}

const KILL_GRACE_MS = 2_000;

function validateDims(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols <= 0) throw new Error(`invalid cols: ${cols}`);
  if (!Number.isInteger(rows) || rows <= 0) throw new Error(`invalid rows: ${rows}`);
}

function signalGroupKill(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL'); // negative pid → whole process group (MCP servers etc.)
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** SIGHUP now; group SIGKILL after the grace period unless isExited() by then. */
function escalatingKill(pid: number, sighup: () => void, isExited: () => boolean): void {
  sighup();
  // Timer stays ref'd: a daemon that exits before the escalation lands
  // would leak the survivor. (Known gap: a handoff exits the predecessor
  // mid-grace and drops the escalation — documented in the plan.)
  setTimeout(() => {
    if (!isExited()) signalGroupKill(pid);
  }, KILL_GRACE_MS);
}

export function spawnPty(meta: SessionMeta): Pty {
  validateDims(meta.cols, meta.rows);
  // Pre-flight: node-pty's "posix_spawnp failed" swallows errno. The common
  // cause is a deleted/moved worktree — surface it as a readable message.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(meta.cwd);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') throw new Error(`cwd does not exist: ${meta.cwd}`);
    throw new Error(`cwd not accessible: ${meta.cwd} (${e.code ?? e.message})`);
  }
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${meta.cwd}`);

  const term = nodePty.spawn(meta.shell, meta.argv, {
    name: 'xterm-256color',
    cols: meta.cols,
    rows: meta.rows,
    cwd: meta.cwd,
    env: meta.env,
    // Raw bytes for fidelity — decoding happens exactly once, in the server.
    encoding: null as unknown as string,
  });

  let exited = false;
  let exitCode: number | null = null;
  const exitCbs: Array<(code: number | null) => void> = [];
  let cols = meta.cols;
  let rows = meta.rows;

  term.onExit(({ exitCode: code }) => {
    if (exited) return;
    exited = true;
    exitCode = code ?? null;
    for (const cb of exitCbs) cb(exitCode);
  });

  const adapter: Pty = {
    get pid() { return term.pid; },
    get cols() { return cols; },
    get rows() { return rows; },
    write(data: Buffer) {
      // node-pty accepts Buffer at runtime; its typings say string.
      term.write(data as unknown as string);
    },
    resize(c: number, r: number) {
      validateDims(c, r);
      if (exited) return;
      // A resize racing the process exit hits a closed master fd; node-pty's
      // native ioctl then throws (EBADF). Swallow it like the old in-process
      // manager did — the session is gone, the resize is moot.
      try {
        term.resize(c, r);
      } catch {
        return;
      }
      cols = c;
      rows = r;
    },
    kill() {
      escalatingKill(term.pid, () => {
        try { term.kill(); } catch { /* already gone */ } // SIGHUP: graceful for shells
      }, () => exited);
    },
    killNow() {
      signalGroupKill(term.pid);
    },
    onData(cb) {
      term.onData((d) => cb(typeof d === 'string' ? Buffer.from(d, 'utf8') : d));
    },
    onExit(cb) {
      if (exited) { cb(exitCode); return; }
      exitCbs.push(cb);
    },
    pause() { if (!exited) term.pause(); },
    resume() { if (!exited) term.resume(); },
    getMasterFd() {
      const fd = (term as unknown as { fd?: unknown }).fd;
      if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 0) {
        throw new Error(
          `node-pty master fd unavailable (got ${typeof fd}). fd handoff depends on ` +
            `UnixTerminal's public fd getter — keep node-pty pinned or update pty.ts.`,
        );
      }
      return fd;
    },
  };

  try {
    adapter.getMasterFd();
  } catch (err) {
    try { term.kill('SIGKILL'); } catch { /* already gone */ }
    throw err;
  }
  return adapter;
}

export interface AdoptOptions {
  fd: number;
  pid: number;
  cols: number;
  rows: number;
}

/**
 * Wraps a PTY master fd inherited from a predecessor daemon. No node-pty
 * object exists for it (no forkpty ran here), so:
 *  - read via tty.ReadStream(fd)
 *  - write via an ordered async queue (EAGAIN-safe)
 *  - resize via `stty` with the master fd as stdin (no TIOCSWINSZ binding)
 *  - exit via reader 'end'/'error' (slave close → EOF/EIO) plus a 1s
 *    pid-liveness poll as defense in depth
 *
 * The inherited fd number is used AS-IS. Re-opening it (`/dev/fd/N`) is not
 * an option: on Linux that path resolves to the ptmx device node, so the
 * open allocates a brand-new, unrelated pty instead of a second reference to
 * the inherited one — a silently dead session. In production the fd arrives
 * through child-process stdio inheritance, so this process is its sole user
 * and the descriptor IS "OUR copy" that closeLocal() releases (reader
 * autoClose does it).
 */
export function adoptFromFd(opts: AdoptOptions): Pty {
  const { pid, fd } = opts;
  if (!Number.isInteger(fd) || fd < 0) throw new Error(`invalid fd: ${fd}`);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${pid}`);
  validateDims(opts.cols, opts.rows);
  if (!tty.isatty(fd)) throw new Error(`fd ${fd} is not a tty`);

  let cols = opts.cols;
  let rows = opts.rows;
  let exited = false;
  let exitCode: number | null = null;
  let disposed = false;
  const exitCbs: Array<(code: number | null) => void> = [];
  // Nothing is opened here, so a throw out of the ReadStream constructor
  // leaks nothing of ours — the inherited descriptor stays the caller's.
  const reader = new tty.ReadStream(fd);

  const livenessTimer: NodeJS.Timeout = setInterval(() => {
    if (!isPidAlive(pid)) fireExit();
  }, 1_000);
  livenessTimer.unref();

  function fireExit(): void {
    if (exited) return;
    exited = true;
    exitCode = null; // no wait() channel for an adopted child — code unknowable
    clearInterval(livenessTimer);
    try { reader.destroy(); } catch { /* already closed after EOF/EIO */ }
    for (const cb of exitCbs) cb(exitCode);
  }
  reader.on('end', fireExit);
  reader.on('error', (err) => {
    // EAGAIN on a non-blocking master is transient, not EOF.
    if ((err as NodeJS.ErrnoException).code === 'EAGAIN') return;
    fireExit();
  });

  // Master fds are non-blocking (the ReadStream flips O_NONBLOCK on the
  // shared description); a busy shell can make writes EAGAIN. Queue and
  // retry, preserving order — same approach as node-pty's CustomWriteStream.
  const writeQueue: Buffer[] = [];
  let writing = false;
  const drainWrites = () => {
    if (writing) return;
    writing = true;
    const step = () => {
      if (exited || disposed || writeQueue.length === 0) { writing = false; return; }
      const head = writeQueue[0]!;
      fs.write(fd, head, 0, head.byteLength, (err, written) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'EAGAIN') { setImmediate(step); return; }
          // Any other error: the fd is gone or hosed — drop the queue; the
          // exit paths (reader error / pid poll) own session teardown.
          writeQueue.length = 0; writing = false; return;
        }
        if (written >= head.byteLength) writeQueue.shift();
        else writeQueue[0] = head.subarray(written);
        setImmediate(step);
      });
    };
    step();
  };

  return {
    get pid() { return pid; },
    get cols() { return cols; },
    get rows() { return rows; },
    write(data: Buffer) {
      if (exited || disposed) return;
      writeQueue.push(data);
      drainWrites();
    },
    resize(c: number, r: number) {
      validateDims(c, r);
      if (exited || disposed) return;
      // stty issues TIOCSWINSZ on its own stdin. One spawn per resize —
      // resize is rare (window drags are throttled by xterm.js).
      // spawnSync reports failure in its result, it does not throw; only
      // commit the new dims when stty actually succeeded.
      const res = childProcess.spawnSync('stty', ['cols', String(c), 'rows', String(r)], {
        stdio: [fd, 'ignore', 'ignore'],
        timeout: 1000,
      });
      if (!res.error && res.status === 0) {
        cols = c;
        rows = r;
      }
      // Otherwise best-effort: kernel-side stays stale, meta stays at last-known.
    },
    kill() {
      escalatingKill(pid, () => {
        try { process.kill(pid, 'SIGHUP'); } catch { /* already dead */ }
      }, () => exited);
    },
    killNow() {
      signalGroupKill(pid);
    },
    onData(cb) {
      reader.on('data', (chunk) => cb(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    },
    onExit(cb) {
      if (exited) { cb(exitCode); return; }
      exitCbs.push(cb);
    },
    pause() { if (!exited && !disposed) reader.pause(); },
    resume() { if (!exited && !disposed) reader.resume(); },
    getMasterFd() {
      if (disposed || exited) throw new Error('adopted pty disposed');
      return fd;
    },
    closeLocal() {
      // Rollback: release OUR copy only. The shell is not signaled; the
      // predecessor still owns and serves the session. reader.destroy()
      // closes the inherited descriptor (autoClose) — exactly our copy.
      if (disposed) return;
      disposed = true;
      clearInterval(livenessTimer);
      try { reader.destroy(); } catch { /* stream may be gone */ }
    },
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but not ours — count as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
