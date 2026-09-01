import type { UsageDayPoint } from '../../types';

export type ChartMetric = 'cost' | 'tokens';

export type ChartBox = { width: number; height: number };

export type StackedSeries = {
  /** Closed area path for Claude Code, stacked from the baseline. */
  claudeArea: string;
  /** Closed area path for Codex, stacked on top of Claude. */
  codexArea: string;
  /** Top edge of each stack, drawn as the stroke. */
  claudeLine: string;
  codexLine: string;
  /** Y-axis tick values in data units, bottom to top. */
  ticks: number[];
  /** Peak of the stacked total, after rounding up to a tick. */
  max: number;
  /** X position of each day, for hover hit-testing. */
  xs: number[];
};

const valueOf = (point: UsageDayPoint, metric: ChartMetric, agent: 'claude' | 'codex'): number => {
  const value = point[agent][metric];
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * Rounds a peak up to a readable axis top: 1, 2 or 5 times a power of ten. A
 * flat or empty series still gets a non-zero top so the baseline has somewhere
 * to sit and no coordinate divides by zero.
 */
export function axisTop(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (peak <= candidate) return candidate;
  }
  return 10 * magnitude;
}

/**
 * Monotone cubic interpolation: a curve as smooth as a spline but one that
 * cannot overshoot into negative territory between two points, which a plain
 * Catmull-Rom would do on the spiky day-to-day shape usage data has.
 */
function monotonePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;

  const slopes: number[] = [];
  const secants: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const dx = points[index + 1]!.x - points[index]!.x;
    secants.push(dx === 0 ? 0 : (points[index + 1]!.y - points[index]!.y) / dx);
  }
  slopes.push(secants[0] ?? 0);
  for (let index = 1; index < points.length - 1; index += 1) {
    const left = secants[index - 1]!;
    const right = secants[index]!;
    slopes.push(left * right <= 0 ? 0 : (left + right) / 2);
  }
  slopes.push(secants[secants.length - 1] ?? 0);

  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const dx = (to.x - from.x) / 3;
    path += ` C ${from.x + dx} ${from.y + slopes[index]! * dx}`
      + ` ${to.x - dx} ${to.y - slopes[index + 1]! * dx}`
      + ` ${to.x} ${to.y}`;
  }
  return path;
}

/**
 * Turns the daily series into the two stacked areas the chart draws. All
 * coordinates are finite for any input — an empty series, one day, or a run of
 * zeroes — so the SVG never carries a NaN path.
 */
export function stackedSeries(
  series: UsageDayPoint[],
  metric: ChartMetric,
  { width, height }: ChartBox,
): StackedSeries {
  const peak = series.reduce(
    (highest, point) => Math.max(highest, valueOf(point, metric, 'claude') + valueOf(point, metric, 'codex')),
    0,
  );
  const max = axisTop(peak);
  const step = series.length > 1 ? width / (series.length - 1) : 0;
  const xs = series.map((_, index) => (series.length > 1 ? index * step : width / 2));
  const y = (value: number) => height - (Math.min(value, max) / max) * height;

  const claudePoints = series.map((point, index) => ({
    x: xs[index]!,
    y: y(valueOf(point, metric, 'claude')),
  }));
  const stackedPoints = series.map((point, index) => ({
    x: xs[index]!,
    y: y(valueOf(point, metric, 'claude') + valueOf(point, metric, 'codex')),
  }));

  const claudeLine = monotonePath(claudePoints);
  const codexLine = monotonePath(stackedPoints);
  const close = (path: string, points: { x: number; y: number }[]) => (
    points.length && path
      ? `${path} L ${points[points.length - 1]!.x} ${height} L ${points[0]!.x} ${height} Z`
      : ''
  );

  return {
    claudeArea: close(claudeLine, claudePoints),
    // Codex fills the band between the two lines: its own top edge, then back
    // along Claude's, so the two areas never overlap.
    codexArea: claudeLine && codexLine
      ? `${codexLine} L ${claudePoints[claudePoints.length - 1]!.x} ${claudePoints[claudePoints.length - 1]!.y}`
        + ` ${[...claudePoints].reverse().slice(1).map((point) => `L ${point.x} ${point.y}`).join(' ')} Z`
      : '',
    claudeLine,
    codexLine,
    // Halves of a 1/2/5 axis top stay round numbers; thirds would print
    // $333.33 on the gridline.
    ticks: [0, max / 2, max],
    max,
    xs,
  };
}
