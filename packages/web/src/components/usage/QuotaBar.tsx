import { percent, untilReset } from './format';
import type { UsageQuotaWindow } from '../../types';

const AGENT_FILL: Record<'claude' | 'codex', string> = {
  claude: 'bg-orange-500',
  codex: 'bg-sky-400',
};

/**
 * One rate-limit window: name, a bar, the used percentage, and how long until
 * it resets. A window at 0% still shows a tick of fill so the row reads as a
 * live limit rather than a missing one.
 */
export function QuotaBar({ window: quotaWindow, agent }: { window: UsageQuotaWindow; agent: 'claude' | 'codex' }) {
  const used = Math.max(0, Math.min(100, quotaWindow.usedPercent));
  const reset = untilReset(quotaWindow.resetsAt);
  return (
    <div className="flex items-center gap-2.5 py-[3px] text-[11px]">
      <span className="w-[104px] shrink-0 truncate text-zinc-500">{quotaWindow.label}</span>
      <div
        role="meter"
        aria-label={`${quotaWindow.label} used`}
        aria-valuenow={Math.round(used)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-[3px] min-w-0 flex-1 rounded-full bg-zinc-800"
      >
        <div
          className={`h-full rounded-full ${AGENT_FILL[agent]}`}
          style={{ width: `${Math.max(used, 1.5)}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right font-mono tabular-nums text-zinc-300">{percent(used)}</span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-zinc-600">
        {reset ? `↺ ${reset}` : ''}
      </span>
    </div>
  );
}
