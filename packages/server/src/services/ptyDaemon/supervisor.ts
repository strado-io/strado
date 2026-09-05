// Spawn-or-adopt the strado-ptyd daemon. The daemon outlives the server —
// that's the whole point — so it is spawned detached and never killed on
// server shutdown. Manifest file records pid+socket for adoption on the
// next server boot.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from '@strado/ptyd/protocol';

export interface PtyDaemonHandle {
  socketPath: string;
  daemonVersion: string;
}

interface Manifest {
  pid: number;
  socketPath: string;
  daemonVersion: string;
  startedAt: number;
}

const PROBE_TIMEOUT_MS = 1_000;
const SPAWN_WAIT_MS = 5_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// One install attempt per process: ensurePtyDaemon is called repeatedly by
// reconnect loops, and re-stat'ing/re-verifying the install on every call is
// wasted work once this process already knows it has a good installed copy.
// Keyed by stateDir+daemonScript so tests using distinct tmp stateDirs don't
// collide. Scoped to ensurePtyDaemon (not installPtydRuntime itself) so the
// exported installPtydRuntime keeps doing a full, uncached check every call
// — install.test.ts calls it directly to verify skip/re-install semantics.
// A source bundle that changes mid-process (rebuilt ptyd while the server
// keeps running) is NOT picked up until the next process start — that's
// fine, a version change mid-process requires a new server process anyway,
// and a running old daemon keeps its own open inodes regardless.
const installedOnce = new Map<string, PtydInstall>();

function manifestPath(stateDir: string): string {
  return path.join(stateDir, 'ptyd', 'manifest.json');
}

function readManifest(stateDir: string): Manifest | null {
  try {
    const raw = fs.readFileSync(manifestPath(stateDir), 'utf8');
    const m = JSON.parse(raw) as Manifest;
    if (typeof m.pid !== 'number' || typeof m.socketPath !== 'string') return null;
    return m;
  } catch {
    return null;
  }
}

/** Connect + hello + hello-ack within a deadline; resolves daemonVersion + daemonPid. */
export function probeDaemon(
  socketPath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ daemonVersion: string; daemonPid: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('probe timeout'));
    }, timeoutMs);
    const fail = (err: Error) => { clearTimeout(timer); socket.destroy(); reject(err); };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(encodeFrame({ type: 'hello', protocols: [PROTOCOL_VERSION] }));
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        decoder.push(chunk);
        for (const frame of decoder.drain()) {
          const msg = frame.message as { type: string; daemonVersion?: string; daemonPid?: number };
          if (msg.type === 'hello-ack') {
            clearTimeout(timer);
            socket.destroy();
            resolve({ daemonVersion: msg.daemonVersion ?? 'unknown', daemonPid: msg.daemonPid ?? -1 });
            return;
          }
          fail(new Error(`unexpected probe reply: ${msg.type}`));
          return;
        }
      } catch (err) {
        fail(err as Error);
      }
    });
  });
}

