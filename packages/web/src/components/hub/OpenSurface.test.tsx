import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenSurface, SURFACE_KEYS, type NewSessionOption } from './OpenSurface';

const opt = (mode: string, label: string, over: Partial<NewSessionOption> = {}): NewSessionOption =>
  ({ mode, label, icon: <svg data-testid={`icon-${mode}`} />, run: vi.fn(), ...over });

function setup() {
  const options = [opt('claude', 'Claude'), opt('codex', 'Codex'), opt('opencode', 'OpenCode', { disabled: true, hint: 'OpenCode needs to be installed to use' }), opt('shell', 'Shell')];
  const onPick = vi.fn();
  const onCancel = vi.fn();
  render(<OpenSurface options={options} onPick={onPick} onCancel={onCancel} />);
  return { options, onPick, onCancel, root: screen.getByRole('menu', { name: 'Open a surface' }) };
}

describe('OpenSurface: the empty pane\'s list', () => {
  it('a titled list, a letter per kind in a kbd; it has the keyboard at once', () => {
    const { root } = setup();
    expect(root).toHaveTextContent('Open a surface');
    expect(root).toHaveFocus();
    const rows = screen.getAllByRole('menuitem');
    expect(rows.map((r) => r.getAttribute('data-label'))).toEqual(['Claude', 'Codex', 'OpenCode', 'Shell']);
    expect(rows.map((r) => r.querySelector('kbd')!.textContent)).toEqual(['C', 'X', 'O', 'T']);
  });

  it('letters are unique across every kind', () => {
    expect(new Set(Object.values(SURFACE_KEYS)).size).toBe(Object.keys(SURFACE_KEYS).length);
  });

  it('a letter picks its kind (either case); a disabled kind\'s letter does nothing', () => {
    const { root, onPick, options } = setup();
    fireEvent.keyDown(root, { key: 'x' });
    expect(onPick).toHaveBeenLastCalledWith(options[1]);
    fireEvent.keyDown(root, { key: 'O' });
    expect(onPick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(root, { key: 'd', metaKey: true });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('↑↓ skip disabled rows and ↵ picks; Esc cancels', () => {
    const { root, onPick, onCancel, options } = setup();
    expect(screen.getAllByRole('menuitem')[0]).toHaveAttribute('data-selected', 'true');
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(screen.getAllByRole('menuitem')[3]).toHaveAttribute('data-selected', 'true');
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(options[3]);
    fireEvent.keyDown(root, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('a click picks; a disabled row shows its hint and does nothing', () => {
    const { onPick, options } = setup();
    fireEvent.click(screen.getByRole('menuitem', { name: /Claude/ }));
    expect(onPick).toHaveBeenLastCalledWith(options[0]);
    const off = screen.getByRole('menuitem', { name: /OpenCode/ });
    expect(off).toBeDisabled();
    expect(off).toHaveAttribute('title', 'OpenCode needs to be installed to use');
    expect(off).toHaveTextContent('install');
    fireEvent.click(off);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
