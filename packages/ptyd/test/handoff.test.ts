import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, type TestClient } from './helpers/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(here, '../dist/ptyd.cjs');

let dir: string;
let sock: string;
let daemons: ChildProcess[] = [];
// Successors are spawned BY the predecessor, so they are not in `daemons` and
// are only reachable via the pid in the upgrade result. Record them as soon as
// that pid is known — if the test then fails an assertion, afterEach still has
// to reap them, and socketOwnerPid can't find one whose bind never happened.
const successorPids: number[] = [];

beforeEach(() => {
  expect(fs.existsSync(BUNDLE), `build first: npm run build -w packages/ptyd (missing ${BUNDLE})`).toBe(true);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-ho-'));
  sock = path.join(dir, 'ptyd.sock');
});

afterEach(async () => {
  // Reap every daemon generation we know about, plus whatever owns the
  // socket now (the successor is NOT in `daemons` — it was spawned by the
  // predecessor). killNow-equivalent: SIGTERM kills its sessions too.
  for (const d of daemons.splice(0)) {
    try { d.kill('SIGTERM'); } catch { /* gone */ }
  }
  for (const pid of successorPids.splice(0)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  const owner = await socketOwnerPid(sock);
  if (owner) {
    try { process.kill(owner, 'SIGTERM'); } catch { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(dir, { recursive: true, force: true });
});

function startDaemon(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BUNDLE, `--socket=${sock}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  daemons.push(child);
  const stderr: Buffer[] = [];
  child.stderr!.on('data', (c) => stderr.push(c));
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const probe = net.connect(sock);
      probe.once('connect', () => { probe.destroy(); resolve(child); });
      probe.once('error', () => {
        probe.destroy();
        if (Date.now() - start > 5000) reject(new Error(`daemon never bound: ${Buffer.concat(stderr)}`));
        else setTimeout(poll, 100);
      });
    };
    setTimeout(poll, 100);
  });
}

/** Ask the daemon itself for its pid via hello-ack. */
async function daemonPid(c: TestClient, timeoutMs?: number): Promise<number> {
  c.send({ type: 'hello', protocols: [1] });
  const ack = await c.waitFor((f) => (f.message as { type: string }).type === 'hello-ack', timeoutMs);
  return (ack.message as { daemonPid: number }).daemonPid;
}

/**
 * Retry the WHOLE handshake, not just connect(): during a handoff a conn can
 * be accepted and then dropped mid-hello by the dying predecessor. Retrying
 * only connect() lets such a conn escape the catch and burn the caller's full
 * waitFor budget; a short per-attempt hello deadline discards it and retries.
 */
async function reconnectWithHello(socketPath: string, timeoutMs = 8000): Promise<{ client: TestClient; pid: number }> {
  const start = Date.now();
  for (;;) {
    let c: TestClient | null = null;
    try {
      c = await connect(socketPath);
      c.send({ type: 'hello', protocols: [1] });
      const ack = await c.waitFor((f) => (f.message as { type: string }).type === 'hello-ack', 1000);
      return { client: c, pid: (ack.message as { daemonPid: number }).daemonPid };
    } catch {
      c?.close();
      if (Date.now() - start > timeoutMs) throw new Error('no daemon answered hello within deadline');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function socketOwnerPid(socketPath: string): Promise<number | null> {
  try {
    const c = await connect(socketPath);
    // Bounded: this runs in afterEach against a socket that may belong to a
    // half-dead daemon which accepts but never answers. The default 5s wait
    // would stall teardown for every such test.
    const pid = await daemonPid(c, 1000);
    c.close();
    return pid;
  } catch {
    return null;
  }
}

describe('fd handoff', () => {
  it('sessions survive a daemon swap with the same shell pid and scrollback', async () => {
    await startDaemon();
    const a = await connect(sock);
    const predecessorPid = await daemonPid(a);

    a.send({
      type: 'open',
      id: '/tmp\0shell',
      meta: { shell: '/bin/sh', argv: ['-c', 'printf before-marker; cat'], cwd: '/tmp', cols: 80, rows: 24 },
    });
    const ack = await a.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    const shellPid = (ack.message as { pid: number }).pid;
    a.send({ type: 'subscribe', id: '/tmp\0shell', replay: true });
    await a.waitFor((f) => (f.message as { type: string }).type === 'output' && !!f.payload?.toString().includes('before-marker'));

    // Trigger the handoff. Same bundle bytes — a self-swap, which is
    // exactly what a real upgrade does after the installer replaced the file.
    a.send({ type: 'prepare-upgrade' });
    const prepared = await a.waitFor((f) => (f.message as { type: string }).type === 'upgrade-prepared', 10000);
    const result = (prepared.message as { result: { ok: boolean; successorPid?: number } }).result;
    if (result.successorPid) successorPids.push(result.successorPid);
    expect(result.ok).toBe(true);
    expect(result.successorPid).not.toBe(predecessorPid);
    a.close(); // predecessor is exiting; drop our conn

    // Reconnect — retry the full handshake until the successor answers.
    const { client: b, pid: successorPid } = await reconnectWithHello(sock);
    expect(successorPid).toBe(result.successorPid);

    // Same session, SAME shell pid — the process was never restarted.
    b.send({ type: 'list' });
    const reply = await b.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
    const sessions = (reply.message as { sessions: Array<{ id: string; pid: number }> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('/tmp\0shell');
    expect(sessions[0]!.pid).toBe(shellPid);

    // Scrollback transferred: replay contains the pre-handoff marker.
    b.send({ type: 'subscribe', id: '/tmp\0shell', replay: true });
    await b.waitFor((f) => (f.message as { type: string }).type === 'output' && !!f.payload?.toString().includes('before-marker'));

    // And it is still interactive through the adopted fd.
    b.send({ type: 'input', id: '/tmp\0shell' }, Buffer.from('after-marker\n'));
    await b.waitFor((f) => (f.message as { type: string }).type === 'output' && !!f.payload?.toString().includes('after-marker'));

    // Close the session through the successor: AdoptedPty kill path works.
    b.send({ type: 'close', id: '/tmp\0shell' });
    await b.waitFor((f) => (f.message as { type: string }).type === 'exit', 8000);
    b.close();
  }, 30000);

  it('a handoff with zero sessions succeeds and the successor serves fresh opens', async () => {
    await startDaemon();
    const a = await connect(sock);
    await daemonPid(a);
    a.send({ type: 'prepare-upgrade' });
    const prepared = await a.waitFor((f) => (f.message as { type: string }).type === 'upgrade-prepared', 10000);
    const result = (prepared.message as { result: { ok: boolean; successorPid?: number } }).result;
    if (result.successorPid) successorPids.push(result.successorPid);
    expect(result.ok).toBe(true);
    a.close();

    // Pin the identity: a fresh daemon spawned by a racing ensurePtyDaemon
    // would also serve opens happily, so "someone answers" is not the claim —
    // the claim is that OUR successor owns the path.
    const { client: b, pid: reconnectedPid } = await reconnectWithHello(sock);
    expect(reconnectedPid).toBe(result.successorPid);
    b.send({ type: 'open', id: 'fresh', meta: { shell: '/bin/sh', argv: ['-c', ':'], cwd: '/tmp', cols: 80, rows: 24 } });
    await b.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    await b.waitFor((f) => (f.message as { type: string }).type === 'exit');
    b.close();
  }, 30000);
});
