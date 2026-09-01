import { describe, expect, it } from 'vitest';
import { parseVmStat, sampleMachine } from './machine.js';

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

describe('parseVmStat', () => {
  const output = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                            400000.',
    'Pages inactive:                          200000.',
    'Pages speculative:                        50000.',
    'Pages purgeable:                          20000.',
  ].join('\n');

  it('counts reclaimable pages as available memory', () => {
    expect(parseVmStat(output)).toBe((10_000 + 200_000 + 50_000 + 20_000) * 16_384);
  });

  it('returns null when the output is not vm_stat', () => {
    expect(parseVmStat('nope')).toBeNull();
  });
});

describe('memory on darwin', () => {
  it('uses the reclaimable figure rather than free pages alone', async () => {
    const output = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               10000.',
      'Pages inactive:                          200000.',
    ].join('\n');

    const sample = await sampleMachine({ windowMs: 20, memProbe: async () => output });

    if (process.platform !== 'darwin') {
      expect(sample.memUsedBytes).toBeGreaterThan(0);
      return;
    }
    expect(sample.memUsedBytes).toBe(sample.memTotalBytes - 210_000 * 16_384);
  });

  it('falls back to free memory when the probe fails', async () => {
    const sample = await sampleMachine({
      windowMs: 20,
      memProbe: async () => { throw new Error('no vm_stat'); },
    });

    expect(sample.memUsedBytes).toBeGreaterThan(0);
    expect(sample.memUsedBytes).toBeLessThanOrEqual(sample.memTotalBytes);
  });
});
