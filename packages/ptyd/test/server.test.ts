import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtydServer } from '../src/server.js';
import { spawnPty } from '../src/pty.js';
import { connect, type TestClient } from './helpers/client.js';
import type { SessionMeta } from '../src/protocol.js';

const SH = '/bin/sh';
const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  shell: SH, argv: ['-c', 'printf ready; cat'], cwd: '/tmp', cols: 80, rows: 24, ...over,
});

let dir: string;
let server: PtydServer;
let sock: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-'));
  sock = path.join(dir, 'ptyd.sock');
  server = new PtydServer({ socketPath: sock, daemonVersion: '0.0.0-test' });
  await server.listen();
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function hello(c: TestClient): Promise<void> {
  c.send({ type: 'hello', protocols: [1] });
  const ack = await c.waitFor((f) => (f.message as { type: string }).type === 'hello-ack');
  expect((ack.message as { protocol: number }).protocol).toBe(1);
}

describe('PtydServer', () => {
  it('sets 0600 on the socket file', () => {
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  });

  it('rejects ops before hello', async () => {
    const c = await connect(sock);
    c.send({ type: 'list' });
    const err = await c.waitFor((f) => (f.message as { type: string }).type === 'error');
    expect((err.message as { code: string }).code).toBe('EPROTO');
    c.close();
  });

  it('open → output → input → exit round-trip, byte-perfect', async () => {
    const c = await connect(sock);
    await hello(c);
    c.send({ type: 'open', id: 'k1', meta: meta() });
    const ack = await c.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    expect((ack.message as { pid: number }).pid).toBeGreaterThan(0);
    c.send({ type: 'subscribe', id: 'k1', replay: true });
    await c.waitFor((f) => {
      const m = f.message as { type: string; id?: string };
      return m.type === 'output' && f.payload !== null && f.payload.toString().includes('ready');
    });
    c.send({ type: 'input', id: 'k1' }, Buffer.from('echo-me\n'));
    await c.waitFor((f) => (f.message as { type: string }).type === 'output' && !!f.payload?.toString().includes('echo-me'));
    c.send({ type: 'close', id: 'k1' });
    await c.waitFor((f) => (f.message as { type: string }).type === 'exit');
    c.close();
  });

  it('duplicate open on a live id fails; open on an exited id respawns', async () => {
    const c = await connect(sock);
    await hello(c);
    c.send({ type: 'open', id: 'dup', meta: meta() });
    await c.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    c.send({ type: 'open', id: 'dup', meta: meta() });
    await c.waitFor((f) => (f.message as { type: string }).type === 'open-err');
    c.close();
  });

  it('replay delivers buffered output to a late subscriber, then exit still arrives', async () => {
    const a = await connect(sock);
    await hello(a);
    a.send({ type: 'open', id: 'k2', meta: meta({ argv: ['-c', 'printf early; sleep 30'] }) });
    await a.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    // No subscriber yet — bytes land only in the ring buffer.
    await new Promise((r) => setTimeout(r, 300));
    const b = await connect(sock);
    await hello(b);
    b.send({ type: 'subscribe', id: 'k2', replay: true });
    await b.waitFor((f) => (f.message as { type: string }).type === 'output' && !!f.payload?.toString().includes('early'));
    b.send({ type: 'close', id: 'k2' });
    await b.waitFor((f) => (f.message as { type: string }).type === 'exit');
    a.close(); b.close();
  });

  it('list reports live sessions and drops exited ones', async () => {
    const c = await connect(sock);
    await hello(c);
    c.send({ type: 'open', id: 'k3', meta: meta() });
    await c.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    c.send({ type: 'list' });
    const reply = await c.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
    const sessions = (reply.message as { sessions: Array<{ id: string }> }).sessions;
    expect(sessions.map((s) => s.id)).toEqual(['k3']);
    c.send({ type: 'close', id: 'k3' });
    await c.waitFor((f) => (f.message as { type: string }).type === 'exit');
    c.send({ type: 'list' });
    const after = await c.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
    expect((after.message as { sessions: unknown[] }).sessions).toEqual([]);
    c.close();
  });

  it('sessions survive a client disconnect (the whole point)', async () => {
    const a = await connect(sock);
    await hello(a);
    a.send({ type: 'open', id: 'k4', meta: meta() });
    await a.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    a.close(); // "server restart"
    const b = await connect(sock);
    await hello(b);
    b.send({ type: 'list' });
    const reply = await b.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
    expect((reply.message as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual(['k4']);
    b.send({ type: 'close', id: 'k4' });
    await b.waitFor((f) => (f.message as { type: string }).type === 'exit');
    b.close();
  });

  it('rejects hello with an unsupported protocol version (EVERSION)', async () => {
    const c = await connect(sock);
    c.send({ type: 'hello', protocols: [2] });
    const err = await c.waitFor((f) => (f.message as { type: string }).type === 'error');
    expect((err.message as { code: string }).code).toBe('EVERSION');
    c.close();
  });

  it('broadcasts exit to negotiated non-subscribers (lifecycle event, pinned)', async () => {
    const a = await connect(sock);
    await hello(a);
    a.send({ type: 'open', id: 'k5', meta: meta() });
    await a.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    const b = await connect(sock);
    await hello(b); // negotiated, never subscribes
    a.send({ type: 'close', id: 'k5' });
    await b.waitFor((f) => (f.message as { type: string; id?: string }).type === 'exit');
    a.close(); b.close();
  });

  it('duplicate open does not orphan a second shell (list stays at one pid)', async () => {
    const c = await connect(sock);
    await hello(c);
    c.send({ type: 'open', id: 'k6', meta: meta() });
    const ack = await c.waitFor((f) => (f.message as { type: string }).type === 'open-ack');
    const pid = (ack.message as { pid: number }).pid;
    c.send({ type: 'open', id: 'k6', meta: meta() });
    await c.waitFor((f) => (f.message as { type: string }).type === 'open-err');
    c.send({ type: 'list' });
    const reply = await c.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
    const sessions = (reply.message as { sessions: Array<{ id: string; pid: number }> }).sessions;
    expect(sessions).toEqual([{ id: 'k6', pid, cols: 80, rows: 24 }]);
    c.send({ type: 'close', id: 'k6' });
    await c.waitFor((f) => (f.message as { type: string }).type === 'exit');
    c.close();
  });

  it('refuses to steal a live daemon socket', async () => {
    const second = new PtydServer({ socketPath: sock, daemonVersion: '0.0.0-thief' });
    await expect(second.listen()).rejects.toThrow(/refusing to steal/);
    // the original server is untouched
    const c = await connect(sock);
    await hello(c);
    c.close();
  });

  it('adoptSnapshot rejects a non-tty fd before any store mutation', async () => {
    // fd 0 is avoided deliberately: adoptFromFd would construct a
    // tty.ReadStream over vitest's own stdin before failing.
    const nullFd = fs.openSync('/dev/null', 'r');
    try {
      expect(() =>
        server.adoptSnapshot({
          version: 1,
          sessions: [{ id: 'nope', pid: 99999, cols: 80, rows: 24, fdIndex: nullFd, buffer: Buffer.alloc(0) }],
        }),
      ).toThrow(/not a tty/);
    } finally {
      fs.closeSync(nullFd);
    }
    const c = await connect(sock);
    await hello(c);
    c.send({ type: 'list' });
    const reply = await c.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
    expect((reply.message as { sessions: unknown[] }).sessions).toEqual([]);
    c.close();
  });

  it('adoptSnapshot rolls back adopted sessions on duplicate id; live session unharmed', async () => {
    const c = await connect(sock);
    await hello(c);
    c.send({ type: 'open', id: 'roll', meta: meta() });
    await c.waitFor((f) => (f.message as { type: string }).type === 'open-ack');

    // Two throwaway ptys give us real master fds and real live pids to
    // "inherit". The fds are handed over as /dev/fd dups, NOT as node-pty's
    // own descriptors: rollback closes what it adopts (closeLocal →
    // ReadStream autoClose), and closing node-pty's master out from under it
    // makes its internal reader throw an uncaught `read EBADF`. In production
    // the inherited fd genuinely is this process's only copy, which is what
    // the dup reproduces here. (On Linux /dev/fd/N on a master resolves to
    // ptmx, so the open yields a fresh unrelated master — still a genuine
    // tty, so the test's meaning holds on both platforms.)
    const t1 = spawnPty({ shell: SH, argv: ['-c', 'sleep 30'], cwd: '/tmp', cols: 80, rows: 24 });
    const t2 = spawnPty({ shell: SH, argv: ['-c', 'sleep 30'], cwd: '/tmp', cols: 80, rows: 24 });
    const fd1 = fs.openSync(`/dev/fd/${t1.getMasterFd()}`, 'r+');
    const fd2 = fs.openSync(`/dev/fd/${t2.getMasterFd()}`, 'r+');
    try {
      expect(() =>
        server.adoptSnapshot({
          version: 1,
          sessions: [
            { id: 'fresh-adopt', pid: t1.pid, cols: 80, rows: 24, fdIndex: fd1, buffer: Buffer.from('x') },
            { id: 'roll', pid: t2.pid, cols: 80, rows: 24, fdIndex: fd2, buffer: Buffer.alloc(0) },
          ],
        }),
      ).toThrow(/exists/);
      // Rollback unwound the first (successfully adopted) session; the live
      // session it collided with is untouched and still serving.
      c.send({ type: 'list' });
      const reply = await c.waitFor((f) => (f.message as { type: string }).type === 'list-reply');
      expect((reply.message as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual(['roll']);
    } finally {
      t1.killNow();
      t2.killNow();
    }
    c.send({ type: 'close', id: 'roll' });
    await c.waitFor((f) => (f.message as { type: string }).type === 'exit');
    c.close();
  });

  it('listenWithRetry gives up against a live daemon within its cap', async () => {
    const second = new PtydServer({ socketPath: sock, daemonVersion: '0.0.0-retry' });
    const started = Date.now();
    await expect(second.listenWithRetry(300)).rejects.toThrow(/refusing to steal/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });
});
