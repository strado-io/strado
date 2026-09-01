import { describe, expect, it } from 'vitest';
import { bytes, money, percent, shortDate, tokens, untilReset } from './format';

describe('money', () => {
  it('rounds and groups above a thousand', () => {
    expect(money(3798.42)).toBe('$3,798');
  });

  it('keeps cents below a thousand and trims a dead decimal', () => {
    expect(money(6.35)).toBe('$6.35');
    expect(money(12)).toBe('$12');
  });

  it('marks a non-zero amount too small to show', () => {
    expect(money(0.004)).toBe('<$0.01');
    expect(money(0)).toBe('$0');
  });
});

describe('tokens', () => {
  it('scales to the largest fitting unit', () => {
    expect(tokens(4_200_000_000)).toBe('4.2B');
    expect(tokens(15_200_000)).toBe('15.2M');
    expect(tokens(27_800)).toBe('27.8K');
    expect(tokens(940)).toBe('940');
  });

  it('drops the decimal once three digits fit', () => {
    expect(tokens(975_200_000)).toBe('975M');
  });

  it('reads zero for nothing', () => {
    expect(tokens(0)).toBe('0');
  });
});

describe('percent', () => {
  it('rounds to whole percent', () => {
    expect(percent(36.4)).toBe('36%');
  });

  it('distinguishes a tiny share from none', () => {
    expect(percent(0.2)).toBe('<1%');
    expect(percent(0)).toBe('0%');
  });
});

describe('untilReset', () => {
  const now = Date.parse('2026-09-01T10:00:00Z');

  it('reads hours and minutes within a day', () => {
    expect(untilReset(now + 69 * 60_000, now)).toBe('1h 9m');
  });

  it('reads days and hours beyond one', () => {
    expect(untilReset(now + (6 * 24 + 2) * 3_600_000, now)).toBe('6d 2h');
  });

  it('reads minutes under an hour, never zero', () => {
    expect(untilReset(now + 30_000, now)).toBe('1m');
  });

  it('says now once the window has passed, and nothing without a reset', () => {
    expect(untilReset(now - 1000, now)).toBe('now');
    expect(untilReset(null, now)).toBeNull();
  });
});

describe('shortDate', () => {
  it('formats an ISO date as day and month', () => {
    expect(shortDate('2026-08-03')).toBe('3 Aug');
  });

  it('passes through something unparseable', () => {
    expect(shortDate('not-a-date')).toBe('not-a-date');
  });
});

describe('bytes', () => {
  it('scales to GB and TB', () => {
    expect(bytes(4.1 * 1024 ** 3)).toBe('4.1 GB');
    expect(bytes(2 * 1024 ** 4)).toBe('2.0 TB');
  });

  it('shows a dash when the figure is unknown', () => {
    expect(bytes(null)).toBe('—');
  });
});
