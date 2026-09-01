import { useState } from 'react';
import { stackedSeries, type ChartMetric } from './chartGeometry';
import { money, shortDate, tokens } from './format';
import type { UsageDayPoint } from '../../types';

const BOX = { width: 1000, height: 420 };
const PAD = { left: 8, right: 8, top: 8, bottom: 22 };

const axisLabel = (value: number, metric: ChartMetric) => (
  metric === 'cost' ? money(value) : tokens(value)
);

/**
 * Daily spend, stacked by agent. Hand-rolled SVG: the repo draws its own
 * graphics, and the page needs one chart rather than a charting runtime.
 *
 * The plot is drawn in a fixed viewBox and scaled by the browser, so the same
 * geometry works at any pane width without re-measuring on resize.
 */
export function UsageChart({ series, metric }: { series: UsageDayPoint[]; metric: ChartMetric }) {
  const [hover, setHover] = useState<number | null>(null);
  const plot = { width: BOX.width - PAD.left - PAD.right, height: BOX.height - PAD.top - PAD.bottom };
  const geometry = stackedSeries(series, metric, plot);
  const hovered = hover === null ? null : series[hover] ?? null;

  const format = (value: number) => (metric === 'cost' ? money(value) : tokens(value));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        className="h-[320px] w-full"
        role="img"
        aria-label={`Daily ${metric} by agent`}
        onMouseLeave={() => setHover(null)}
      >
        <g transform={`translate(${PAD.left} ${PAD.top})`}>
          {geometry.ticks.map((tick, index) => {
            const y = plot.height - (tick / geometry.max) * plot.height;
            return (
              <g key={tick}>
                <line x1={0} x2={plot.width} y1={y} y2={y} stroke="currentColor" className="text-zinc-900" strokeWidth={1} />
                {index > 0 && (
                  <text x={0} y={y - 6} className="fill-zinc-600 font-mono text-[13px]">
                    {axisLabel(tick, metric)}
                  </text>
                )}
              </g>
            );
          })}

          <path d={geometry.claudeArea} className="fill-orange-500/15" />
          <path d={geometry.codexArea} className="fill-sky-400/15" />
          <path d={geometry.claudeLine} fill="none" className="stroke-orange-500" strokeWidth={2} />
          <path d={geometry.codexLine} fill="none" className="stroke-sky-400" strokeWidth={2} />

          {hover !== null && geometry.xs[hover] !== undefined && (
            <line
              x1={geometry.xs[hover]}
              x2={geometry.xs[hover]}
              y1={0}
              y2={plot.height}
              className="stroke-zinc-700"
              strokeWidth={1}
            />
          )}

          {/* One hit target per day, so hovering reads the exact figures. */}
          {series.map((point, index) => (
            <rect
              key={point.date}
              x={(geometry.xs[index] ?? 0) - (geometry.xs[1] ?? plot.width) / 2}
              y={0}
              width={geometry.xs[1] ?? plot.width}
              height={plot.height}
              fill="transparent"
              onMouseEnter={() => setHover(index)}
            />
          ))}

          {series.length > 0 && (
            <>
              <text x={0} y={plot.height + 16} className="fill-zinc-600 font-mono text-[13px]">
                {shortDate(series[0]!.date)}
              </text>
              <text x={plot.width} y={plot.height + 16} textAnchor="end" className="fill-zinc-600 font-mono text-[13px]">
                {shortDate(series[series.length - 1]!.date)}
              </text>
            </>
          )}
        </g>
      </svg>

      {hovered && (
        <div
          data-testid="usage-chart-readout"
          className="pointer-events-none absolute right-0 top-0 rounded-md border border-zinc-800 bg-zinc-950/95 px-2 py-1.5 text-[11px] shadow-lg"
        >
          <div className="mb-0.5 text-zinc-400">{shortDate(hovered.date)}</div>
          <div className="flex items-center gap-2 font-mono tabular-nums text-zinc-300">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-orange-500" />
            {format(hovered.claude[metric])}
          </div>
          <div className="flex items-center gap-2 font-mono tabular-nums text-zinc-300">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            {format(hovered.codex[metric])}
          </div>
        </div>
      )}
    </div>
  );
}
