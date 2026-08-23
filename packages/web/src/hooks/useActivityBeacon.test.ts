import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useActivityBeacon } from './useActivityBeacon';
import { api } from '../api';

let beat: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  // restoreAllMocks detaches spies, so re-arm them per test
  beat = vi.spyOn(api.activity, 'beat').mockResolvedValue({ ok: true });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useActivityBeacon', () => {
  it('beats immediately and then every 30s while focused', () => {
    renderHook(() => useActivityBeacon('/wt/a'));
    expect(beat).toHaveBeenCalledTimes(1);
    expect(beat).toHaveBeenCalledWith('/wt/a');
    vi.advanceTimersByTime(60_000);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it('does not beat while the window is unfocused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    renderHook(() => useActivityBeacon('/wt/a'));
    vi.advanceTimersByTime(60_000);
    expect(beat).not.toHaveBeenCalled();
  });

  it('does nothing without a path and stops on unmount', () => {
    const { unmount } = renderHook(() => useActivityBeacon(null));
    vi.advanceTimersByTime(60_000);
    expect(beat).not.toHaveBeenCalled();

    const mounted = renderHook(() => useActivityBeacon('/wt/a'));
    expect(beat).toHaveBeenCalledTimes(1);
    mounted.unmount();
    vi.advanceTimersByTime(120_000);
    expect(beat).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('re-beats the new path when the target worktree changes', () => {
    const { rerender } = renderHook(({ p }) => useActivityBeacon(p), {
      initialProps: { p: '/wt/a' },
    });
    rerender({ p: '/wt/b' });
    expect(beat).toHaveBeenLastCalledWith('/wt/b');
  });
});
