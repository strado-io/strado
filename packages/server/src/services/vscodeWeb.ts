import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { AppError } from '../errors.js';
import {
  findFreePort as realFindFreePort,
  killTree as realKillTree,
  MARKER,
  daemonFilePath,
  readDaemonFile,
  writeDaemonFile,
  recordDaemon as realRecordDaemon,
  forgetDaemon as realForgetDaemon,
  isAlive as realIsAlive,
  looksLikeServeWeb as realLooksLikeServeWeb,
  portsFilePath,
  readPortsFile,
  writePortsFile,
} from './serveWebProcess.js';
import { pruneDeadIdeLocks as realPrune } from './ideLockfiles.js';
import { ensureTsServerMemory as realEnsureSettings } from './vscodeSettings.js';
import { pinnedCommit as realPinnedCommit } from './serveWebCache.js';

const HOST = '127.0.0.1';

function serveWebArgs(port: number, commit: string | null): string[] {
  const args = ['serve-web', '--host', HOST, '--port', String(port),
    '--without-connection-token', '--accept-server-license-terms'];
  // Pin to the cached build: without it serve-web asks the update service for
  // the newest commit and downloads it (~650MB) before serving anything.
  if (commit) args.push('--commit-id', commit);
  return args;
}
function codeServerArgs(port: number): string[] {
  return ['--auth', 'none', '--bind-addr', `${HOST}:${port}`];
}

const CANDIDATE_FILES = ['code-insiders', 'code', 'code-server'] as const;

function realPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

// serve-web answers on its port before the workbench actually exists: while it
// downloads a new VS Code build it serves a bare "…Server is downloading,
// please wait…" placeholder page. Ready = the root responds AND isn't that
// placeholder, so the renderer keeps its loading overlay up instead of
// framing raw placeholder text.
async function realWorkbenchReady(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2_000);
    let body: string;
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) return false;
      body = await res.text();
    } finally {
      clearTimeout(t);
    }
    return !/is downloading, please wait/i.test(body);
  } catch {
    return false;
  }
}

// Probe which CLI exists by attempting a serve-web spawn on the given port and
// seeing if it stays up. Returns the file that worked, or null.
export type VsCodeWebManager = {
  /** ready=false → serve-web is still serving its "downloading VS Code" placeholder */
  ensure(folder: string): Promise<{ url: string; ready: boolean }>;
  /** boot the shared workbench now (app start) instead of on first tab open; never throws */
  prewarm(): Promise<void>;
  drop(folder: string): Promise<void>;
  reapOrphans(): Promise<void>;
  closeAll(): Promise<void>;
};

// A daemon store persists spawned {pid,port} so orphans survive a crash and get
// reaped on next launch. Default implementation is the pidfile registry; tests
// inject an in-memory one.
export type DaemonStore = {
  record(entry: { pid: number; port: number }): void;
  forget(pid: number): void;
  /** pids that are still alive AND still look like a serve-web process */
  listReapable(): number[];
  clear(): void;
};

// Persists the app's serve-web port so the workbench origin — and with it the
// browser-stored user settings/theme/layout — survives app restarts.
export type PortStore = {
  get(): number | undefined;
  set(port: number): void;
};

type Deps = {
  spawn?: typeof realSpawn;
  findFreePort?: () => Promise<number>;
  portOpen?: (port: number) => Promise<boolean>;
  workbenchReady?: (url: string) => Promise<boolean>;
  killTree?: (pid: number) => void;
  daemonStore?: DaemonStore;
  portStore?: PortStore;
  /** how long ensure() waits for a busy preferred port to free up (a dying
   *  orphan from the previous run may still hold it for a moment) */
  preferredWaitMs?: number;
  /** cap on the first-boot wait for the real workbench (placeholder page) */
  readyWaitMs?: number;
  pruneDeadIdeLocks?: (pids: number[]) => void;
  ensureTsServerMemory?: (cli: string) => void;
  /** cached serve-web build to pin via --commit-id; null → let serve-web pick */
  pinnedCommit?: (cli: string) => string | null;
  /** pause between the pinned workbench turning ready and the cache warm-up */
  warmDelayMs?: number;
  /** cap on how long the warm-up daemon may spend downloading a new build */
  warmWaitMs?: number;
  /** interval between warm-up readiness probes */
  warmPollMs?: number;
  // Test hook: resolve directly to the winning CLI, skipping real spawn probing.
  cliExists?: (port: number) => Promise<string | null>;
};

