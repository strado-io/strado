import { spawn } from 'node:child_process';
import type { EventBus } from '../events/bus.js';
import type { DebugLog } from './debugLog.js';
import { AppError } from '../errors.js';
import { evictPortListeners, listeningPortsOfGroup, listeningPortsOfTree, pgidOf, pidsOnPort, processTree, shellForegroundBusy } from './externalProcess.js';
import { runKey, type TerminalManager } from './terminalManager.js';

/** A run's key in the manager: the worktree path for its default run (every
 * caller that means "the dev server" keeps using the path), else one per command. */
export function procKey(worktree: string, run: { id: string; isDefault: boolean }): string {
  return run.isDefault ? worktree : `${worktree}\0run:${run.id}`;
}

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
  // Set when the repo serves worktrees through the dev proxy: the stable
  // URL (https://<worktree>.<host>) to open instead of the private port.
  proxyUrl?: string | null;
  // 'run' when the command runs in the worktree's Run terminal (runKey), which
  // the hub shows as a tab, also after it exits; null when there is none.
  tab?: 'run' | null;
  // Which of the repo's run commands this is (repoConfig RunCommand).
  runId?: string | null;
  name?: string | null;
};

export type StartOptions = {
  /** The run's key: the worktree path for the default run, else procKey(path, runId). */
  key: string;
  /** The worktree it runs in (events name it); defaults to `key`. */
  worktree?: string;
  runId?: string | null;
  name?: string | null;
  /** The default run (default true): PORT, the port, readiness and port-clash
   * recovery. Any other run is "running" while alive and owns no port. */
  primary?: boolean;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  proxyUrl?: string | null;
  // The dev proxy owns this port. A dev server that still binds it crashes on
  // EADDRINUSE, and evicting the "squatter" would mean killing the proxy.
  proxyPort?: number | null;
  // Shown at the top of the log, e.g. a proxy hostname that doesn't resolve.
  notices?: string[];
  /** In a terminal: the shell the tab becomes when the run ends (a plain
   * login shell, none of the run's env). Needs `args` to end in a -c script. */
  shell?: { file: string; args: string[] };
};

const RING_LIMIT = 5_000;
const URL_PATTERN = /(https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./?=&%+#-]*)?)/;
// How often a starting process is probed for a listening port, and how long
// before we give up waiting and call it running anyway — a worker with no
// HTTP port would otherwise sit on "Starting" forever.
const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 60_000;
// A shell whose job was ended by Ctrl-C exits 128+SIGINT: the user stopped it.
const EXIT_SIGINT = 130;
// Colour, cursor and title sequences: the log stream (and URL / EADDRINUSE
// detection) reads plain text.
// What the run wrapper prints when the command ends (an OSC no terminal shows).
// eslint-disable-next-line no-control-regex
const EXIT_MARKER = /\x1b\]777;strado-run-exit;(\d+)\x07/;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The run's shell args with its -c script wrapped: run it (Ctrl-C ends the
 * command, not the wrapper), print how it ended, tell us (EXIT_MARKER), then
 * become `shell` without the run's env (names only; values never appear).
 * null when `args` does not end in a -c script. */
export function afterRunShell(args: string[], shell: { file: string; args: string[] }, envKeys: string[]): string[] | null {
  const flag = args[args.length - 2];
  if (!flag || !/^-[a-z]*c[a-z]*$/.test(flag)) return null;
  const unset = envKeys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map((k) => `-u ${k}`).join(' ');
  const script = [
    'trap : INT',
    // A subshell: an `exit` in the command ends the run, not the wrapper.
    `(\n${args[args.length - 1]!}\n)`,
    '__strado_rc=$?',
    'trap - INT',
    "printf '\\r\\n\\033[2m[process exited with code %s]\\033[0m\\r\\n' \"$__strado_rc\"",
    "printf '\\033]777;strado-run-exit;%s\\007' \"$__strado_rc\"",
    `exec env ${unset} ${[shell.file, ...shell.args].map(shq).join(' ')}`,
  ].join('\n');
  return [...args.slice(0, -1), script];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** One start's process, however it was spawned: a piped child (no terminal
 * manager) or the worktree's Run terminal. */
type Run = {
  pid: number | null;
  /** A tty: jobs get their own process groups, so readiness walks the process tree. */
  pty: boolean;
  /** Ask it to end (SIGTERM to the group / hang up the terminal). */
  stop(): void;
  /** It would not end: SIGKILL. */
  kill(): void;
  exited: Promise<void>;
};

