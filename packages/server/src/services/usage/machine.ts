import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type MachineSample = {
  /** Busy share of all cores over the sample window, 0-100. */
  cpuPercent: number;
  cpuCount: number;
  memUsedBytes: number;
  memTotalBytes: number;
  /** Null when the platform's disk probe is unavailable or unparseable. */
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  loadAvg: number[];
  uptimeSec: number;
};

export type MachineOptions = {
  /** How long to watch the CPU counters; short enough for a request. */
  windowMs?: number;
  diskProbe?: () => Promise<string>;
  /** `vm_stat` output on darwin; overridden in tests. */
  memProbe?: () => Promise<string>;
};

type CpuTotals = { idle: number; total: number };

function cpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [mode, value] of Object.entries(cpu.times)) {
      total += value;
      if (mode === 'idle') idle += value;
    }
  }
  return { idle, total };
}

const defaultMemProbe = async (): Promise<string> => {
  const { stdout } = await run('vm_stat');
  return stdout;
};

/**
 * `os.freemem()` on macOS counts only genuinely free pages, so a healthy
 * machine reads 99% used — inactive and speculative pages are reclaimable on
 * demand and are not pressure. `vm_stat` exposes them, which is the same basis
 * Activity Monitor reports against.
 */
export function parseVmStat(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number => {
    const found = new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(output);
    return found ? Number(found[1]) : 0;
  };
  const reclaimable = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
  if (reclaimable <= 0) return null;
  return reclaimable * pageSize;
};

const defaultDiskProbe = async (): Promise<string> => {
  const { stdout } = await run('df', ['-k', os.homedir()]);
  return stdout;
};

/** Reads the 1024-block total/used columns out of a `df -k` listing. */
function parseDf(output: string): { total: number; used: number } | null {
  const rows = output.trim().split('\n').slice(1);
  for (const row of rows) {
    const columns = row.trim().split(/\s+/);
    const total = Number(columns[1]);
    const used = Number(columns[2]);
    if (Number.isFinite(total) && Number.isFinite(used) && total > 0) {
      return { total: total * 1024, used: used * 1024 };
    }
  }
  return null;
}

/** A point-in-time look at the machine the agents are running on. */
export async function sampleMachine({
  windowMs = 150,
  diskProbe = defaultDiskProbe,
  memProbe = defaultMemProbe,
}: MachineOptions = {}): Promise<MachineSample> {
  const before = cpuTotals();
  const disk = await (async () => {
    try {
      return parseDf(await diskProbe());
    } catch {
      return null;
    }
  })();
  // The disk probe usually covers the window on its own; top it up when it
  // returned instantly so the CPU delta is still meaningful.
  const elapsed = Math.max(0, windowMs - 5);
  if (elapsed > 0) await new Promise((resolve) => setTimeout(resolve, elapsed));
  const after = cpuTotals();

  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  const cpuPercent = totalDelta > 0
    ? Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100))
    : 0;

  const memTotalBytes = os.totalmem();
  const available = process.platform === 'darwin'
    ? await (async () => {
      try {
        return parseVmStat(await memProbe());
      } catch {
        return null;
      }
    })()
    : null;
  return {
    cpuPercent,
    cpuCount: os.cpus().length,
    memUsedBytes: Math.max(0, memTotalBytes - (available ?? os.freemem())),
    memTotalBytes,
    diskUsedBytes: disk?.used ?? null,
    diskTotalBytes: disk?.total ?? null,
    loadAvg: os.loadavg(),
    uptimeSec: os.uptime(),
  };
}