function filePortStore(file: string): PortStore {
  const KEY = 'app'; // one shared workbench for the whole app
  return {
    get: () => readPortsFile(file)[KEY],
    set: (port) => {
      const map = readPortsFile(file);
      if (map[KEY] === port) return;
      map[KEY] = port;
      writePortsFile(file, map);
    },
  };
}

function pidfileStore(file: string): DaemonStore {
  return {
    record: (entry) => realRecordDaemon(file, entry),
    forget: (pid) => realForgetDaemon(file, pid),
    listReapable: () =>
      readDaemonFile(file)
        .map((e) => e.pid)
        .filter((pid) => realIsAlive(pid) && realLooksLikeServeWeb(pid)),
    clear: () => writeDaemonFile(file, []),
  };
}

export function createVsCodeWebManager(deps: Deps = {}): VsCodeWebManager {
  const spawn = deps.spawn ?? realSpawn;
  const findFreePort = deps.findFreePort ?? realFindFreePort;
  const portOpen = deps.portOpen ?? realPortOpen;
  const workbenchReady = deps.workbenchReady ?? realWorkbenchReady;
  const killTree = deps.killTree ?? realKillTree;
  const store = deps.daemonStore ?? pidfileStore(daemonFilePath());
  const portStore = deps.portStore ?? filePortStore(portsFilePath());
  const preferredWaitMs = deps.preferredWaitMs ?? 3_000;
  const readyWaitMs = deps.readyWaitMs ?? 20_000;
  const prune = deps.pruneDeadIdeLocks ?? realPrune;
  const ensureSettings = deps.ensureTsServerMemory ?? realEnsureSettings;
  const pinned = deps.pinnedCommit ?? realPinnedCommit;
  const warmDelayMs = deps.warmDelayMs ?? 30_000;
  // Generous: on a slow link a 650MB build can take a long time, and giving up
  // every session would leave the user pinned on today's build forever.
  // closeAll() reaps the warm-up on quit, so the cap is only a safety net.
  const warmWaitMs = deps.warmWaitMs ?? 60 * 60_000;
  const warmPollMs = deps.warmPollMs ?? 5_000;

  // ONE shared serve-web instance for the whole app. The workbench is
  // folder-agnostic (the renderer opens folders via ?folder=<path>), and a
  // single origin means VS Code's browser-stored user settings are shared by
  // every worktree tab — and stable across restarts via the persisted port.
  let instance: { pid: number; port: number; url: string; child: ChildProcess; ready: boolean } | null = null;
  let inflight: Promise<{ url: string; ready: boolean }> | null = null;
  let settingsSeeded = false;
  let warmed = false;
  let warm: { pid: number; child: ChildProcess } | null = null;

  function pinFor(file: string): string | null {
    if (file === 'code-server') return null;
    try { return pinned(file); } catch { return null; /* unreadable cache → unpinned boot */ }
  }

  function argsFor(file: string, port: number, commit: string | null): string[] {
    return file === 'code-server' ? codeServerArgs(port) : serveWebArgs(port, commit);
  }

  // Cache warm-up. A pinned boot never asks the update service, so on its own
  // the pin would freeze the user on today's build forever. Once the pinned
  // workbench is up, run ONE throwaway unpinned serve-web on a scratch port:
  // it fetches the newest build into the CLI's cache (or is instantly ready if
  // the pin already is the newest), then we kill it. The next app launch pins
  // to that build — the download happened while the user was working, never
  // while they were waiting. Best-effort; failures never touch the workbench.
  // Note the pin is the LRU *head* (most recently used), not "newest": the
  // warm-up run is what makes the newest build the MRU entry for next launch.
  // The running pin stays at the head or one behind it, so the CLI's own LRU
  // pruning never evicts the build we are serving.
  async function warmCache(file: string): Promise<void> {
    if (warmed) return;
    warmed = true;
    try {
      await new Promise((r) => setTimeout(r, warmDelayMs));
      if (!instance) return; // app is shutting down
      const port = await findFreePort();
      const child = spawn(file, argsFor(file, port, null), {
        stdio: 'ignore', detached: true, env: { ...process.env, [MARKER]: '1' },
      });
      // An unhandled 'error' on a ChildProcess is thrown from nextTick and
      // would take the whole server down — the main path guards this too.
      let dead = false;
      child.once('error', () => { dead = true; });
      child.once('exit', () => { dead = true; });
      const pid = child.pid;
      if (!pid) { try { child.kill(); } catch { /* noop */ } return; }
      store.record({ pid, port });
      warm = { pid, child };
      const url = `http://${HOST}:${port}/`;
      const deadline = Date.now() + warmWaitMs;
      while (Date.now() < deadline && !dead && warm?.pid === pid) {
        if (await workbenchReady(url)) break;
        await new Promise((r) => setTimeout(r, warmPollMs));
      }
      reapWarm(pid);
    } catch { /* best-effort */ }
  }

  function reapWarm(pid: number): void {
    if (warm?.pid !== pid) return; // already reaped (closeAll)
    warm = null;
    killTree(pid);
    store.forget(pid);
  }

  async function spawnCandidate(port: number): Promise<{ file: string; child: ChildProcess; commit: string | null } | null> {
    // Test override: caller declares which CLI is present.
    if (deps.cliExists) {
      const file = await deps.cliExists(port);
      if (!file) return null;
      const commit = pinFor(file);
      const child = spawn(file, argsFor(file, port, commit), {
        stdio: 'ignore', detached: true, env: { ...process.env, [MARKER]: '1' },
      });
      if (child.pid) store.record({ pid: child.pid, port });
      return { file, child, commit };
    }
    for (const file of CANDIDATE_FILES) {
      const commit = pinFor(file);
      const child = spawn(file, argsFor(file, port, commit), {
        stdio: 'ignore', detached: true, env: { ...process.env, [MARKER]: '1' },
      });
      // Record the instant we have a pid — before the ~400ms probe — so a crash
      // in that window still leaves a pidfile entry for the next reapOrphans.
      if (child.pid) store.record({ pid: child.pid, port });
      const ok = await new Promise<boolean>((resolve) => {
        child.once('error', () => resolve(false));       // ENOENT: binary missing
        setTimeout(() => resolve(child.exitCode === null), 400); // still alive → started
      });
      if (ok) return { file, child, commit };
      if (child.pid) store.forget(child.pid);            // rejected candidate — untrack
      try { child.kill(); } catch { /* noop */ }
    }
    return null;
  }

  async function ensure(_folder: string): Promise<{ url: string; ready: boolean }> {
    if (instance && instance.child.exitCode === null) {
      // A running instance can still be serving the update placeholder
      // (serve-web downloads new VS Code builds at boot) — re-probe until it
      // turns ready so the client can keep its own loading overlay up.
      if (!instance.ready) instance.ready = await workbenchReady(instance.url);
      return { url: instance.url, ready: instance.ready };
    }
    if (inflight) return inflight;

    const p = (async () => {
      // Prefer the persisted port: serve-web user settings live in browser
      // storage keyed by origin (host:port), so a stable port is what keeps
      // the user's editor state across app restarts. Wait briefly if it's
      // still held (previous run's instance may still be dying), and only
      // allocate fresh when it's genuinely taken by someone else.
      const preferred = portStore.get();
      let port: number | undefined;
      if (preferred !== undefined) {
        const deadline = Date.now() + preferredWaitMs;
        for (;;) {
          if (!(await portOpen(preferred))) { port = preferred; break; }
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (port === undefined) port = await findFreePort();
      let spawned = await spawnCandidate(port);
      if (spawned && !spawned.child.pid) {
        try { spawned.child.kill(); } catch { /* noop */ }
        spawned = null;
      }
      if (!spawned) {
        throw new AppError('NOT_FOUND',
          'no VS Code CLI found — install `code`/`code-insiders` (Shell Command: Install) or code-server');
      }
      const { file, child, commit } = spawned;
      const pid = child.pid as number;
      const url = `http://${HOST}:${port}/`;
      instance = { pid, port, url, child, ready: false };
      try { portStore.set(port); } catch { /* never block editor open */ }
      // (already recorded to the store inside spawnCandidate the moment the
      // child got a pid — no double-record here)
      child.once('exit', () => {
        store.forget(pid);
        if (instance && instance.pid === pid) instance = null;
      });

      if (!settingsSeeded) { settingsSeeded = true; try { ensureSettings(file); } catch { /* noop */ } }

      // Best-effort wait for the port so the first iframe load succeeds; the
      // client retries regardless, so a slow warmup still returns the URL.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await portOpen(port)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      // Then hold the URL until the real workbench responds — serve-web can sit
      // on a "downloading VS Code…" placeholder for minutes after an update.
      // Best-effort cap: past it, return with ready:false so the client keeps
      // its own loading overlay and re-polls instead of framing the placeholder.
      let ready = false;
      const readyDeadline = Date.now() + readyWaitMs;
      while (Date.now() < readyDeadline) {
        if (await workbenchReady(url)) { ready = true; break; }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      if (instance && instance.pid === pid) instance.ready = ready;
      if (commit) void warmCache(file);
      return { url, ready };
    })().finally(() => { inflight = null; });

    inflight = p;
    return p;
  }

  // Eager boot at app start so the first VS Code tab lands on a running
  // workbench. The folder is irrelevant (one shared, folder-agnostic instance);
  // a missing CLI or any spawn failure is simply reported later by ensure().
  //
  // Gated on a persisted port, i.e. VS Code has been opened in Strado before.
  // Otherwise app launch would pull a ~650MB build and park a daemon for a
  // feature this user may never touch; first open then behaves as before.
  async function prewarm(): Promise<void> {
    try {
      if (portStore.get() === undefined) return;
      await ensure('/');
    } catch { /* surfaced on the real tab open */ }
  }

  async function drop(_folder: string): Promise<void> {
    // Intentional no-op: ONE shared workbench serves every folder, so closing
    // one VS Code tab must not kill the editor other tabs are using. The
    // daemon lives until closeAll (app shutdown) — still strictly fewer
    // processes than the old one-daemon-per-folder model.
  }

  // Reap daemons left behind by a prior process that skipped closeAll (crash,
  // SIGKILL). Pidfile-based so it works on macOS too; listReapable already
  // filters to still-alive serve-web pids, so we never touch a reused pid or a
  // serve-web the user runs themselves (we only recorded our own).
  async function reapOrphans(): Promise<void> {
    let pids: number[] = [];
    try { pids = store.listReapable(); } catch { pids = []; }
    for (const pid of pids) killTree(pid);
    try { store.clear(); } catch { /* best-effort */ }
    if (pids.length) prune(pids);
  }

  async function closeAll(): Promise<void> {
    const entry = instance;
    instance = null;
    if (warm) reapWarm(warm.pid); // detached: would outlive process.exit otherwise
    if (!entry) return;
    killTree(entry.pid);
    store.forget(entry.pid);
    prune([entry.pid]);
  }

  return { ensure, prewarm, drop, reapOrphans, closeAll };
}

// HAZARD: this captures daemonFilePath() (via createVsCodeWebManager ->
// pidfileStore) at MODULE-EVALUATION time, not at first use. If this module
// is ever statically imported by index.ts before the profile is applied to
// process.env, it will silently pin the STABLE (~/.strado) path even under
// the dev profile — that exact bug shipped once. index.ts guards against
// this by resolving/applying the profile first and only then reaching this
// module via a dynamic `await import('./services/vscodeWeb.js')`. Do not
// reintroduce a static import of this file above that point, and do not
// "fix" this by making daemonFilePath() lazy here — the point is that no
// module-level factory of this shape may read profile-derived env at all.
const defaultManager = createVsCodeWebManager();
export const ensureVsCodeWeb = (folder: string) => defaultManager.ensure(folder);
export const prewarmVsCodeWeb = () => defaultManager.prewarm();
export const dropVsCodeWeb = (folder: string) => defaultManager.drop(folder);
export const reapOrphans = () => defaultManager.reapOrphans();
export const closeAll = () => defaultManager.closeAll();
