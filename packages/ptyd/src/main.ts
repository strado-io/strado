// strado-ptyd entrypoint.
//
//   node ptyd.cjs --socket=/path/to/ptyd.sock [--buffer-bytes=262144]
//   node ptyd.cjs --handoff --snapshot=PATH --socket=PATH
//
// Flags ride argv, NOT env: esbuild statically inlines process.env.X and
// dead-code-eliminates branches — argv survives every bundler.
// Logs to stderr; stdout stays empty.

import { PtydServer } from './server.js';
import { readSnapshot, clearSnapshot, type HandoffSnapshot } from './snapshot.js';
import { type HandoffMessage } from './protocol.js';

const DAEMON_VERSION = '0.2.0'; // bump alongside package.json

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
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

  const server = new PtydServer({ socketPath, daemonVersion: DAEMON_VERSION, bufferCap });
  await server.listen();
  process.stderr.write(`[ptyd] listening on ${socketPath} (v${DAEMON_VERSION}, pid=${process.pid})\n`);

  wireShutdown(server);
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

  const server = new PtydServer({ socketPath, daemonVersion: DAEMON_VERSION });
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
}

function wireShutdown(server: PtydServer): void {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
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
