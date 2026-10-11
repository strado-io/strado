import { afterEach, describe, expect, it, vi } from 'vitest';
import { relativeTime, shortRelativeTime } from './relativeTime';

afterEach(() => { vi.useRealTimers(); });

describe('shortRelativeTime', () => {
  it('is the card-sized form of relativeTime: no "ago", "now" under a minute', () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    expect(shortRelativeTime('2026-10-11T11:59:50Z')).toBe('now');
    expect(shortRelativeTime('2026-10-11T11:55:00Z')).toBe('5m');
    expect(shortRelativeTime('2026-10-11T07:00:00Z')).toBe('5h');
    expect(shortRelativeTime('2026-10-08T12:00:00Z')).toBe('3d');
    // Past a month both fall back to the same short date.
    expect(shortRelativeTime('2026-08-01T12:00:00Z')).toBe(relativeTime('2026-08-01T12:00:00Z'));
  });

  it('accepts a millisecond timestamp and returns empty for nothing', () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    expect(shortRelativeTime(Date.parse('2026-10-11T10:00:00Z'))).toBe('2h');
    expect(shortRelativeTime(undefined)).toBe('');
    expect(shortRelativeTime('garbage')).toBe('');
  });
});
