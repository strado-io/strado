import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from '../../src/ports';

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((r) => s.close(() => r())),
    ),
  );
});

function holdPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve();
    });
  });
}

describe('findFreePort', () => {
  it('returns the base port when it is free', async () => {
    const port = await findFreePort(45_321, new Set());
    expect(port).toBe(45_321);
  });

  it('skips reserved ports', async () => {
    const port = await findFreePort(45_400, new Set([45_400, 45_401]));
    expect(port).toBe(45_402);
  });

  it('skips ports already bound by another process', async () => {
    await holdPort(45_500);
    const port = await findFreePort(45_500, new Set());
    expect(port).toBe(45_501);
  });

  it('trusts privileged base port if not reserved', async () => {
    const port = await findFreePort(443, new Set());
    expect(port).toBe(443);
  });

  it('falls back to non-privileged range when privileged base is reserved', async () => {
    const port = await findFreePort(443, new Set([443]));
    expect(port).toBeGreaterThanOrEqual(8000);
  });
});