type Entry = {
  /** Its terminal (runKey), once it has run in one. */
  ptyKey?: string;
  /** The worktree this run belongs to (events and runs() go by it). */
  worktree: string;
  primary: boolean;
  info: ProcInfo;
  run: Run | null;
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
  /** Every run of the worktree (deleting it, removing its workspace). */
  stopAll(worktree: string): Promise<void>;
  /** Close a finished run's tab: kill the shell it became. CONFLICT 'running' while live. */
  closeTab(key: string): void;
  /** That shell is running something: a new Run would kill it. */
  runTabBusy(key: string): Promise<boolean>;
  /** The worktree's runs started this session, the default first, then by start. */
  runs(worktree: string): ProcInfo[];
  status(key: string): ProcInfo;
  snapshot(key: string, tail?: number): string[];
  ownedPids(): Set<number>;
  isRunning(key: string): boolean;
  // keys of live processes bound to a port (listener pids can be grandchildren
  // of the managed shell, so pid matching alone can't identify ours)
  runningOnPort(port: number): string[];
};

/** How a sandboxed worktree's dev server is run and stopped: the command is
 * wrapped to exec into the container, and Stop first reaches the process in
 * there (killing the host-side exec client alone would leave it running). */
export type ProcessSandbox = {
  wrap: (cwd: string, spec: { file: string; args: string[] }, extraEnvKeys?: string[]) => { file: string; args: string[] };
  stopInside: (cwd: string) => Promise<void>;
};

/** `terminal`: run each start in the worktree's Run terminal (a real tty the
 * hub shows as a tab). Without it, a piped child as before (tests, fallback).
 * The terminal manager applies the sandbox wrap itself, as for every session. */
