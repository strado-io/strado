import { describe, expect, it, vi } from 'vitest';
import { emptyHistory, navKey, pruneTabs, record, step, type Place } from './navHistory';

const hub = (path: string, tab?: [string, string], focusId: string | null = 'f1'): Place =>
  ({ kind: 'hub', focusId, path, ...(tab ? { tab: { mode: tab[0], id: tab[1] } } : {}) });
const all = () => true;

describe('navHistory', () => {
  it('records new places, ignores the same one, and a tab arriving fills in its worktree', () => {
    let h = emptyHistory();
    h = record(h, hub('/a'));
    h = record(h, hub('/a', ['claude', '1']));
    h = record(h, hub('/a', ['claude', '1']));
    h = record(h, { kind: 'page', page: 'usage' });
    expect(h.stack).toEqual([hub('/a', ['claude', '1']), { kind: 'page', page: 'usage' }]);
    expect(h.at).toBe(1);
  });

  it('back and forward; a new place after going back drops what was ahead', () => {
    let h = [hub('/a', ['shell', '1']), hub('/b', ['claude', '1']), { kind: 'jarvis', focusId: 'f1' } as Place]
      .reduce(record, emptyHistory());
    const back = step(h, -1, all)!;
    expect(back.place).toEqual(hub('/b', ['claude', '1']));
    h = step(back.history, -1, all)!.history;
    expect(h.at).toBe(0);
    expect(step(h, -1, all)).toBeNull();
    expect(step(h, 1, all)!.place).toEqual(hub('/b', ['claude', '1']));
    h = record(h, { kind: 'page', page: 'reviews' });
    expect(h.stack).toHaveLength(2);
    expect(step(h, 1, all)).toBeNull();
  });

  it('steps past places that are gone', () => {
    const h = [hub('/a'), hub('/gone'), hub('/c')].reduce(record, emptyHistory());
    expect(step(h, -1, (p) => p.kind !== 'hub' || p.path !== '/gone')!.place).toEqual(hub('/a'));
  });

  it('a closed tab leaves its worktree as the place; neighbours that match merge', () => {
    let h = [hub('/a', ['claude', '1']), hub('/a', ['shell', '2']), hub('/b')].reduce(record, emptyHistory());
    h = pruneTabs(h, '/a', [{ mode: 'claude', id: '1' }]);
    expect(h.stack).toEqual([hub('/a', ['claude', '1']), hub('/a'), hub('/b')]);
    h = pruneTabs(h, '/a', []);
    expect(h.stack).toEqual([hub('/a'), hub('/b')]);
    expect(h.at).toBe(1);
  });

  it('⌘[ and ⌘] on a Mac, Ctrl elsewhere; Shift or Alt is something else', () => {
    const k = (key: string, o: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key, ...o });
    expect(navKey(k('[', { metaKey: true }), true)).toBe(-1);
    expect(navKey(k(']', { metaKey: true }), true)).toBe(1);
    expect(navKey(k('[', { ctrlKey: true }), true)).toBeNull();
    expect(navKey(k('[', { ctrlKey: true }), false)).toBe(-1);
    expect(navKey(k('[', { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(navKey(k('[', { metaKey: true, altKey: true }), true)).toBeNull();
  });
});

describe('useAppHistory', () => {
  const press = (key: string, o: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...o });
    window.dispatchEvent(e);
    return e;
  };

  it('records places that hold still, ⌘[ / ⌘] restore them, and a handled key is left alone', async () => {
    const { renderHook, act } = await import('@testing-library/react');
    const { useAppHistory, RECORD_MS } = await import('./navHistory');
    vi.useFakeTimers();
    // jsdom's platform isn't a Mac: Ctrl is the modifier.
    const go = vi.fn();
    const usage: Place = { kind: 'page', page: 'usage' };
    const { rerender } = renderHook((p: { place: Place }) => useAppHistory({ scope: 'ws', place: p.place, valid: (x) => x.kind !== 'hub' || x.path !== '/gone', go }),
      { initialProps: { place: hub('/a', ['claude', '1']) } });
    act(() => { vi.advanceTimersByTime(RECORD_MS); });
    rerender({ place: hub('/gone') });
    act(() => { vi.advanceTimersByTime(RECORD_MS); });
    // A passing state that doesn't hold still isn't recorded.
    rerender({ place: { kind: 'jarvis', focusId: 'f1' } });
    act(() => { vi.advanceTimersByTime(RECORD_MS / 2); });
    rerender({ place: usage });
    act(() => { vi.advanceTimersByTime(RECORD_MS); });

    press('[');
    expect(go).toHaveBeenLastCalledWith(hub('/a', ['claude', '1'])); // past /gone
    rerender({ place: hub('/a', ['claude', '1']) });
    act(() => { vi.advanceTimersByTime(RECORD_MS); });
    press(']');
    expect(go).toHaveBeenLastCalledWith(usage);
    expect(go).toHaveBeenCalledTimes(2);

    // Files used the key for its own history: no app step.
    const handled = new KeyboardEvent('keydown', { key: '[', ctrlKey: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(go).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
