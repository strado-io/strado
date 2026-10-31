import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginLayoutMotion, isLayoutMoving, onLayoutMotion, onLayoutSettled } from './layoutMotion';

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

  it('tells motion listeners when a motion starts, not when one is extended', () => {
    vi.useFakeTimers();
    const started = vi.fn();
    const off = onLayoutMotion(started);
    beginLayoutMotion(300);
    beginLayoutMotion(300); // overlapping: the same motion, longer
    expect(started).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(400);
    beginLayoutMotion(100);
    expect(started).toHaveBeenCalledTimes(2);
    off();
    vi.advanceTimersByTime(200);
    beginLayoutMotion(100);
    expect(started).toHaveBeenCalledTimes(2);
  });
});