export function createProcessManager(
  bus: EventBus,
  debugLog?: DebugLog,
  sandbox?: ProcessSandbox,
  terminal?: () => TerminalManager | null,
): ProcessManager {
  const entries = new Map<string, Entry>();

  function ensure(key: string): Entry {
    let e = entries.get(key);
    if (!e) {
      e = {
        worktree: key,
        primary: true,
        info: {
          status: 'idle',
          pid: null,
          startedAt: null,
          port: null,
          detectedUrl: null,
          exitCode: null,
        },
        run: null,
        buffer: [],
      };
      entries.set(key, e);
    }
    return e;
  }

  // `detect` is off for Strado's own notes: a line that mentions the proxy URL
  // and the port must not pass for the dev server announcing itself.
  function push(entry: Entry, stream: 'stdout' | 'stderr', line: string, key: string, detect = true) {
    entry.buffer.push(line);
    if (entry.buffer.length > RING_LIMIT) entry.buffer.shift();
    debugLog?.log(logTag(key), line);
    bus.emit(`logs:${key}`, { type: 'log', data: { stream, line, ts: new Date().toISOString() } });
    if (detect && entry.info.detectedUrl === null) {
      const match = line.match(URL_PATTERN);
      if (match && entry.info.port && line.includes(String(entry.info.port))) {
        entry.info.detectedUrl = match[1] ?? null;
        // Printing its URL is as good as a bound socket: it is serving.
        if (entry.info.status === 'starting') markRunning(entry, key);
        else emitProcess(entry, key);
      }
    }
  }

  // The default run is the worktree's `process` (as ever); any other is a
  // `run`, so it can never overwrite the default's state in a client.
  function emitProcess(entry: Entry, _key: string, extra: Record<string, unknown> = {}) {
    bus.emit('worktrees', {
      type: 'worktree.updated',
      data: { path: entry.worktree, ...extra, [entry.primary ? 'process' : 'run']: { ...entry.info } },
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

  // Poll the run for a LISTEN socket. The first port to appear flips the state
  // to running; when it binds several, the configured one wins, else the
  // lowest (app ports sit below HMR/inspector). A piped child is its own group
  // leader; a terminal's jobs are not, so there the process tree is walked.
  function watchReadiness(entry: Entry, key: string, run: Run, configuredPort: number) {
    const startedAt = Date.now();
    const tick = async () => {
      entry.readyTimer = null;
      if (entry.run !== run || entry.info.status !== 'starting' || !run.pid) return;
      const ports = run.pty ? await listeningPortsOfTree(run.pid) : await listeningPortsOfGroup(run.pid);
      if (entry.run !== run || entry.info.status !== 'starting') return;
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
    const run = entry?.run;
    if (!entry || !run || !run.pid) return;
    if (entry.info.status === 'stopping') {
      // A second Stop while the first is in flight just waits for the same exit.
      await run.exited;
      return;
    }
    clearReadyTimer(entry);
    entry.info.status = 'stopping';
    emitProcess(entry, key);
    // The process in the container first: it does not die with the exec
    // client we are about to signal.
    if (sandbox && entry.lastOpts) {
      await sandbox.stopInside(entry.lastOpts.cwd).catch((err: Error) =>
        debugLog?.log(logTag(key), `stop inside sandbox failed: ${err.message}`));
    }
    run.stop();
    const timer = setTimeout(() => run.kill(), 5_000);
    await run.exited;
    clearTimeout(timer);
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

  // The run ended: record how, and recover from a port clash once.
  function onExit(entry: Entry, opts: StartOptions, run: Run, code: number | null, signal: string | null) {
    if (entry.run !== run) return;
    const wasIntentional = entry.info.status === 'stopping' || entry.info.status === 'stopped'
      || (run.pty && code === EXIT_SIGINT);
    clearReadyTimer(entry);
    entry.info.exitCode = code;
    entry.info.pid = null;
    entry.run = null;
    entry.info.status = wasIntentional || code === 0 ? 'stopped' : 'crashed';
    debugLog?.log(logTag(opts.key), `exit: status=${entry.info.status} code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    emitProcess(entry, opts.key, { signal });
    if (wasIntentional || code === 0 || entry.addrRetried || !entry.primary) return;
    const tail = entry.buffer.slice(-80).join('\n');
    const addr = tail.match(/EADDRINUSE[^\n]*?:(\d+)/);
    if (!addr) return;
    if (opts.proxyPort && Number(addr[1]) === opts.proxyPort) {
      push(
        entry,
        'stderr',
        `[strado] port ${opts.proxyPort} belongs to the dev proxy — make the dev server listen on $PORT (${opts.port}) instead of a hard-coded port`,
        opts.key,
      );
      return;
    }
    entry.addrRetried = true;
    retryAfterAddrInUse(entry, opts.key, Number(addr[1])).catch((err) => {
      push(entry, 'stderr', `[strado] retry failed: ${String((err as Error).message ?? err)}`, opts.key);
    });
  }

  function spawnPiped(entry: Entry, opts: StartOptions, env: Record<string, string>): Run {
    // Inside the worktree's container when it has one: that is where its
    // dependencies are and where the published port is bound. The wrapper
    // forwards exactly the keys set here, by name.
    const spec = sandbox
      ? sandbox.wrap(opts.cwd, { file: opts.command, args: opts.args }, Object.keys(env))
      : { file: opts.command, args: opts.args };
    const child = spawn(spec.file, spec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const signal = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig); } catch { /* group already gone */ }
    };
    const run: Run = {
      pid: child.pid ?? null,
      pty: false,
      stop: () => signal('SIGTERM'),
      kill: () => signal('SIGKILL'),
      exited: new Promise((resolve) => child.once('exit', () => resolve())),
    };
    // Before any output or exit can arrive: those check they belong to this run.
    entry.run = run;
    for (const [stream, out] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      out?.on('data', (b) => {
        for (const line of b.toString().split(/\r?\n/)) {
          if (line) push(entry, stream, line, opts.key);
        }
      });
    }
    child.on('exit', (code, sig) => onExit(entry, opts, run, code, sig));
    return run;
  }

  async function spawnInTerminal(entry: Entry, opts: StartOptions, env: Record<string, string>, term: TerminalManager): Promise<Run> {
    const key = runKey(entry.worktree, entry.primary ? null : opts.runId);
    entry.ptyKey = key;
    // A Run terminal still up while we are idle: the shell a finished run left
    // (the route has checked it is idle), or one left over from before a
    // server restart (it lives in ptyd). It is not this start; end it first.
    if (term.status(key).status === 'running') {
      const gone = new Promise<void>((resolve) => { const off = term.onExit(key, () => { off(); resolve(); }); });
      term.kill(key);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5_000))]);
    }
    const shellAfter = opts.shell ? afterRunShell(opts.args, opts.shell, Object.keys(env)) : null;
    const info = await term.ensure(key, opts.cwd, { file: opts.command, args: shellAfter ?? opts.args }, undefined, { env });
    let resolveExited!: () => void;
    let ended = false;
    // The run's own processes: everything under the terminal's shell, never
    // the shell itself (it becomes the tab's shell when the run ends).
    const signalRun = async (sig: NodeJS.Signals) => {
      if (!run.pid) return;
      for (const pid of (await processTree(run.pid)).slice(1)) {
        try { process.kill(pid, sig); } catch { /* gone */ }
      }
    };
    const run: Run = {
      pid: info.pid,
      pty: true,
      stop: () => (shellAfter ? void signalRun('SIGTERM') : term.kill(key)),
      kill: () => {
        if (!run.pid) return;
        if (shellAfter) { void signalRun('SIGKILL'); return; }
        try { process.kill(-run.pid, 'SIGKILL'); } catch { /* already gone */ }
      },
      exited: new Promise((resolve) => { resolveExited = resolve; }),
    };
    entry.run = run;
    // The terminal's bytes as log lines: colours stripped, a progress line
    // rewritten with \r counts once, as its final text.
    let carry = '';
    const lines = (text: string) => {
      const parts = (carry + text.replace(ANSI, '')).split('\n');
      carry = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split('\r').filter(Boolean).pop() ?? '';
        if (line.trim()) push(entry, 'stdout', line, opts.key);
      }
    };
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      unsub();
      lines('\n');
      onExit(entry, opts, run, code, null);
      resolveExited();
    };
    // The wrapper's marker says the command ended (and how); the terminal
    // itself lives on as the tab's shell. Bytes after it are the shell's.
    let tail = '';
    const unsub = term.subscribe(key, (data) => {
      if (ended) return;
      const seen = tail + data;
      const m = EXIT_MARKER.exec(seen);
      if (!m) {
        lines(data);
        tail = seen.slice(-64);
        return;
      }
      lines(seen.slice(tail.length, m.index > tail.length ? m.index : tail.length));
      end(Number(m[1]));
    });
    const offExit = term.onExit(key, (code) => {
      offExit();
      end(code);
    });
    return run;
  }

  /** Close the run's tab: kill the shell a finished run left there. A live run
   * is never killed this way (Stop does that); the tab just detaches. */
  function closeTab(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    if (isLive(entry.info.status)) throw new AppError('CONFLICT', 'the run is still going: stop it first', { reason: 'running' });
    const term = terminal?.();
    if (term && entry.ptyKey) term.kill(entry.ptyKey);
    if (entry.info.tab) {
      entry.info.tab = null;
      emitProcess(entry, key);
    }
  }

  /** The finished run's shell is running something (a job in the foreground). */
  async function runTabBusy(key: string): Promise<boolean> {
    const entry = entries.get(key);
    const term = terminal?.();
    if (!entry?.ptyKey || !term || isLive(entry.info.status)) return false;
    const { status, pid } = term.status(entry.ptyKey);
    if (status !== 'running' || !pid) return false;
    return shellForegroundBusy(pid);
  }

  async function start(opts: StartOptions, isRetry = false): Promise<void> {
    const entry = ensure(opts.key);
    if (isLive(entry.info.status)) {
      throw new AppError('PROCESS_ALREADY_RUNNING', `process already running for ${opts.key}`);
    }
    entry.lastOpts = opts;
    entry.worktree = opts.worktree ?? opts.key;
    entry.primary = opts.primary !== false;
    // an automatic retry keeps the buffer: the crash output and the
    // eviction note are the explanation for why the restart happened
    if (!isRetry) {
      entry.addrRetried = false;
      entry.buffer = [];
    }
    const term = terminal?.() ?? null;
    entry.info = {
      status: 'starting',
      pid: null,
      startedAt: new Date().toISOString(),
      port: entry.primary ? opts.port : null,
      detectedUrl: null,
      exitCode: null,
      proxyUrl: opts.proxyUrl ?? null,
      tab: term ? 'run' : null,
      runId: opts.runId ?? null,
      name: opts.name ?? null,
    };
    emitProcess(entry, opts.key);
    if (opts.proxyUrl) push(entry, 'stdout', `[strado] dev proxy: ${opts.proxyUrl} -> 127.0.0.1:${opts.port}`, opts.key, false);
    for (const notice of opts.notices ?? []) push(entry, 'stderr', `[strado] ${notice}`, opts.key, false);

    debugLog?.log(logTag(opts.key), `start${isRetry ? ' (retry)' : ''}${term ? ' (terminal)' : ''}: ${opts.command} ${opts.args.join(' ')} — port ${opts.port}`);
    // On the spawn itself, never typed: the worktree env can hold secrets.
    // Only the default run owns the worktree's port.
    const env = entry.primary ? { ...opts.env, PORT: String(opts.port) } : { ...opts.env };
    let run: Run;
    try {
      run = term ? await spawnInTerminal(entry, opts, env, term) : spawnPiped(entry, opts, env);
    } catch (err) {
      entry.info.status = 'crashed';
      emitProcess(entry, opts.key);
      push(entry, 'stderr', `[strado] could not start: ${(err as Error).message}`, opts.key, false);
      throw err;
    }
    entry.run = run;
    entry.info.pid = run.pid;
    // Still 'starting': a pid is not a server. The readiness watch (or a URL
    // in the output) promotes it to running once something is listening.
    emitProcess(entry, opts.key);
    // Not the default: no port to wait for. Up is running.
    if (!entry.primary) markRunning(entry, opts.key);
    else watchReadiness(entry, opts.key, run, opts.port);
  }

  return {
    start,
    stop,
    closeTab,
    runTabBusy,
    async stopAll(worktree) {
      await Promise.all([...entries].filter(([, e]) => e.worktree === worktree).map(([key]) => stop(key)));
    },
    runs(worktree) {
      return [...entries.values()]
        .filter((e) => e.worktree === worktree && e.info.startedAt !== null)
        .sort((a, b) => Number(b.primary) - Number(a.primary) || a.info.startedAt!.localeCompare(b.info.startedAt!))
        .map((e) => ({ ...e.info }));
    },
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
