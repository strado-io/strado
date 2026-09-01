import { money, percent, tokens } from './format';
import type { UsageTotals } from '../../types';

/** Where the tokens went, under the chart: one figure per column. */
export function StatStrip({ totals }: { totals: UsageTotals }) {
  const cachedShare = totals.cachedInput + totals.uncachedInput > 0
    ? (totals.cachedInput / (totals.cachedInput + totals.uncachedInput)) * 100
    : 0;

  const cells: { label: string; value: string }[] = [
    { label: 'Processed tokens', value: tokens(totals.tokens) },
    { label: 'Cached input', value: `${tokens(totals.cachedInput)} · ${percent(cachedShare)}` },
    { label: 'Uncached input', value: tokens(totals.uncachedInput) },
    { label: 'Output', value: tokens(totals.output) },
    {
      label: 'Cache savings',
      value: `${money(totals.cacheSavings)} · ${totals.cacheSavingsMultiple.toFixed(1)}x`,
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-zinc-900 pt-3 sm:grid-cols-3 lg:grid-cols-5">
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0">
          <dt className="truncate text-[11px] text-zinc-600">{cell.label}</dt>
          <dd className="mt-0.5 truncate font-mono text-sm tabular-nums text-zinc-200">{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}
