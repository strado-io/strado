import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessManager, type ProcessManager } from '../../src/services/processManager.js';
import { createEventBus } from '../../src/events/bus.js';

// A "dev server" that, like webpack-dev-server with SSL, binds a HARD-CODED
// port that has nothing to do with the PORT env Strado configured.
const listenScript = (port: number) =>
  `const s=require('net').createServer();s.listen(${port},()=>console.log('listening '+${port}));`;

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
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('processManager EADDRINUSE retry', () => {
  let proc: ProcessManager | null = null;
  const keys: string[] = [];

  afterEach(async () => {
    for (const key of keys) await proc?.stop(key).catch(() => undefined);
    keys.length = 0;
  });

  it('evicts the squatter (a managed sibling) and retries once', async () => {
    proc = createProcessManager(createEventBus());
    const realPort = await freePort();
    const opts = (key: string) => ({
      key,
      cwd: process.cwd(),
      command: process.execPath,
      args: ['-e', listenScript(realPort)],
      env: {},
      // the configured port is intentionally different from the real bind
      port: realPort + 1,
    });

    keys.push('/wt/a', '/wt/b');
    await proc.start(opts('/wt/a'));
    await until(() => proc!.snapshot('/wt/a').some((l) => l.includes('listening')));

    await proc.start(opts('/wt/b'));
    // B crashes on EADDRINUSE, the manager stops A and retries B
    await until(
      () => proc!.status('/wt/b').status === 'running' &&
        proc!.snapshot('/wt/b').some((l) => l.includes(`listening ${realPort}`)),
    );
    expect(proc.status('/wt/a').status).toBe('stopped');
    expect(proc.snapshot('/wt/b').join('\n')).toContain('evicting the listener and retrying');
  }, 20_000);

  it('does not retry forever when eviction cannot free the port', async () => {
    proc = createProcessManager(createEventBus());
    // squatter OUTSIDE the manager that ignores SIGTERM is hard to fake
    // portably; instead verify the retry flag: two consecutive EADDRINUSE
    // crashes end in 'crashed', not an infinite loop.
    // wildcard bind — a 127.0.0.1 bind would coexist with the child's
    // 0.0.0.0 bind on macOS and there would be no conflict at all
    const realPort = await freePort();
    const srv = net.createServer();
    srv.listen(realPort);
    await once(srv, 'listening');
    // the vitest process owns the port; eviction skips process.pid, so the
    // retry's second attempt crashes again and must NOT schedule a third
    keys.push('/wt/c');
    await proc.start({
      key: '/wt/c',
      cwd: process.cwd(),
      command: process.execPath,
      args: ['-e', listenScript(realPort)],
      env: {},
      port: realPort + 1,
    });
    await until(() => {
      const tail = proc!.snapshot('/wt/c').join('\n');
      return proc!.status('/wt/c').status === 'crashed' && tail.includes('evicting');
    });
    // settle: give a hypothetical runaway loop time to show itself
    await new Promise((r) => setTimeout(r, 1500));
    expect(proc.status('/wt/c').status).toBe('crashed');
    const evictions = proc.snapshot('/wt/c').filter((l) => l.includes('evicting')).length;
    expect(evictions).toBe(1);
    srv.close();
  }, 20_000);
});
