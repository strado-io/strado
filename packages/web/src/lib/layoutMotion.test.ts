import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginLayoutMotion, isLayoutMoving, onLayoutSettled } from './layoutMotion';

afterEach(() => { vi.useRealTimers(); });

describe('layoutMotion', () => {
  it('is moving for the declared time, then settles once; an overlapping motion extends it', () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const off = onLayoutSettled(settled);
    beginLayoutMotion(300);
    expect(isLayoutMoving()).toBe(true);
    vi.advanceTimersByTime(200);
    beginLayoutMotion(300); // a second toggle mid-slide
    vi.advanceTimersByTime(200);
    expect(settled).not.toHaveBeenCalled();
    expect(isLayoutMoving()).toBe(true);
    vi.advanceTimersByTime(150);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(isLayoutMoving()).toBe(false);
    off();
    beginLayoutMotion(10);
    vi.advanceTimersByTime(20);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