/** Reads `ptyd.version` sitting beside the daemon script, trimmed; null if unreadable. */
export function readExpectedDaemonVersion(daemonScript: string): string | null {
  try {
    const v = fs.readFileSync(path.join(path.dirname(daemonScript), 'ptyd.version'), 'utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Numeric x.y.z compare; any non-numeric input compares as NOT less (never upgrade on garbage). */
export function versionLess(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** What to spawn the daemon with: the installed script and the interpreter for it. */
export interface PtydInstall {
  script: string;
  execPath: string;
}

/**
 * Copy the daemon runtime to a STABLE path under stateDir and return what to
 * spawn it with. The daemon must never run from the app's install location:
 * on Linux AppImage that is a per-launch FUSE mount that vanishes on quit and
 * moves on update — a handoff successor self-spawning from process.argv[1]
 * would hit ENOENT forever. A stable copy makes argv[1] durable on every
 * platform (macOS loses nothing and CI exercises the path).
 *
 * argv[0] needs the same treatment: the daemon is spawned with the app's own
 * Node binary, which on AppImage ALSO lives in the per-launch mount. Two
 * failures follow from leaving it there — (a) a handoff successor self-spawns
 * from the daemon's own execPath and hits ENOENT after any remount, and (b)
 * the running daemon's executable pages are FUSE-backed, so they can fault
 * (SIGBUS) once the mount goes away on quit, killing the very sessions this
 * design exists to preserve. So `installNode` copies the interpreter next to
 * the script and the returned execPath points at the copy. Defaults to Linux
 * only: AppImage needs it, .deb doesn't care, and macOS's app path is already
 * stable so it skips the ~100MB copy.
 *
 * Not every interpreter survives being copied: Homebrew's `node` is a thin
 * launcher that dlopens `../lib/libnode.*.dylib` by relative rpath, so a lone
 * copy dies at load time and the daemon never comes up. The copy is therefore
 * run once (`--version`) before it is trusted; a copy that cannot run is
 * discarded, the app's own interpreter is used instead, and a sentinel keyed
 * to that interpreter's identity stops every later boot from re-trying.
 *
 * Skip when the installed ptyd.version matches sourceMarker(...) — version
 * PLUS the source bundle's size+mtime (and the node binary's, when installing
 * it), not version alone, since ptyd source changes usually ship without a
 * version bump. ptyd.version is written LAST (tmp+rename) as the completeness
 * marker, and unlinked FIRST on any (re)install: a crash mid-install (or
 * mid-boot re-check) always leaves an install the next boot re-does, never a
 * stale marker blessing half-replaced bytes. A RUNNING old daemon keeps its
 * open inodes — replacing files on disk never touches it.
 */
export function installPtydRuntime(opts: {
  stateDir: string;
  daemonScript: string;
  installNode?: boolean;
  /** The interpreter to copy when installing one; defaults to the app's own. */
  nodeSource?: string;
}): PtydInstall {
  // Fail with a readable error, not a raw ENOENT from copyFileSync — the
  // existing supervisor test pins /ptyd/ in the rejection message.
  if (!fs.existsSync(opts.daemonScript)) {
    throw new Error(`installPtydRuntime: ptyd bundle missing at ${opts.daemonScript}`);
  }
  const nodeSource = opts.nodeSource ?? process.execPath;
  const binDir = path.join(opts.stateDir, 'ptyd', 'bin');
  const installedScript = path.join(binDir, 'ptyd.cjs');
  const installedNode = path.join(binDir, 'node');
  const installedVersionFile = path.join(binDir, 'ptyd.version');
  // Written when a copy of nodeSource could not run; holds that interpreter's
  // identity so a different (say, updated) interpreter gets a fresh try.
  const unrelocatableFile = path.join(binDir, 'node.unrelocatable');
  const nodeIdentity = interpreterIdentity(nodeSource);
  let installNode = opts.installNode ?? process.platform === 'linux';
  if (installNode && readTrimmed(unrelocatableFile) === nodeIdentity) installNode = false;
  const sourceVersion = readExpectedDaemonVersion(opts.daemonScript);
  let marker = sourceMarker(opts.daemonScript, sourceVersion, installNode ? nodeSource : null);
  const result = (): PtydInstall => ({
    script: installedScript,
    // Only claim the installed interpreter once it is actually on disk —
    // otherwise a caller would spawn a path that doesn't exist.
    execPath: installNode && fs.existsSync(installedNode) ? installedNode : nodeSource,
  });

  const installedMarker = (() => {
    try {
      return fs.readFileSync(installedVersionFile, 'utf8').trim();
    } catch {
      return null;
    }
  })();
  const complete =
    fs.existsSync(installedScript) &&
    fs.existsSync(path.join(binDir, 'node_modules', 'node-pty', 'package.json')) &&
    (!installNode || fs.existsSync(installedNode));
  if (marker && installedMarker === marker && complete) return result();

  // Invalidate the completeness marker FIRST: any failure below must leave
  // an install that the next boot re-does, never a stale marker blessing
  // half-replaced (or foreign, markerless-source) bytes.
  try { fs.unlinkSync(installedVersionFile); } catch { /* ENOENT fine */ }

  fs.mkdirSync(path.join(binDir, 'node_modules'), { recursive: true });

  // Bundle: tmp+rename.
  const tmpScript = `${installedScript}.${process.pid}.tmp`;
  fs.copyFileSync(opts.daemonScript, tmpScript);
  fs.renameSync(tmpScript, installedScript);

  // Interpreter: tmp+rename, then make it executable (copyFileSync preserves
  // the source mode on POSIX, but don't rely on it — an unexecutable argv[0]
  // is an EACCES the daemon can never recover from).
  if (installNode) {
    const tmpNode = `${installedNode}.${process.pid}.tmp`;
    fs.copyFileSync(nodeSource, tmpNode);
    fs.chmodSync(tmpNode, 0o755);
    if (copyCanRun(tmpNode)) {
      fs.renameSync(tmpNode, installedNode);
    } else {
      // A lone copy of this interpreter cannot start (dynamic libs next to
      // the original, most likely). Run the daemon on the original instead,
      // and remember so the next boot doesn't copy ~100MB just to find out again.
      process.stderr.write(`[ptyd-supervisor] copy of ${nodeSource} cannot run on its own; using it in place\n`);
      fs.rmSync(tmpNode, { force: true });
      fs.rmSync(installedNode, { force: true });
      if (nodeIdentity) fs.writeFileSync(unrelocatableFile, nodeIdentity);
      installNode = false;
      marker = sourceMarker(opts.daemonScript, sourceVersion, null);
    }
  }

  // node-pty (and node-addon-api when present) resolve from the app's own
  // node_modules next to the SOURCE bundle (packaged) or the repo root (dev).
  for (const mod of ['node-pty', 'node-addon-api']) {
    const src = resolveModuleDir(opts.daemonScript, mod);
    if (!src) {
      if (mod === 'node-pty') throw new Error(`installPtydRuntime: cannot locate ${mod} near ${opts.daemonScript}`);
      continue; // node-addon-api is best-effort (build-time dep)
    }
    const dest = path.join(binDir, 'node_modules', mod);
    const tmpDest = `${dest}.${process.pid}.tmp`;
    const oldDest = `${dest}.old.${process.pid}`;
    fs.rmSync(tmpDest, { recursive: true, force: true });
    fs.rmSync(oldDest, { recursive: true, force: true });
    fs.cpSync(src, tmpDest, { recursive: true, dereference: true });
    // Swap-aside instead of rm-then-rename: shrinks the window where `dest`
    // doesn't exist on disk to the single (near-instant) rename below,
    // instead of spanning the whole rm+rename.
    if (fs.existsSync(dest)) fs.renameSync(dest, oldDest);
    fs.renameSync(tmpDest, dest);
    try { fs.rmSync(oldDest, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // Completeness marker, last.
  if (marker) {
    const tmpVer = `${installedVersionFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpVer, marker);
    fs.renameSync(tmpVer, installedVersionFile);
  } else {
    // No source marker (dev edge): stay incomplete so every boot re-installs.
    process.stderr.write(`[ptyd-supervisor] no ptyd.version beside ${opts.daemonScript}; installing without marker (re-installs each boot)\n`);
  }
  return result();
}

/**
 * Identity of the source bundle for skip-check purposes: version + size +
 * mtime. Repo history shows ptyd source changes usually ship WITHOUT a
 * version bump, so comparing on version alone means a rebuilt bundle's
 * installed bytes go stale forever. Folding in size+mtime makes a rebuild
 * (even an unbumped one) re-install. When the interpreter is installed too,
 * its identity joins the composite so an app update shipping a new Node
 * re-installs the copy instead of running the daemon on the old one forever.
 */
function sourceMarker(
  daemonScript: string,
  sourceVersion: string | null,
  /** The interpreter being installed alongside, or null when it is not. */
  nodeSource: string | null,
): string | null {
  if (!sourceVersion) return null;
  try {
    const st = fs.statSync(daemonScript);
    // Identity = version + size + mtime of the source bundle: a rebuilt
    // bundle re-installs even when nobody bumped package.json (the common
    // case — most ptyd changes ship without a version bump).
    let marker = `${sourceVersion}:${st.size}:${Math.floor(st.mtimeMs)}`;
    if (nodeSource) marker += `:${interpreterIdentity(nodeSource)}`;
    return marker;
  } catch {
    return null;
  }
}

/** size+mtime of an interpreter binary — what the marker and the sentinel key on. */
function interpreterIdentity(nodeSource: string): string | null {
  try {
    const ns = fs.statSync(nodeSource);
    return `node-${ns.size}-${Math.floor(ns.mtimeMs)}`;
  } catch {
    return null;
  }
}

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

// Can this copied interpreter start at all? `--version` needs no script and
// exercises exactly what breaks a non-relocatable binary: dynamic loading.
function copyCanRun(exe: string): boolean {
  const res = spawnSync(exe, ['--version'], { stdio: 'ignore', timeout: 15_000 });
  return res.status === 0;
}

/** Find a module dir near the daemon script: <dir>/node_modules/<mod> walking up. */
function resolveModuleDir(daemonScript: string, mod: string): string | null {
  let dir = path.dirname(daemonScript);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', mod);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function ensurePtyDaemon(opts: {
  stateDir: string;
  daemonScript: string;
}): Promise<PtyDaemonHandle> {
  const dir = path.join(opts.stateDir, 'ptyd');
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, 'ptyd.sock');

  // Install/refresh the stable daemon copy FIRST: the spawn below and any
  // later handoff self-spawn (argv[1]) must both read from a durable path.
  // Memoized per process: reconnect loops call ensurePtyDaemon repeatedly,
  // and once this process has installed (or validated) a copy for this
  // stateDir+daemonScript pair, redoing the fs stat/read work on every call
  // is pure waste — one install (or skip-check) per process is enough.
  const memoKey = `${opts.stateDir}\0${opts.daemonScript}`;
  const cached = installedOnce.get(memoKey);
  // Re-verify the cached install against the FULL completeness predicate —
  // script, interpreter, and node-pty. A wiped (or partially wiped) stateDir
  // mid-process must self-heal on the next spawn, not fail until server
  // restart, and checking only the script would happily hand back an install
  // whose node_modules or interpreter someone deleted.
  const binDir = path.join(opts.stateDir, 'ptyd', 'bin');
  const cachedIsComplete =
    !!cached &&
    fs.existsSync(cached.script) &&
    fs.existsSync(cached.execPath) &&
    fs.existsSync(path.join(binDir, 'node_modules', 'node-pty', 'package.json'));
  const installed = cachedIsComplete && cached ? cached : installPtydRuntime(opts);
  installedOnce.set(memoKey, installed);

  // Adopt: manifest + answering socket = live daemon, reuse it.
  const manifest = readManifest(opts.stateDir);
  if (manifest && manifest.socketPath === socketPath) {
    try {
      const { daemonVersion, daemonPid } = await probeDaemon(socketPath);
      // A handoff may have swapped in a successor since this manifest was
      // written — the pid we adopted no longer owns the socket. Rewrite so
      // the manifest tracks whoever actually answers (Task 7's upgrade test
      // depends on this: it probes the manifest after an in-place upgrade).
      if (daemonPid !== -1 && daemonPid !== manifest.pid) {
        const m: Manifest = { pid: daemonPid, socketPath, daemonVersion, startedAt: Date.now() };
        const tmp = `${manifestPath(opts.stateDir)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
        fs.renameSync(tmp, manifestPath(opts.stateDir));
      }
      return { socketPath, daemonVersion };
    } catch {
      // Dead or unresponsive — clean and respawn below.
    }
  }
  try { fs.unlinkSync(socketPath); } catch { /* ENOENT fine */ }

  const logPath = path.join(dir, 'ptyd.log');
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) fs.truncateSync(logPath, 0);
  } catch { /* best-effort */ }
  const logFd = fs.openSync(logPath, 'a');

  // detached + unref: the daemon must survive this server exiting. Both
  // argv[0] and argv[1] come from the install — the installed interpreter
  // where we copied one (Linux), else the server's own Node binary.
  const child = spawn(installed.execPath, [installed.script, `--socket=${socketPath}`], {
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
  });
  fs.closeSync(logFd);
  const pid = child.pid;
  child.unref();
  if (!pid) throw new Error('ptyd spawn returned no pid');

  // spawn() failures (e.g. ENOENT) can surface asynchronously as an 'error'
  // event rather than a thrown exception. Unhandled, that crashes the whole
  // server. Record it and let the wait loop below fail fast instead.
  // (Wrapped in an object — a bare `let` here gets over-narrowed by TS's
  // control-flow analysis, which can't see the reassignment happening
  // inside the `once` closure.)
  const spawnErrBox: { err: Error | null } = { err: null };
  child.once('error', (err) => { spawnErrBox.err = err; });

  // Wait for the socket to answer.
  const start = Date.now();
  let lastErr: Error | null = null;
  while (Date.now() - start < SPAWN_WAIT_MS) {
    if (spawnErrBox.err) throw new Error(`ptyd spawn failed: ${spawnErrBox.err.message} (log: ${logPath})`);
    try {
      const { daemonVersion } = await probeDaemon(socketPath, 500);
      const m: Manifest = { pid, socketPath, daemonVersion, startedAt: Date.now() };
      const tmp = `${manifestPath(opts.stateDir)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
      fs.renameSync(tmp, manifestPath(opts.stateDir));
      return { socketPath, daemonVersion };
    } catch (err) {
      lastErr = err as Error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // This call's spawn never became reachable — reap it. Only a daemon that
  // passed the probe (and is recorded in the manifest) may outlive us.
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  throw new Error(`ptyd did not come up within ${SPAWN_WAIT_MS}ms: ${lastErr?.message ?? 'unknown'} (log: ${logPath})`);
}
