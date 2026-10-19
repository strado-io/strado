import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWorktreeAndWait } from './openWorktree';

afterEach(() => { vi.useRealTimers(); });

describe('openWorktreeAndWait', () => {
  it('already on screen: returns its hub without navigating', async () => {
    const port = { path: '/w/a' };
    const open = vi.fn();
    expect(await openWorktreeAndWait('/w/a', () => ({ path: '/w/a', port }), open)).toBe(port);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens it, then resolves once its hub has registered', async () => {
    vi.useFakeTimers();
    let current: { path: string; port: object | null } | null = null;
    const port = { path: '/w/b' };
    const open = vi.fn(() => { setTimeout(() => { current = { path: '/w/b', port }; }, 120); });
    const p = openWorktreeAndWait('/w/b', () => current, open);
    expect(open).toHaveBeenCalledWith('/w/b');
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toBe(port);
  });

  it('gives up (null) when the hub never shows that worktree', async () => {
    vi.useFakeTimers();
    const p = openWorktreeAndWait('/w/b', () => ({ path: '/w/a', port: {} }), vi.fn(), 1_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await p).toBeNull();
  });
});
