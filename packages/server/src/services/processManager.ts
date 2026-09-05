import { spawn, ChildProcess } from 'node:child_process';
import type { EventBus } from '../events/bus.js';
import type { DebugLog } from './debugLog.js';
import { AppError } from '../errors.js';
import { evictPortListeners, listeningPortsOfGroup, pgidOf, pidsOnPort } from './externalProcess.js';

// Short, greppable tag for the combined debug log (the key is a full path).
function logTag(key: string): string {
  return `${key.split('/').pop() || key} dev`;
}

// starting: spawned, nothing listening yet. running: a port is being served.
// stopping: stop requested, the process has not exited yet (still holds its
// port). The two transitional states exist so the UI can say what is going on
// instead of flipping straight from Run to Stop and back.
export type ProcStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

/** Holds (or is about to hold / still holds) a port. */
export function isLive(status: ProcStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping';
}

export type ProcInfo = {
  status: ProcStatus;
  pid: number | null;
  startedAt: string | null;
  port: number | null;
  detectedUrl: string | null;
  exitCode: number | null;
  external?: boolean;
};

export type StartOptions = {
  key: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  port: number;
};

const RING_LIMIT = 5_000;
const URL_PATTERN = /(https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./?=&%+#-]*)?)/;
// How often a starting process is probed for a listening port, and how long
// before we give up waiting and call it running anyway — a worker with no
// HTTP port would otherwise sit on "Starting" forever.
const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 60_000;

type Entry = {
  info: ProcInfo;
  child: ChildProcess | null;
  buffer: string[];
  lastOpts?: StartOptions;
  // one automatic EADDRINUSE eviction+retry per user-initiated start
  addrRetried?: boolean;
  // the current start's readiness poll; cleared on ready/exit
  readyTimer?: ReturnType<typeof setTimeout> | null;
};

export type ProcessManager = {
  start(opts: StartOptions): Promise<void>;
  stop(key: string): Promise<void>;
  status(key: string): ProcInfo;
  snapshot(key: string, tail?: number): string[];
  ownedPids(): Set<number>;
  isRunning(key: string): boolean;
  // keys of live processes bound to a port (listener pids can be grandchildren
  // of the managed shell, so pid matching alone can't identify ours)
  runningOnPort(port: number): string[];
};

export function createProcessManager(bus: EventBus, debugLog?: DebugLog): ProcessManager {
  const entries = new Map<string, Entry>();

  function ensure(key: string): Entry {
    let e = entries.get(key);
    if (!e) {
      e = {
        info: {
          status: 'idle',
          pid: null,
          startedAt: null,
          port: null,
          detectedUrl: null,
          exitCode: null,
        },
        child: null,
        buffer: [],
      };
      entries.set(key, e);
    }
    return e;
  }

  function push(entry: Entry, stream: 'stdout' | 'stderr', line: string, key: string) {
    entry.buffer.push(line);
    if (entry.buffer.length > RING_LIMIT) entry.buffer.shift();
    debugLog?.log(logTag(key), line);
    bus.emit(`logs:${key}`, { type: 'log', data: { stream, line, ts: new Date().toISOString() } });
    if (entry.info.detectedUrl === null) {
      const match = line.match(URL_PATTERN);
      if (match && entry.info.port && line.includes(String(entry.info.port))) {
        entry.info.detectedUrl = match[1] ?? null;
        // Printing its URL is as good as a bound socket: it is serving.
        if (entry.info.status === 'starting') markRunning(entry, key);
        else emitProcess(entry, key);
      }
    }
  }

  function emitProcess(entry: Entry, key: string, extra: Record<string, unknown> = {}) {
    bus.emit('worktrees', {
      type: 'worktree.updated',
      data: { path: key, ...extra, process: { ...entry.info } },
    });
  }

  function clearReadyTimer(entry: Entry) {
    if (entry.readyTimer) clearTimeout(entry.readyTimer);
    entry.readyTimer = null;
  }

  function markRunning(entry: Entry, key: string, port?: number) {
    if (entry.info.status !== 'starting') return;
    clearReadyTimer(entry);
    if (port !== undefined) entry.info.port = port;
    entry.info.status = 'running';
    emitProcess(entry, key);
  }

  // Poll the child's process group for a LISTEN socket. The first port to
  // appear flips the state to running; when the group binds several, the
  // configured one wins, else the lowest (app ports sit below HMR/inspector).
  function watchReadiness(entry: Entry, key: string, child: ChildProcess, configuredPort: number) {
    const startedAt = Date.now();
    const tick = async () => {
      entry.readyTimer = null;
      if (entry.child !== child || entry.info.status !== 'starting' || !child.pid) return;
      const ports = await listeningPortsOfGroup(child.pid);
      if (entry.child !== child || entry.info.status !== 'starting') return;
      if (ports.length > 0) {
        markRunning(entry, key, ports.includes(configuredPort) ? configuredPort : ports[0]);
        return;
      }
      if (Date.now() - startedAt >= READY_TIMEOUT_MS) {
        push(entry, 'stderr', `[strado] nothing listening after ${READY_TIMEOUT_MS / 1000}s — assuming the process is up`, key);
        markRunning(entry, key);
        return;
      }
      entry.readyTimer = setTimeout(tick, READY_POLL_MS);
    };
    entry.readyTimer = setTimeout(tick, READY_POLL_MS);
  }

  async function stop(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry || !entry.child || !entry.child.pid) return;
    if (entry.info.status === 'stopping') {
      // A second Stop while the first is in flight just waits for the same exit.
      await new Promise<void>((resolve) => entry.child!.once('exit', () => resolve()));
      return;
    }
    clearReadyTimer(entry);
    entry.info.status = 'stopping';
    emitProcess(entry, key);
    try {
      process.kill(-entry.child.pid, 'SIGTERM');
    } catch {
      // process group may already be gone
    }
    await new Promise<void>((resolve) => {
      const child = entry.child!;
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // ignore
        }
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // Dev servers don't always bind the port we configured (webpack-dev-server
  // with SSL binds :443 regardless). When a start crashes on EADDRINUSE, read
  // the REAL port from the error output, evict whatever holds it (our own
  // managed worktrees stop cleanly, matched via process group), retry once.
  async function retryAfterAddrInUse(entry: Entry, key: string, port: number): Promise<void> {
    push(entry, 'stderr', `[strado] port ${port} in use — evicting the listener and retrying`, key);
    for (const pid of await pidsOnPort(port)) {
      if (pid === process.pid) continue;
      const pgid = await pgidOf(pid);
      for (const [otherKey, other] of entries) {
        if (otherKey === key || other.info.pid === null) continue;
        if (isLive(other.info.status) && other.info.pid === pgid) await stop(otherKey);
      }
    }
    await evictPortListeners(port);
    if (entry.lastOpts) await start(entry.lastOpts, true);
  }

  async function start(opts: StartOptions, isRetry = false): Promise<void> {
      const entry = ensure(opts.key);
      if (isLive(entry.info.status)) {
        throw new AppError('PROCESS_ALREADY_RUNNING', `process already running for ${opts.key}`);
      }
      entry.lastOpts = opts;
      // an automatic retry keeps the buffer: the crash output and the
      // eviction note are the explanation for why the restart happened
      if (!isRetry) {
        entry.addrRetried = false;
        entry.buffer = [];
      }
      entry.info = {
        status: 'starting',
        pid: null,
        startedAt: new Date().toISOString(),
        port: opts.port,
        detectedUrl: null,
        exitCode: null,
      };
      emitProcess(entry, opts.key);

      debugLog?.log(logTag(opts.key), `start${isRetry ? ' (retry)' : ''}: ${opts.command} ${opts.args.join(' ')} — port ${opts.port}`);
      const child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, PORT: String(opts.port) },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.child = child;
      entry.info.pid = child.pid ?? null;
      // Still 'starting': a pid is not a server. The readiness watch (or a URL
      // in the output) promotes it to running once something is listening.
      emitProcess(entry, opts.key);
      watchReadiness(entry, opts.key, child, opts.port);

      child.stdout?.on('data', (b) => {
        for (const line of b.toString().split(/\r?\n/)) {
          if (line) push(entry, 'stdout', line, opts.key);
        }
      });
      child.stderr?.on('data', (b) => {
        for (const line of b.toString().split(/\r?\n/)) {
          if (line) push(entry, 'stderr', line, opts.key);
        }
      });
      child.on('exit', (code, signal) => {
        const wasIntentional = entry.info.status === 'stopping' || entry.info.status === 'stopped';
        clearReadyTimer(entry);
        entry.info.exitCode = code;
        entry.info.pid = null;
        entry.child = null;
        entry.info.status = wasIntentional || code === 0 ? 'stopped' : 'crashed';
        debugLog?.log(logTag(opts.key), `exit: status=${entry.info.status} code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        emitProcess(entry, opts.key, { signal });
        if (wasIntentional || code === 0 || entry.addrRetried) return;
        const tail = entry.buffer.slice(-80).join('\n');
        const addr = tail.match(/EADDRINUSE[^\n]*?:(\d+)/);
        if (!addr) return;
        entry.addrRetried = true;
        retryAfterAddrInUse(entry, opts.key, Number(addr[1])).catch((err) => {
          push(entry, 'stderr', `[strado] retry failed: ${String((err as Error).message ?? err)}`, opts.key);
        });
      });
  }

  return {
    start,
    stop,
    status(key) {
      return ensure(key).info;
    },
    snapshot(key, tail = 500) {
      const entry = ensure(key);
      return entry.buffer.slice(-tail);
    },
    ownedPids() {
      const pids = new Set<number>();
      for (const entry of entries.values()) {
        if (entry.info.pid !== null) pids.add(entry.info.pid);
      }
      return pids;
    },
    isRunning(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      return isLive(entry.info.status);
    },
    runningOnPort(port) {
      const keys: string[] = [];
      for (const [key, entry] of entries) {
        if (isLive(entry.info.status) && entry.info.port === port) keys.push(key);
      }
      return keys;
    },
  };
}
