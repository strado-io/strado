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

function startDaemon(extraArgs: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BUNDLE, `--socket=${sock}`, ...extraArgs], { stdio: ['ignore', 'ignore', 'pipe'], env });
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

  // macOS ties privacy grants to the "responsible process" fixed at spawn; the
  // successor (and its shells) inherit the predecessor's pid, so the
  // predecessor must outlive the handoff or every shell is attributed to a
  // dead process. See PtydServer.linger.
  it.skipIf(process.platform !== 'darwin')(
    'macOS: the predecessor lingers while the successor serves, and a signal to it stops both',
    async () => {
      const predecessor = await startDaemon();
      const a = await connect(sock);
      await daemonPid(a);
      a.send({ type: 'prepare-upgrade' });
      const prepared = await a.waitFor((f) => (f.message as { type: string }).type === 'upgrade-prepared', 10000);
      const result = (prepared.message as { result: { ok: boolean; successorPid?: number } }).result;
      expect(result.ok).toBe(true);
      const successorPid = result.successorPid!;
      successorPids.push(successorPid);
      a.close();

      const { client: b } = await reconnectWithHello(sock);
      b.close();
      // Served by the successor, and the predecessor is still here.
      await new Promise((r) => setTimeout(r, 500));
      expect(predecessor.exitCode).toBeNull();
      expect(predecessor.signalCode).toBeNull();

      // Stopping the predecessor (launchd booting the job out, say) must stop
      // the daemon that is actually serving, then exit itself.
      const exited = new Promise<void>((r) => predecessor.once('exit', () => r()));
      predecessor.kill('SIGTERM');
      await exited;
      const start = Date.now();
      for (;;) {
        try { process.kill(successorPid, 0); } catch { break; }
        if (Date.now() - start > 5000) throw new Error('successor outlived the predecessor');
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    30000,
  );
});

/** A stand-in for strado-disclaim: records each argv, then execs it (fds and the IPC channel pass through exec). */
function fakeLauncher(): { path: string; calls: () => string[][] } {
  const log = path.join(dir, 'launcher.log');
  const p = path.join(dir, 'fake-disclaim');
  fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\0' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\nexec "$@"\n`, { mode: 0o755 });
  return {
    path: p,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\0').filter(Boolean)) : []),
  };
}

async function openShell(c: TestClient, marker: string): Promise<{ shellPid: number; daemon: number }> {
  const daemon = await daemonPid(c); // the daemon wants a hello first
  c.send({ type: 'open', id: '/tmp\0shell', meta: { shell: '/bin/sh', argv: ['-c', `printf ${marker}; cat`], cwd: '/tmp', cols: 80, rows: 24 } });
  const ack = await c.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
  c.send({ type: 'subscribe', id: '/tmp\0shell', replay: true });
  await c.waitFor((f) => (f.message as { type: string }).type === 'output' && !!f.payload?.toString().includes(marker));
  return { shellPid: (ack.message as { pid: number }).pid, daemon };
}

describe('handoff through the launcher (macOS privacy identity)', () => {
  it('a successor is started through the launcher, marked responsible, and keeps the sessions', async () => {
    const launcher = fakeLauncher();
    await startDaemon([`--launcher=${launcher.path}`, '--responsible']);
    const a = await connect(sock);
    const { shellPid } = await openShell(a, 'launch-marker');
    a.send({ type: 'prepare-upgrade' });
    const prepared = await a.waitFor((f) => (f.message as { type: string }).type === 'upgrade-prepared', 10000);
    const result = (prepared.message as { result: { ok: boolean; successorPid?: number } }).result;
    if (result.successorPid) successorPids.push(result.successorPid);
    expect(result.ok).toBe(true);
    a.close();
    const calls = launcher.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['--handoff', '--responsible', `--launcher=${launcher.path}`]));
    const { client: b, pid } = await reconnectWithHello(sock);
    expect(pid).toBe(result.successorPid);
    b.send({ type: 'list' });
    const reply = await b.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
    expect((reply.message as { sessions: Array<{ pid: number }> }).sessions.map((x) => x.pid)).toEqual([shellPid]);
    // Responsible already: no second hop.
    await new Promise((r) => setTimeout(r, 1500));
    expect(launcher.calls()).toHaveLength(1);
    b.close();
  }, 30000);

  it('a successor that is not its own responsible process re-homes itself through the launcher, sessions intact', async () => {
    const launcher = fakeLauncher();
    // The old daemon knows no launcher (as a 0.1.64 daemon would): its successor
    // finds one and must hop once more on its own.
    await startDaemon(['--launcher=none', '--responsible'], { ...process.env, STRADO_PTYD_LAUNCHER: launcher.path });
    const a = await connect(sock);
    const { shellPid, daemon: first } = await openShell(a, 'rehome-marker');
    a.send({ type: 'prepare-upgrade' });
    const prepared = await a.waitFor((f) => (f.message as { type: string }).type === 'upgrade-prepared', 10000);
    const result = (prepared.message as { result: { ok: boolean; successorPid?: number } }).result;
    if (result.successorPid) successorPids.push(result.successorPid);
    expect(result.ok).toBe(true);
    a.close();
    expect(launcher.calls()).toHaveLength(0); // hop 1 went the old way
    // Hop 2: the successor re-homes through the launcher.
    const start = Date.now();
    let pid = 0;
    let b: TestClient | null = null;
    while (Date.now() - start < 10000) {
      const r = await reconnectWithHello(sock);
      b?.close();
      b = r.client; pid = r.pid;
      if (launcher.calls().length === 1 && pid !== result.successorPid && pid !== first) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    successorPids.push(pid);
    expect(launcher.calls()).toHaveLength(1);
    expect(launcher.calls()[0]).toEqual(expect.arrayContaining(['--handoff', '--responsible']));
    expect(pid).not.toBe(result.successorPid);
    b!.send({ type: 'list' });
    const reply = await b!.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
    expect((reply.message as { sessions: Array<{ pid: number }> }).sessions.map((x) => x.pid)).toEqual([shellPid]);
    b!.send({ type: 'subscribe', id: '/tmp\0shell', replay: true });
    await b!.waitFor((f) => (f.message as { type: string }).type === 'output' && !!f.payload?.toString().includes('rehome-marker'));
    b!.send({ type: 'input', id: '/tmp\0shell' }, Buffer.from('still-alive\n'));
    // Output may arrive in several frames: look across all of them.
    const seen = () => b!.frames().filter((f) => (f.message as { type: string }).type === 'output').map((f) => f.payload?.toString() ?? '').join('');
    const until = Date.now() + 5000;
    while (!seen().includes('still-alive') && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(seen()).toContain('still-alive');
    b!.close();
  }, 40000);
});
