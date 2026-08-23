import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/events/bus';
import { createProcessManager } from '../../src/services/processManager';

let tmp: string;
const SCRIPT = `
const port = process.env.PORT || '9999';
console.log('hello on http://localhost:' + port);
setInterval(() => {}, 1_000_000);
`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'proc-'));
  await fs.writeFile(path.join(tmp, 'server.js'), SCRIPT);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('process manager', () => {
  it('starts and tails logs', async () => {
    const bus = createEventBus();
    const pm = createProcessManager(bus);
    await pm.start({
      key: '/path/a',
      cwd: tmp,
      command: 'node',
      args: ['server.js'],
      env: { PORT: '9123' },
      port: 9123,
    });
    await waitFor(() => pm.status('/path/a').detectedUrl !== null, 3_000);
    const status = pm.status('/path/a');
    expect(status.status).toBe('running');
    expect(status.detectedUrl).toContain('localhost:9123');
    await pm.stop('/path/a');
    expect(pm.status('/path/a').status).toBe('stopped');
  });

  it('rejects start when already running', async () => {
    const bus = createEventBus();
    const pm = createProcessManager(bus);
    await pm.start({ key: '/path/b', cwd: tmp, command: 'node', args: ['server.js'], env: {}, port: 9124 });
    await expect(
      pm.start({ key: '/path/b', cwd: tmp, command: 'node', args: ['server.js'], env: {}, port: 9125 }),
    ).rejects.toMatchObject({ code: 'PROCESS_ALREADY_RUNNING' });
    await pm.stop('/path/b');
  });

  it('records crash with exit code', async () => {
    const bus = createEventBus();
    const pm = createProcessManager(bus);
    await fs.writeFile(path.join(tmp, 'crash.js'), 'process.exit(3);');
    await pm.start({ key: '/path/c', cwd: tmp, command: 'node', args: ['crash.js'], env: {}, port: 9126 });
    await waitFor(() => pm.status('/path/c').status === 'crashed', 3_000);
    expect(pm.status('/path/c').exitCode).toBe(3);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}
