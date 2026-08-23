import { spawn, ChildProcess } from 'node:child_process';
import type { EventBus } from '../events/bus.js';
import type { DebugLog } from './debugLog.js';
import { AppError } from '../errors.js';
import { evictPortListeners, pgidOf, pidsOnPort } from './externalProcess.js';

// Short, greppable tag for the combined debug log (the key is a full path).
function logTag(key: string): string {
  return `${key.split('/').pop() || key} dev`;
}

export type ProcStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'crashed';

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

type Entry = {
  info: ProcInfo;
  child: ChildProcess | null;
  buffer: string[];
  lastOpts?: StartOptions;
  // one automatic EADDRINUSE eviction+retry per user-initiated start
  addrRetried?: boolean;
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
        bus.emit('worktrees', {
          type: 'worktree.updated',
          data: { path: key, process: { ...entry.info } },
        });
      }
    }
  }

  async function stop(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry || !entry.child || !entry.child.pid) return;
    entry.info.status = 'stopped';
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
        const live = other.info.status === 'running' || other.info.status === 'starting';
        if (live && other.info.pid === pgid) await stop(otherKey);
      }
    }
    await evictPortListeners(port);
    if (entry.lastOpts) await start(entry.lastOpts, true);
  }

  async function start(opts: StartOptions, isRetry = false): Promise<void> {
      const entry = ensure(opts.key);
      if (entry.info.status === 'running' || entry.info.status === 'starting') {
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
      bus.emit('worktrees', {
        type: 'worktree.updated',
        data: { path: opts.key, process: { ...entry.info } },
      });

      debugLog?.log(logTag(opts.key), `start${isRetry ? ' (retry)' : ''}: ${opts.command} ${opts.args.join(' ')} — port ${opts.port}`);
      const child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, PORT: String(opts.port) },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.child = child;
      entry.info.pid = child.pid ?? null;
      entry.info.status = 'running';
      bus.emit('worktrees', {
        type: 'worktree.updated',
        data: { path: opts.key, process: { ...entry.info } },
      });

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
        const wasIntentional = entry.info.status === 'stopped';
        entry.info.exitCode = code;
        entry.info.pid = null;
        entry.child = null;
        if (!wasIntentional) {
          entry.info.status = code === 0 ? 'stopped' : 'crashed';
        }
        debugLog?.log(logTag(opts.key), `exit: status=${entry.info.status} code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        bus.emit('worktrees', {
          type: 'worktree.updated',
          data: { path: opts.key, signal, process: { ...entry.info } },
        });
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
      return entry.info.status === 'running' || entry.info.status === 'starting';
    },
    runningOnPort(port) {
      const keys: string[] = [];
      for (const [key, entry] of entries) {
        const live = entry.info.status === 'running' || entry.info.status === 'starting';
        if (live && entry.info.port === port) keys.push(key);
      }
      return keys;
    },
  };
}
