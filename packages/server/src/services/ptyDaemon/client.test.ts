import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtydServer } from '@strado/ptyd';
import { createDaemonClient, type DaemonClient } from './client.js';

let dir: string;
let server: PtydServer;
let client: DaemonClient;
let sock: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-cli-'));
  sock = path.join(dir, 'ptyd.sock');
  server = new PtydServer({ socketPath: sock, daemonVersion: '0.0.0-test' });
  await server.listen();
  client = createDaemonClient(sock);
  await client.connect();
});

afterEach(async () => {
  client.destroy();
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const meta = { shell: '/bin/sh', argv: ['-c', 'printf ready; cat'], cwd: '/tmp', cols: 80, rows: 24 };

describe('DaemonClient', () => {
  it('open resolves with pid; output flows to the global sink', async () => {
    const chunks: Array<{ id: string; data: string }> = [];
    client.onOutput((id, chunk) => chunks.push({ id, data: chunk.toString() }));
    const { pid } = await client.open('k1', meta);
    expect(pid).toBeGreaterThan(0);
    client.subscribe('k1', true);
    await vwait(() => chunks.some((c) => c.id === 'k1' && c.data.includes('ready')));
    client.input('k1', Buffer.from('ping\n'));
    await vwait(() => chunks.some((c) => c.data.includes('ping')));
  });

  it('open rejects on daemon-side spawn failure', async () => {
    await expect(client.open('bad', { ...meta, cwd: '/nonexistent-x' })).rejects.toThrow(/cwd does not exist/);
  });

  it('list returns live sessions', async () => {
    await client.open('k2', meta);
    const sessions = await client.list();
    expect(sessions.map((s) => s.id)).toContain('k2');
  });

  it('close triggers session exit event', async () => {
    const exits: string[] = [];
    client.onSessionExit((id) => exits.push(id));
    await client.open('k3', meta);
    client.subscribe('k3', false);
    client.close('k3');
    await vwait(() => exits.includes('k3'));
  });

  it('onDisconnect fires when the daemon goes away', async () => {
    let dropped = false;
    client.onDisconnect(() => { dropped = true; });
    await server.close();
    await vwait(() => dropped);
  });

  it('pending list rejects when the connection drops mid-flight', async () => {
    const p = client.list();
    const closing = server.close();
    await expect(p).rejects.toThrow(/daemon connection lost|connection lost|socket closed/);
    await closing;
  });

  it('onDisconnect fires exactly once per connection loss', async () => {
    let fires = 0;
    client.onDisconnect(() => { fires += 1; });
    await server.close();
    await vwait(() => fires >= 1);
    await new Promise((r) => setTimeout(r, 100)); // allow any duplicate to land
    expect(fires).toBe(1);
  });

  it('prepareUpgrade resolves ok:false when the daemon replies nak', async () => {
    // In-process PtydServer's prepareUpgrade will attempt a real self-spawn
    // of vitest's script and fail the ack; from the client's view this is a
    // clean {ok:false}. This pins the request/reply plumbing.
    const result = await client.prepareUpgrade();
    expect(result.ok).toBe(false);
  }, 20000);
});

async function vwait(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('vwait timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
