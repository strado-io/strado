import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFocusShortcut } from './focusShortcut';

function Harness({ move }: { move: (d: 1 | -1) => boolean | void }) {
  useFocusShortcut((d) => move(d) === true);
  return (
    <div>
      <input aria-label="field" />
      <div className="xterm"><textarea aria-label="term" /></div>
    </div>
  );
}

afterEach(() => { delete (window as any).strado; });

describe('useFocusShortcut', () => {
  it('moves on Cmd+Opt+Arrow', () => {
    const move = vi.fn();
    render(<Harness move={move} />);
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, altKey: true });
    fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true, altKey: true });
    expect(move.mock.calls).toEqual([[1], [-1]]);
  });

  it('ignores plain Cmd+Arrow and Cmd+Shift+Arrow', () => {
    const move = vi.fn();
    render(<Harness move={move} />);
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true });
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, shiftKey: true });
    expect(move).not.toHaveBeenCalled();
  });

  it('leaves text fields alone but works inside a terminal', () => {
    const move = vi.fn();
    const { getByLabelText } = render(<Harness move={move} />);
    fireEvent.keyDown(getByLabelText('field'), { key: 'ArrowRight', metaKey: true, altKey: true });
    expect(move).not.toHaveBeenCalled();
    fireEvent.keyDown(getByLabelText('term'), { key: 'ArrowRight', metaKey: true, altKey: true });
    expect(move).toHaveBeenCalledWith(1);
  });

  it('handles the desktop shell group-next / group-prev combos', () => {
    const handlers: ((c: string) => void)[] = [];
    (window as any).strado = { onHotkey: (cb: (c: string) => void) => { handlers.push(cb); return () => {}; } };
    const move = vi.fn();
    render(<Harness move={move} />);
    handlers.forEach((h) => h('group-next'));
    handlers.forEach((h) => h('group-prev'));
    expect(move.mock.calls).toEqual([[1], [-1]]);
  });

  it("leaves the chord to the browser when nothing moves (Chrome's own ⌥⌘-arrow tab switch)", () => {
    const stay = vi.fn(() => false);
    const { unmount } = render(<Harness move={stay} />);
    expect(fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, altKey: true })).toBe(true);
    expect(stay).toHaveBeenCalledWith(1);
    unmount();
    render(<Harness move={() => true} />);
    expect(fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, altKey: true })).toBe(false);
  });
});

