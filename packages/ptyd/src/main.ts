// strado-ptyd entrypoint.
//
//   node ptyd.cjs --socket=/path/to/ptyd.sock [--buffer-bytes=262144]
//   node ptyd.cjs --handoff --snapshot=PATH --socket=PATH
//
// Flags ride argv, NOT env: esbuild statically inlines process.env.X and
// dead-code-eliminates branches — argv survives every bundler.
// Logs to stderr; stdout stays empty.

import fs from 'node:fs';
import path from 'node:path';
import { PtydServer } from './server.js';
import { readSnapshot, clearSnapshot, type HandoffSnapshot } from './snapshot.js';
import { type HandoffMessage } from './protocol.js';

const DAEMON_VERSION = '0.2.3'; // bump alongside package.json

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

/**
 * macOS privacy (TCC) judges every process by its "responsible process". A
 * launchd-started daemon is its own — but a handoff successor inherits its
 * predecessor's, and a predecessor from an older app version runs a binary
 * the update has since replaced: macOS can no longer match ANY grant to it
 * (Desktop, Full Disk Access, the microphone all fail). The packaged app ships
 * strado-disclaim beside the runtime (inside Strado Terminals.app): starting a
 * successor through it makes that successor its own responsible process, with
 * the helper's stable identity. `--launcher=PATH|none` and
 * STRADO_PTYD_LAUNCHER override the lookup (tests); off macOS there is none.
 */
function resolveLauncher(): string | null {
  const flag = arg('launcher');
  if (flag !== undefined) return flag === 'none' ? null : flag;
  const env = process.env.STRADO_PTYD_LAUNCHER;
  if (env) return env === 'none' ? null : env;
  if (process.platform !== 'darwin') return null;
  try {
    const p = path.join(path.dirname(fs.realpathSync(process.execPath)), 'strado-disclaim');
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Set by launchd jobs and by successors started through the launcher. */
const RESPONSIBLE = process.argv.includes('--responsible');
const REHOME_DELAY_MS = 500;

/**
 * A daemon that is not its own responsible process, with a launcher at hand,
 * hands its sessions to a successor started through it — once, sessions intact.
 * On failure it keeps serving as it is.
 */
function rehomeIfNeeded(server: PtydServer, launcher: string | null): void {
  if (!launcher || RESPONSIBLE) return;
  setTimeout(() => {
    process.stderr.write(`[ptyd] not its own responsible process; re-homing through ${launcher}\n`);
    server.prepareUpgrade().then(
      (r) => { if (!r.ok) process.stderr.write(`[ptyd] re-home failed, still serving: ${r.reason}\n`); },
      (err) => process.stderr.write(`[ptyd] re-home failed, still serving: ${(err as Error).message}\n`),
    );
  }, REHOME_DELAY_MS).unref();
}

async function main(): Promise<void> {
  // Mode signal via argv, NOT env — esbuild statically inlines process.env.X
  // and DCEs the unused branch; argv survives every bundler.
  if (process.argv.includes('--handoff')) {
    await runHandoffReceiver();
    return;
  }
  await runFresh();
}

async function runFresh(): Promise<void> {
  const socketPath = arg('socket');
  if (!socketPath) throw new Error('--socket=PATH is required');
  const rawBuf = arg('buffer-bytes');
  const bufferCap = rawBuf ? Number.parseInt(rawBuf, 10) : undefined;
  if (bufferCap !== undefined && (!Number.isFinite(bufferCap) || bufferCap <= 0)) {
    throw new Error(`--buffer-bytes must be a positive integer, got: ${rawBuf}`);
  }

  const launcher = resolveLauncher();
  const server = new PtydServer({ socketPath, daemonVersion: DAEMON_VERSION, bufferCap, launcher });
  await server.listen();
  process.stderr.write(`[ptyd] listening on ${socketPath} (v${DAEMON_VERSION}, pid=${process.pid})\n`);

  wireShutdown(server);
  rehomeIfNeeded(server, launcher);
}

async function runHandoffReceiver(): Promise<void> {
  const log = (msg: string) => process.stderr.write(`[ptyd handoff-recv pid=${process.pid}] ${msg}\n`);
  const snapshotPath = arg('snapshot');
  const socketPath = arg('socket');
  if (!snapshotPath) throw new Error('--snapshot=PATH is required in handoff mode');
  if (!socketPath) throw new Error('--socket=PATH is required in handoff mode');
  if (typeof process.send !== 'function') {
    throw new Error('handoff receiver requires an IPC channel');
  }
  log(`snapshot=${snapshotPath} socket=${socketPath} v${DAEMON_VERSION}`);

  const nak = (reason: string) => {
    log(`NAK: ${reason}`);
    const msg: HandoffMessage = { type: 'upgrade-nak', reason };
    process.send?.(msg);
    setTimeout(() => process.exit(1), 50).unref();
  };

  let snapshot: HandoffSnapshot;
  try {
    snapshot = readSnapshot(snapshotPath);
  } catch (err) {
    nak(`snapshot read failed: ${(err as Error).message}`);
    return;
  }
  log(`read snapshot: sessions=${snapshot.sessions.length}`);

  const launcher = resolveLauncher();
  const server = new PtydServer({ socketPath, daemonVersion: DAEMON_VERSION, launcher });
  try {
    server.adoptSnapshot(snapshot);
  } catch (err) {
    nak(`adopt failed: ${(err as Error).message}`);
    return;
  }
  log('adopted; sending upgrade-ack');
  const ack: HandoffMessage = { type: 'upgrade-ack', successorPid: process.pid };
  process.send?.(ack);

  // Don't bind until the predecessor's listener is closed — that close is what
  // unlinks the socket path (libuv), and it would otherwise race/delete our
  // bind. The predecessor signals 'socket-released' the instant it closes,
  // which is far earlier than its full exit ('disconnect'): waiting for exit
  // leaves a ~600ms window with no socket file at all, long enough for a
  // concurrently booting ensurePtyDaemon to spawn a fresh zero-session daemon
  // and starve us out of the path. Take whichever comes first; 1s bound as
  // defense, and listenWithRetry absorbs any remaining race.
  log('waiting for socket release');
  await new Promise<void>((resolve) => {
    if (process.connected !== true) return resolve();
    const onMsg = (raw: unknown) => {
      if ((raw as { type?: string })?.type === 'socket-released') done();
    };
    const done = () => {
      process.removeListener('message', onMsg);
      resolve();
    };
    process.on('message', onMsg);
    process.once('disconnect', done);
    setTimeout(done, 1_000).unref();
  });

  log('binding socket');
  await server.listenWithRetry();
  clearSnapshot(snapshotPath);
  process.stderr.write(
    `[ptyd] (handoff successor) listening on ${socketPath} (v${DAEMON_VERSION}, pid=${process.pid}, sessions=${snapshot.sessions.length})\n`,
  );
  wireShutdown(server);
  rehomeIfNeeded(server, launcher);
}

function wireShutdown(server: PtydServer): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    // After a handoff this process only lingers for the successor (macOS,
    // see PtydServer.linger); the signal is the successor's to act on.
    if (server.forwardSignalToSuccessor(signal)) return;
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[ptyd] received ${signal}, shutting down (killing sessions)\n`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[ptyd] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
