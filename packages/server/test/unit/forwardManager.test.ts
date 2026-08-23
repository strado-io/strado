import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createForwardManager, type ForwardManager } from '../../src/services/forwardManager.js';

// A stand-in for the strado-forward child: same stdout line protocol, same exit
// semantics, no real process or port.
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed: string[] = [];
  constructor(readonly args: string[]) {
    super();
  }
  kill(signal: string): boolean {
    this.killed.push(signal);
    this.exit(0);
    return true;
  }
  listening(localPort: number): void {
    this.stdout.write(`${JSON.stringify({ type: 'listening', localPort })}\n`);
  }
  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code);
  }
}

let spawned: FakeChild[] = [];
let manager: ForwardManager | null = null;

function build(opts: { autoPort?: number | null } = {}): ForwardManager {
  spawned = [];
  const m = createForwardManager({
    serverOrigin: () => 'http://127.0.0.1:7777',
    spawnForward: (args) => {
      const child = new FakeChild(args);
      spawned.push(child);
      // Default: report a port on the next tick, like a real child would.
      if (opts.autoPort !== null) setTimeout(() => child.listening(opts.autoPort ?? 50000 + spawned.length), 0);
      return child as never;
    },
  });
  manager = m;
  return m;
}

afterEach(async () => {
  await manager?.closeAll();
  manager = null;
});

describe('createForwardManager', () => {
  it('spawns a child and reports the port it bound', async () => {
    const m = build({ autoPort: 54321 });
    const forward = await m.open('runner-dev', 3000);
    expect(forward).toMatchObject({
      runnerId: 'runner-dev',
      remotePort: 3000,
      localPort: 54321,
      url: 'http://127.0.0.1:54321',
    });
    expect(spawned[0]!.args).toEqual([
      '--runner', 'runner-dev', '--remote-port', '3000', '--server', 'http://127.0.0.1:7777',
    ]);
  });

  it('reuses an open forward instead of binding a second port', async () => {
    // Opening the same hub twice must not move the local port — an already-open
    // browser tab would start pointing at nothing.
    const m = build({ autoPort: 54321 });
    const a = await m.open('runner-dev', 3000);
    const b = await m.open('runner-dev', 3000);
    expect(b.localPort).toBe(a.localPort);
    expect(spawned.length).toBe(1);
  });

  it('collapses concurrent opens of the same forward', async () => {
    // Two hubs opening at once must not race into two children each holding a
    // local port, with one of them leaked.
    const m = build({ autoPort: 54321 });
    const [a, b] = await Promise.all([m.open('r', 3000), m.open('r', 3000)]);
    expect(a.localPort).toBe(b.localPort);
    expect(spawned.length).toBe(1);
  });

  it('keys by runner AND port', async () => {
    const m = build({});
    await m.open('r1', 3000);
    await m.open('r2', 3000);
    await m.open('r1', 5173);
    expect(m.list().length).toBe(3);
    expect(m.list('r1').map((f) => f.remotePort).sort()).toEqual([3000, 5173]);
  });

  it('surfaces the child\'s own diagnosis when it fails to start', async () => {
    // "exit code 1" would be useless; the child knows why it could not start.
    const m = build({ autoPort: null });
    const open = m.open('runner-dev', 3000);
    await new Promise((r) => setTimeout(r, 0));
    const child = spawned[0]!;
    child.stderr.write('cannot reach the local server for a ticket: fetch failed\n');
    await new Promise((r) => setTimeout(r, 0));
    child.exit(1);
    await expect(open).rejects.toThrow(/cannot reach the local server/);
    expect(m.list()).toEqual([]);
  });

  it('drops the entry when the child exits on idle', async () => {
    // The local port is no longer held; a stale row would advertise a mapping
    // that silently refuses connections.
    const m = build({ autoPort: 54321 });
    await m.open('r', 3000);
    expect(m.get('r', 3000)).toBeDefined();
    spawned[0]!.exit(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.get('r', 3000)).toBeUndefined();
  });

  it('a dead child\'s exit does not evict its replacement', async () => {
    // close() then open() can put a new child under the same key before the old
    // one's exit event lands. Deleting then would orphan a live listener.
    const m = build({ autoPort: 54321 });
    await m.open('r', 3000);
    const first = spawned[0]!;
    await m.close('r', 3000);
    await m.open('r', 3000);
    expect(spawned.length).toBe(2);
    first.emit('exit', 0); // late duplicate from the already-dead child
    await new Promise((r) => setTimeout(r, 0));
    expect(m.get('r', 3000)).toBeDefined();
  });

  it('close terminates the child and forgets the mapping', async () => {
    const m = build({ autoPort: 54321 });
    await m.open('r', 3000);
    await m.close('r', 3000);
    expect(spawned[0]!.killed).toContain('SIGTERM');
    expect(m.list()).toEqual([]);
  });

  it('closeAll stops every child', async () => {
    const m = build({});
    await m.open('r1', 3000);
    await m.open('r2', 5173);
    await m.closeAll();
    expect(spawned.every((c) => c.killed.includes('SIGTERM'))).toBe(true);
    expect(m.list()).toEqual([]);
  });

  it('tolerates a listening line split across chunks', async () => {
    // stdout is a line protocol and a chunk can split anywhere.
    const m = build({ autoPort: null });
    const open = m.open('r', 3000);
    await new Promise((r) => setTimeout(r, 0));
    const child = spawned[0]!;
    child.stdout.write('{"type":"listen');
    await new Promise((r) => setTimeout(r, 0));
    child.stdout.write('ing","localPort":6001}\n');
    await expect(open).resolves.toMatchObject({ localPort: 6001 });
  });

  it('ignores unparseable stdout instead of hanging on it', async () => {
    const m = build({ autoPort: null });
    const open = m.open('r', 3000);
    await new Promise((r) => setTimeout(r, 0));
    const child = spawned[0]!;
    child.stdout.write('not json at all\n');
    child.listening(6002);
    await expect(open).resolves.toMatchObject({ localPort: 6002 });
  });
});
