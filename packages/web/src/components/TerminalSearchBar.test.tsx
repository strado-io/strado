import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalSearchBar, filePickerKey, searchKey, type SearchPort } from './TerminalSearchBar';

function port() {
  let cb: ((r: { index: number; count: number }) => void) | null = null;
  const p: SearchPort & { emit: (index: number, count: number) => void } = {
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clear: vi.fn(),
    onResults: (f) => { cb = f; return () => { cb = null; }; },
    emit: (index, count) => act(() => { cb?.({ index, count }); }),
  };
  return p;
}
const setup = () => {
  const p = port();
  const onClose = vi.fn();
  render(<TerminalSearchBar port={p} onClose={onClose} />);
  const input = screen.getByLabelText('Find in terminal') as HTMLInputElement;
  return { p, onClose, input };
};

describe('TerminalSearchBar', () => {
  it('opens with the input focused', () => {
    const { input } = setup();
    expect(input).toHaveFocus();
  });
  it('typing searches as you type (incremental, from the active match)', () => {
    const { p, input } = setup();
    fireEvent.change(input, { target: { value: 'error' } });
    expect(p.findNext).toHaveBeenLastCalledWith('error', expect.objectContaining({ incremental: true, caseSensitive: false }));
  });
  it('Enter = next, Shift+Enter = previous; ↓ / ↑ buttons too', () => {
    const { p, input } = setup();
    fireEvent.change(input, { target: { value: 'error' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.findNext).toHaveBeenLastCalledWith('error', expect.objectContaining({ incremental: false }));
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(p.findPrevious).toHaveBeenLastCalledWith('error', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(p.findNext).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(p.findPrevious).toHaveBeenCalledTimes(2);
  });
  it('the count reads "3/12"; none found reads "No results"; past the highlight limit "1000+"', () => {
    const { p, input } = setup();
    fireEvent.change(input, { target: { value: 'error' } });
    p.emit(2, 12);
    expect(screen.getByText('3/12')).toBeInTheDocument();
    p.emit(-1, 0);
    expect(screen.getByText('No results')).toBeInTheDocument();
    p.emit(-1, 1000);
    expect(screen.getByText('1000+')).toBeInTheDocument();
  });
  it('an empty term clears the highlights and the count', () => {
    const { p, input } = setup();
    fireEvent.change(input, { target: { value: 'x' } });
    p.emit(0, 1);
    fireEvent.change(input, { target: { value: '' } });
    expect(p.clear).toHaveBeenCalled();
    expect(screen.queryByText('1/1')).toBeNull();
  });
  it('Aa toggles case sensitivity and searches again', () => {
    const { p, input } = setup();
    fireEvent.change(input, { target: { value: 'Error' } });
    const aa = screen.getByRole('button', { name: 'Match case' });
    expect(aa).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(aa);
    expect(aa).toHaveAttribute('aria-pressed', 'true');
    expect(p.findNext).toHaveBeenLastCalledWith('Error', expect.objectContaining({ caseSensitive: true }));
  });
  it('Esc (or ✕) clears the highlights and closes', () => {
    const { p, onClose, input } = setup();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(p.clear).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('highlights all matches and the active one (decorations)', () => {
    const { p, input } = setup();
    fireEvent.change(input, { target: { value: 'x' } });
    const opts = (p.findNext as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(opts.decorations.matchBackground).toMatch(/^#[0-9a-f]{6}$/i);
    expect(opts.decorations.activeMatchBackground).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('keys inside the bar never reach the terminal or the app (stopPropagation)', () => {
    const { input } = setup();
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    fireEvent.keyDown(input, { key: 'a' });
    window.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('searchKey: ⌘F on a Mac, Ctrl+F elsewhere', () => {
  const k = (o: Partial<KeyboardEvent>) => ({ type: 'keydown', key: 'f', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent;
  it('mac', () => {
    expect(searchKey(k({ metaKey: true }), true)).toBe(true);
    expect(searchKey(k({ ctrlKey: true }), true)).toBe(false);
    expect(searchKey(k({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(searchKey(k({ metaKey: true, type: 'keyup' }), true)).toBe(false);
  });
  it('elsewhere', () => {
    expect(searchKey(k({ ctrlKey: true }), false)).toBe(true);
    expect(searchKey(k({ ctrlKey: true, key: 'F' }), false)).toBe(true);
    expect(searchKey(k({ metaKey: true }), false)).toBe(false);
    expect(searchKey(k({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });
});

describe('filePickerKey: ⌘P on a Mac, Ctrl+P elsewhere (Linux, Windows)', () => {
  const k = (o: Partial<KeyboardEvent>) => ({ type: 'keydown', key: 'p', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent;
  it('mac', () => {
    expect(filePickerKey(k({ metaKey: true }), true)).toBe(true);
    expect(filePickerKey(k({ ctrlKey: true }), true)).toBe(false);
    expect(filePickerKey(k({ metaKey: true, shiftKey: true }), true)).toBe(false);
  });
  it('elsewhere', () => {
    expect(filePickerKey(k({ ctrlKey: true }), false)).toBe(true);
    expect(filePickerKey(k({ ctrlKey: true, key: 'P' }), false)).toBe(true);
    expect(filePickerKey(k({ metaKey: true }), false)).toBe(false);
    expect(filePickerKey(k({ ctrlKey: true, type: 'keyup' }), false)).toBe(false);
  });
});
