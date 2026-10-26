import { render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Focus } from '../api';
import { NEW_FOCUS_EVENT, useFocusShortcut } from './focusShortcut';
import { FocusList } from '../components/sidebar/FocusList';

const f = (id: string, createdAt: string, lastActiveAt: string): Focus => ({ id, name: id, members: [], createdAt, lastActiveAt });
// The sidebar's order is creation: b, a, c (last use, c, a, b, does not count).
const focuses = [f('a', '2026-02-01', '2026-05-01'), f('b', '2026-01-01', '2026-04-01'), f('c', '2026-03-01', '2026-06-01')];

const key = (init: KeyboardEventInit, target: EventTarget = window) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

afterEach(() => { document.body.innerHTML = ''; delete (window as { strado?: unknown }).strado; });

describe('useFocusShortcut', () => {
  it('⌘1–⌘9 activate the nth Focus in the sidebar\'s order (creation, not last use)', () => {
    const activate = vi.fn();
    renderHook(() => useFocusShortcut({ focuses, activeId: 'a', activate }));
    expect(key({ key: '2', metaKey: true }).defaultPrevented).toBe(true);
    expect(activate).toHaveBeenCalledWith('a');
    key({ key: '1', metaKey: true });
    expect(activate).toHaveBeenLastCalledWith('b');
    key({ key: '9', metaKey: true });
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('⌘N is the Nth row of the sidebar\'s list', () => {
    const activate = vi.fn();
    const many = [...focuses, f('d', '2026-04-01', '2026-01-01'), f('e', '2025-12-01', '2026-07-01')];
    render(<FocusList focuses={many} activeId={null} badges={new Map()} activeMenu={[]} onOpen={vi.fn()} onRename={vi.fn()}>{() => null}</FocusList>);
    renderHook(() => useFocusShortcut({ focuses: many, activeId: null, activate }));
    const rows = screen.getAllByRole('button', { name: /^Switch to / }).map((b) => b.getAttribute('aria-label')!.replace('Switch to ', ''));
    expect(rows).toEqual(['e', 'b', 'a', 'c', 'd']);
    rows.forEach((id, i) => {
      key({ key: String(i + 1), metaKey: true });
      expect(activate).toHaveBeenLastCalledWith(id);
    });
  });

  it('⌘⌥→ and ⌘⌥← step through Focuses and wrap; with none active, → starts at the first', () => {
    const activate = vi.fn();
    const { rerender } = renderHook((p: { activeId: string | null }) => useFocusShortcut({ focuses, activeId: p.activeId, activate }), { initialProps: { activeId: 'c' as string | null } });
    key({ key: 'ArrowRight', metaKey: true, altKey: true });
    expect(activate).toHaveBeenLastCalledWith('b'); // c is last; wraps to b
    rerender({ activeId: 'b' });
    key({ key: 'ArrowLeft', metaKey: true, altKey: true });
    expect(activate).toHaveBeenLastCalledWith('c');
    rerender({ activeId: null });
    key({ key: 'ArrowRight', metaKey: true, altKey: true });
    expect(activate).toHaveBeenLastCalledWith('b');
  });

  it('leaves plain ⌘Arrow and ⌘⇧Arrow alone, and keys typed in a text field', () => {
    const activate = vi.fn();
    renderHook(() => useFocusShortcut({ focuses, activeId: 'a', activate }));
    expect(key({ key: 'ArrowRight', metaKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: 'ArrowRight', metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(key({ key: '1', metaKey: true }, input).defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    // The terminal's hidden textarea is the exception.
    const term = document.createElement('div'); term.className = 'xterm';
    const ta = document.createElement('textarea'); term.appendChild(ta); document.body.appendChild(term);
    expect(key({ key: '1', metaKey: true }, ta).defaultPrevented).toBe(true);
    expect(activate).toHaveBeenCalledWith('b');
  });

  it('⇧⌘N asks for a new Focus, by event, as does the forwarded chord; forwarded arrows step', () => {
    const activate = vi.fn();
    const onNew = vi.fn();
    window.addEventListener(NEW_FOCUS_EVENT, onNew);
    let forwarded: ((combo: string) => void) | null = null;
    (window as unknown as { strado: unknown }).strado = { onHotkey: (cb: (combo: string) => void) => { forwarded = cb; return () => { forwarded = null; }; } };
    const { unmount } = renderHook(() => useFocusShortcut({ focuses, activeId: 'a', activate }));
    expect(key({ key: 'n', metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(onNew).toHaveBeenCalledTimes(1);
    forwarded!('new-focus');
    expect(onNew).toHaveBeenCalledTimes(2);
    forwarded!('focus-next');
    expect(activate).toHaveBeenLastCalledWith('c');
    forwarded!('focus-prev');
    expect(activate).toHaveBeenLastCalledWith('b');
    unmount();
    expect(forwarded).toBeNull();
    window.removeEventListener(NEW_FOCUS_EVENT, onNew);
  });
});
