import { describe, expect, it } from 'vitest';
import { axisTop, stackedSeries } from './chartGeometry';
import type { UsageDayPoint } from '../../types';

const day = (date: string, claude: number, codex = 0): UsageDayPoint => ({
  date,
  claude: { cost: claude, tokens: claude * 1000 },
  codex: { cost: codex, tokens: codex * 1000 },
});

const box = { width: 600, height: 400 };
const finite = (path: string) => !/NaN|Infinity|undefined/.test(path);

describe('axisTop', () => {
  it('keeps gridline values round', () => {
    const geometry = stackedSeries([day('2026-08-30', 437)], 'cost', box);

    expect(geometry.ticks).toEqual([0, 250, 500]);
  });

  it('rounds a peak up to 1, 2 or 5 times a power of ten', () => {
    expect(axisTop(437)).toBe(500);
    expect(axisTop(120)).toBe(200);
    expect(axisTop(0.42)).toBe(0.5);
  });

  it('never returns zero, so no coordinate divides by it', () => {
    expect(axisTop(0)).toBe(1);
    expect(axisTop(-5)).toBe(1);
  });
});

describe('stackedSeries', () => {
  it('draws both stacks with finite coordinates', () => {
    const geometry = stackedSeries([day('2026-08-30', 100, 20), day('2026-08-31', 300, 40)], 'cost', box);

    expect(finite(geometry.claudeArea)).toBe(true);
    expect(finite(geometry.codexArea)).toBe(true);
    expect(finite(geometry.claudeLine)).toBe(true);
    expect(finite(geometry.codexLine)).toBe(true);
  });

  it('puts the peak day at the top of the plot', () => {
    const geometry = stackedSeries([day('2026-08-30', 0), day('2026-08-31', 500)], 'cost', box);

    expect(geometry.max).toBe(500);
    expect(geometry.codexLine).toContain('0');
    expect(geometry.claudeLine.startsWith('M 0 400')).toBe(true);
  });

  it('stacks codex above claude rather than over it', () => {
    const geometry = stackedSeries([day('2026-08-30', 250, 250), day('2026-08-31', 250, 250)], 'cost', box);

    // Claude's line sits at half height, the stacked total at the top.
    expect(geometry.claudeLine).toContain('200');
    expect(geometry.codexLine.startsWith('M 0 0')).toBe(true);
  });

  it('handles a single day without dividing by zero', () => {
    const geometry = stackedSeries([day('2026-08-30', 10)], 'cost', box);

    expect(finite(geometry.claudeArea)).toBe(true);
    expect(geometry.xs).toEqual([300]);
  });

  it('handles an all-zero series by drawing flat on the baseline', () => {
    const geometry = stackedSeries([day('2026-08-30', 0), day('2026-08-31', 0)], 'cost', box);

    expect(finite(geometry.claudeArea)).toBe(true);
    expect(geometry.max).toBe(1);
    expect(geometry.claudeLine).toBe('M 0 400 C 200 400 400 400 600 400');
  });

  it('produces nothing to draw for an empty series', () => {
    const geometry = stackedSeries([], 'cost', box);

    expect(geometry.claudeArea).toBe('');
    expect(geometry.codexArea).toBe('');
    expect(geometry.ticks).toEqual([0, 0.5, 1]);
  });

  it('switches the axis to tokens when asked', () => {
    const geometry = stackedSeries([day('2026-08-30', 100)], 'tokens', box);

    expect(geometry.max).toBe(100_000);
  });

  it('ignores negative or non-finite values instead of inverting the curve', () => {
    const broken: UsageDayPoint[] = [
      { date: '2026-08-30', claude: { cost: Number.NaN, tokens: 0 }, codex: { cost: -50, tokens: 0 } },
      day('2026-08-31', 100),
    ];

    const geometry = stackedSeries(broken, 'cost', box);

    expect(finite(geometry.claudeArea)).toBe(true);
    expect(geometry.max).toBe(100);
  });
});
