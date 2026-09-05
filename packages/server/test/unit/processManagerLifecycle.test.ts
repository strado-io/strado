import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessManager, type ProcessManager, type ProcInfo } from '../../src/services/processManager.js';
import { createEventBus } from '../../src/events/bus.js';

async function freePort(): Promise<number> {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  await once(srv, 'close');
  return port;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('processManager lifecycle', () => {
  let proc: ProcessManager | null = null;
  const keys: string[] = [];

  afterEach(async () => {
    for (const key of keys) await proc?.stop(key).catch(() => undefined);
    keys.length = 0;
  });

  it('stays "starting" until the child actually listens, then reports the real port', async () => {
    const bus = createEventBus();
    const seen: ProcInfo['status'][] = [];
    bus.on('worktrees', (evt: { data: { process?: ProcInfo } }) => {
      if (evt.data.process) seen.push(evt.data.process.status);
    });
    proc = createProcessManager(bus);
    const realPort = await freePort();
    // Like webpack-dev-server with SSL: binds a hard-coded port, not $PORT, and
    // only after a boot delay long enough to observe the intermediate state.
    const script = `setTimeout(()=>{require('net').createServer().listen(${realPort},()=>console.log('up'))},700)`;
    keys.push('/wt/slow');
    await proc.start({
      key: '/wt/slow', cwd: process.cwd(), command: process.execPath,
      args: ['-e', script], env: {}, port: realPort + 1,
    });

    // Spawned, but nothing is serving yet — a green "Stop" here would lie.
    expect(proc.status('/wt/slow').status).toBe('starting');
    await sleep(300);
    expect(proc.status('/wt/slow').status).toBe('starting');

    await until(() => proc!.status('/wt/slow').status === 'running');
    expect(proc.status('/wt/slow').port).toBe(realPort);
    expect(seen).toContain('starting');
    expect(seen[seen.length - 1]).toBe('running');
  }, 15_000);

  it('keeps the configured port when the child listens on it', async () => {
    proc = createProcessManager(createEventBus());
    const port = await freePort();
    const script = `require('net').createServer().listen(process.env.PORT,()=>console.log('up'))`;
    keys.push('/wt/env');
    await proc.start({
      key: '/wt/env', cwd: process.cwd(), command: process.execPath,
      args: ['-e', script], env: {}, port,
    });
    await until(() => proc!.status('/wt/env').status === 'running');
    expect(proc.status('/wt/env').port).toBe(port);
  }, 15_000);

  it('reports "stopping" from the stop request until the child has exited', async () => {
    const bus = createEventBus();
    const seen: ProcInfo['status'][] = [];
    bus.on('worktrees', (evt: { data: { process?: ProcInfo } }) => {
      if (evt.data.process) seen.push(evt.data.process.status);
    });
    proc = createProcessManager(bus);
    const port = await freePort();
    // A server that takes its time shutting down on SIGTERM.
    const script = `require('net').createServer().listen(process.env.PORT);`
      + `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),600))`;
    keys.push('/wt/lazy');
    await proc.start({
      key: '/wt/lazy', cwd: process.cwd(), command: process.execPath,
      args: ['-e', script], env: {}, port,
    });
    await until(() => proc!.status('/wt/lazy').status === 'running');

    const stopping = proc.stop('/wt/lazy');
    await sleep(100);
    expect(proc.status('/wt/lazy').status).toBe('stopping');
    // Still holds the port — anything asking must not treat it as free.
    expect(proc.isRunning('/wt/lazy')).toBe(true);
    expect(proc.runningOnPort(port)).toEqual(['/wt/lazy']);

    await stopping;
    expect(proc.status('/wt/lazy').status).toBe('stopped');
    expect(proc.status('/wt/lazy').pid).toBeNull();
    expect(seen).toContain('stopping');
    expect(seen[seen.length - 1]).toBe('stopped');
  }, 15_000);

  it('refuses a second start while the first is still stopping', async () => {
    proc = createProcessManager(createEventBus());
    const port = await freePort();
    const script = `require('net').createServer().listen(process.env.PORT);`
      + `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),600))`;
    const opts = {
      key: '/wt/again', cwd: process.cwd(), command: process.execPath,
      args: ['-e', script], env: {}, port,
    };
    keys.push('/wt/again');
    await proc.start(opts);
    await until(() => proc!.status('/wt/again').status === 'running');
    const stopping = proc.stop('/wt/again');
    await sleep(100);
    await expect(proc.start(opts)).rejects.toThrow(/already running/);
    await stopping;
  }, 15_000);

  it('a child that exits on its own while starting is a crash, not a stop', async () => {
    proc = createProcessManager(createEventBus());
    const port = await freePort();
    keys.push('/wt/boom');
    await proc.start({
      key: '/wt/boom', cwd: process.cwd(), command: process.execPath,
      args: ['-e', 'process.exit(3)'], env: {}, port,
    });
    await until(() => proc!.status('/wt/boom').status === 'crashed');
    expect(proc.status('/wt/boom').exitCode).toBe(3);
  }, 15_000);
});
