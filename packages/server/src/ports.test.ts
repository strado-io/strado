import { describe, it, expect } from 'vitest';
import { findFreePort } from './ports.js';

describe('findFreePort', () => {
  it('never hands out the instance\'s own port', async () => {
    const port = await findFreePort(7877, new Set(), 7877);
    expect(port).not.toBe(7877);
    expect(port).toBeGreaterThan(7877);
  });

  it('still respects explicitly reserved ports', async () => {
    const port = await findFreePort(7900, new Set([7900, 7901]), 7777);
    expect(port).toBeGreaterThanOrEqual(7902);
  });
});
