import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorStatus } from '../../types';
import { OpenInEditorButton, resetEditorIcons } from './OpenInEditorButton';

const editors: EditorStatus[] = [
  { id: 'vscode', label: 'VS Code', available: true, lines: true },
  { id: 'vscode-insiders', label: 'VS Code Insiders', available: false, lines: true },
  { id: 'cursor', label: 'Cursor', available: true, lines: true },
  { id: 'zed', label: 'Zed', available: true, lines: true },
  { id: 'system', label: 'Finder', available: true, lines: false },
];
const cursor = editors[2]!;

beforeEach(() => {
  resetEditorIcons();
});

describe('OpenInEditorButton', () => {
  it('the icon opens with the chosen editor', () => {
    const onOpen = vi.fn();
    render(<OpenInEditorButton editors={editors} chosen={cursor} onOpen={onOpen} />);
    const main = screen.getByRole('button', { name: 'Open in Cursor' });
    expect(main).toHaveAttribute('title', 'Open in Cursor (⌘O)');
    expect(main.querySelector('img')).toHaveAttribute('src', '/api/editors/cursor/icon');
    fireEvent.click(main);
    expect(onOpen).toHaveBeenCalledWith('cursor');
  });

  it('the menu: the chosen one first with the shortcut, the other installed ones, then Finder', () => {
    const onOpen = vi.fn();
    render(<OpenInEditorButton editors={editors} chosen={cursor} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open with…' }));
    const menu = screen.getByRole('menu', { name: 'Open with' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Cursor⌘O', 'VS Code', 'Zed', 'Finder']);
    expect(items[0]).toHaveFocus();
    fireEvent.click(items[2]!);
    expect(onOpen).toHaveBeenCalledWith('zed');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open with…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Finder' }));
    expect(onOpen).toHaveBeenLastCalledWith('finder');
  });

  it('keyboard: ↓ opens it, arrows wrap, Home/End, Esc closes back to the button', () => {
    render(<OpenInEditorButton editors={editors} chosen={cursor} onOpen={() => {}} />);
    const caret = screen.getByRole('button', { name: 'Open with…' });
    fireEvent.keyDown(caret, { key: 'ArrowDown' });
    expect(caret).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem');
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(items.at(-1)).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(items.at(-1)).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(caret).toHaveFocus();
  });

  it('an icon that will not load becomes a plain glyph', () => {
    render(<OpenInEditorButton editors={editors} chosen={cursor} onOpen={() => {}} />);
    fireEvent.error(screen.getByRole('button', { name: 'Open in Cursor' }).querySelector('img')!);
    expect(screen.getByTestId('editor-glyph-cursor')).toBeInTheDocument();
  });

  it('with no editor installed, the icon shows the folder in Finder', () => {
    const onOpen = vi.fn();
    render(<OpenInEditorButton editors={editors} chosen={editors[4]!} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(onOpen).toHaveBeenCalledWith('finder');
  });
});
