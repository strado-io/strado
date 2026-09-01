import { bytes, percent } from './format';
import { MachineLoading } from './UsageLoading';
import type { MachineSample } from '../../types';

const Meter = ({ label, used, detail }: { label: string; used: number; detail: string }) => (
  <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
    <div className="flex items-baseline justify-between">
      <span className="text-[11px] text-zinc-500">{label}</span>
      <span className="font-mono text-sm tabular-nums text-zinc-200">{percent(used)}</span>
    </div>
    <div className="mt-2 h-[3px] rounded-full bg-zinc-800">
      <div
        className="h-full rounded-full bg-zinc-500"
        style={{ width: `${Math.max(1.5, Math.min(100, used))}%` }}
      />
    </div>
    <div className="mt-1.5 font-mono text-[11px] tabular-nums text-zinc-600">{detail}</div>
  </div>
);

/** Uptime as `4d 3h` / `3h 12m`. */
function uptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** What the box running the agents is doing right now. */
export function MachineResources({ sample }: { sample: MachineSample | null }) {
  if (!sample) return <MachineLoading />;

  const memPercent = sample.memTotalBytes > 0 ? (sample.memUsedBytes / sample.memTotalBytes) * 100 : 0;
  const diskPercent = sample.diskTotalBytes && sample.diskUsedBytes !== null
    ? (sample.diskUsedBytes / sample.diskTotalBytes) * 100
    : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Meter
          label="CPU"
          used={sample.cpuPercent}
          detail={`${sample.cpuCount} cores · load ${sample.loadAvg.map((value) => value.toFixed(2)).join(' ')}`}
        />
        <Meter
          label="Memory"
          used={memPercent}
          detail={`${bytes(sample.memUsedBytes)} of ${bytes(sample.memTotalBytes)}`}
        />
        <Meter
          label="Disk"
          used={diskPercent}
          detail={sample.diskTotalBytes
            ? `${bytes(sample.diskUsedBytes)} of ${bytes(sample.diskTotalBytes)}`
            : 'Not reported on this platform'}
        />
      </div>
      <p className="text-[11px] text-zinc-600">Up {uptime(sample.uptimeSec)} · sampled when this tab opened</p>
    </div>
  );
}
