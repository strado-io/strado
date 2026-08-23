import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSpaceShortcut } from './spaceShortcut';

afterEach(() => {
  document.body.innerHTML = '';
});

function fireCtrlShiftRight(target: EventTarget) {
  const e = new KeyboardEvent('keydown', {
    key: 'ArrowRight',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}

describe('useSpaceShortcut', () => {
  it('registers its window listener in the capture phase, ahead of xterm', () => {
    // xterm.js binds its own keydown handler on a hidden helper textarea
    // inside `.xterm`, bubble-phase, and reacts to Ctrl+Shift+Arrow by
    // writing an escape sequence to the pty unless the event already arrives
    // defaultPrevented. A capture-phase listener on `window` runs before any
    // bubble-phase listener on a descendant, no matter the DOM depth — a
    // bubble-phase window listener would instead run *after* this container's
    // listener, since bubbling reaches the deepest target first. This
    // bubble-phase listener on the container stands in for xterm's own
    // handler: it must see the event already defaultPrevented, which only
    // holds if the hook's listener is itself capture-phase. This test fails
    // if `{ capture: true }` is removed from the hook's addEventListener call.
    const container = document.createElement('div');
    container.className = 'xterm';
    document.body.appendChild(container);

    let seenDefaultPrevented: boolean | null = null;
    container.addEventListener('keydown', (e) => {
      seenDefaultPrevented = e.defaultPrevented;
    });

    const move = vi.fn();
    renderHook(() => useSpaceShortcut(move));

    fireCtrlShiftRight(container);

    expect(seenDefaultPrevented).toBe(true);
    expect(move).toHaveBeenCalledWith(1);
  });

  it('still fires from inside a terminal (.xterm)', () => {
    const container = document.createElement('div');
    container.className = 'xterm';
    document.body.appendChild(container);

    const move = vi.fn();
    renderHook(() => useSpaceShortcut(move));

    const e = fireCtrlShiftRight(container);
    expect(e.defaultPrevented).toBe(true);
    expect(move).toHaveBeenCalledWith(1);
  });

  it('is ignored in a real text field', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const move = vi.fn();
    renderHook(() => useSpaceShortcut(move));

    fireCtrlShiftRight(input);
    expect(move).not.toHaveBeenCalled();
  });

  it('leaves plain Cmd+Arrow (no shift) alone for the tab switcher', () => {
    const move = vi.fn();
    renderHook(() => useSpaceShortcut(move));

    const e = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });
});
