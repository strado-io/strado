#!/usr/bin/env node
// strado-forward — one loopback TCP listener bridged to a port on a runner.
//
//   strado-forward --runner runner-dev --remote-port 3000 --server http://127.0.0.1:7777
//
// Its own process on purpose. The local server is the one that enumerates every
// worktree, and Electron's main process composites the window including the
// preview browser — which is this feature's main consumer. Dev-server asset
// traffic belongs in neither.
//
// stdout is a machine protocol (one JSON object per line); logs go to stderr.
import { DEFAULT_IDLE_MS, startForwardListener, type ForwardCredential } from './services/portForward.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const runnerId = arg('runner');
const remotePort = Number(arg('remote-port'));
const localPortArg = arg('local-port');
const serverOrigin = arg('server') ?? 'http://127.0.0.1:7777';
const idleMs = arg('idle-ms') !== undefined ? Number(arg('idle-ms')) : DEFAULT_IDLE_MS;

if (!runnerId) fail('usage: strado-forward --runner <id> --remote-port <n> [--local-port <n>] [--server <origin>]');
if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort >= 65536) fail(`bad --remote-port: ${arg('remote-port')}`);

const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (line: string) => process.stderr.write(`[forward ${runnerId}:${remotePort}] ${line}\n`);

// The device token stays in the local server; this process only ever holds a
// runner-scoped ticket, and only for its TTL. The origin rides along in the same
// response, so it can never disagree with the credential that authorizes it.
let cached: { credential: ForwardCredential; expiresAt: number } | null = null;
async function getCredential(): Promise<ForwardCredential> {
  // Re-mint a minute early, so a connection can't start with a ticket that
  // expires mid-transfer.
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.credential;
  const res = await fetch(`${serverOrigin}/api/runners/${encodeURIComponent(runnerId!)}/socket-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`socket-ticket failed (${res.status})`);
  const body = (await res.json()) as { ticket?: string; expiresAt?: string; httpBase?: string };
  if (!body.ticket || !body.httpBase) throw new Error('socket-ticket response missing ticket/httpBase');
  cached = {
    credential: { ticket: body.ticket, runnerOrigin: body.httpBase },
    expiresAt: Date.parse(body.expiresAt ?? '') || Date.now() + 60_000,
  };
  return cached.credential;
}

// Fail before binding a port: a listener that can't authorize anything is worse
// than no listener, because the UI would show a mapping that never works.
try {
  await getCredential();
} catch (err) {
  fail(`cannot reach the local server for a ticket: ${(err as Error).message}`);
}

const listener = await startForwardListener({
  remotePort,
  localPort: localPortArg !== undefined ? Number(localPortArg) : 0,
  getCredential,
  idleMs,
  onIdle: () => {
    emit({ type: 'idle' });
    void shutdown(0);
  },
  log,
}).catch((err: Error) => fail(`cannot listen: ${err.message}`));

emit({ type: 'listening', localPort: listener.localPort, remotePort });

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  await listener.close().catch(() => {});
  process.exit(code);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void shutdown(0));
// The parent going away must not leave an orphan holding a local port.
process.stdin.on('close', () => void shutdown(0));
process.stdin.resume();
