import { describe, expect, it } from 'vitest';
import { sampleMachine } from './machine.js';

describe('sampleMachine', () => {
  it('reports memory, cpu and uptime for this machine', async () => {
    const sample = await sampleMachine({ windowMs: 20 });

    expect(sample.memTotalBytes).toBeGreaterThan(0);
    expect(sample.memUsedBytes).toBeGreaterThan(0);
    expect(sample.memUsedBytes).toBeLessThanOrEqual(sample.memTotalBytes);
    expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(sample.cpuPercent).toBeLessThanOrEqual(100);
    expect(sample.cpuCount).toBeGreaterThan(0);
    expect(sample.uptimeSec).toBeGreaterThan(0);
    expect(sample.loadAvg).toHaveLength(3);
  });

  it('leaves disk figures null when the probe fails', async () => {
    const sample = await sampleMachine({
      windowMs: 20,
      diskProbe: async () => { throw new Error('no df here'); },
    });

    expect(sample.diskTotalBytes).toBeNull();
    expect(sample.diskUsedBytes).toBeNull();
  });

  it('parses a df listing into bytes', async () => {
    const sample = await sampleMachine({
      windowMs: 20,
      diskProbe: async () => [
        'Filesystem   1024-blocks      Used Available Capacity  Mounted on',
        '/dev/disk3s5   971350180 610638404 354711776      64%    /',
      ].join('\n'),
    });

    expect(sample.diskTotalBytes).toBe(971_350_180 * 1024);
    expect(sample.diskUsedBytes).toBe(610_638_404 * 1024);
  });

  it('leaves disk figures null when df prints something unexpected', async () => {
    const sample = await sampleMachine({ windowMs: 20, diskProbe: async () => 'not a df table' });

    expect(sample.diskTotalBytes).toBeNull();
  });
});
