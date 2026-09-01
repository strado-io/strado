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
export async function sampleMachine({ windowMs = 150, diskProbe = defaultDiskProbe }: MachineOptions = {}): Promise<MachineSample> {
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
  return {
    cpuPercent,
    cpuCount: os.cpus().length,
    memUsedBytes: memTotalBytes - os.freemem(),
    memTotalBytes,
    diskUsedBytes: disk?.used ?? null,
    diskTotalBytes: disk?.total ?? null,
    loadAvg: os.loadavg(),
    uptimeSec: os.uptime(),
  };
}
