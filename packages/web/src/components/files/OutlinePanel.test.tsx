import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OutlineAnswer } from '../../types';
import { OutlinePanel } from './OutlinePanel';

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const ANSWER: OutlineAnswer = { server: 'typescript', symbols: [
  { name: 'Viewer', kind: 'class', line: 3, col: 1, children: [{ name: 'open', kind: 'method', line: 5, col: 3 }] },
  { name: 'helper', kind: 'func', line: 20, col: 1 },
] };

describe('OutlinePanel', () => {
  it('lists the file\'s symbols nested; a click jumps; a branch folds', async () => {
    const onPick = vi.fn();
    render(<OutlinePanel path="a.ts" load={vi.fn(async () => ANSWER)} onPick={onPick} onClose={vi.fn()} />);
    await flush();
    expect(screen.getByTestId('outline-panel')).toHaveTextContent('classViewer');
    fireEvent.click(screen.getByTitle('method open — line 5'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'open', line: 5, col: 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Fold Viewer' }));
    expect(screen.queryByTitle('method open — line 5')).toBeNull();
    expect(screen.getByRole('button', { name: 'Unfold Viewer' })).toHaveAttribute('aria-expanded', 'false');
  });
  it('no language server says so; Esc and × close; the request is cancelled on close', async () => {
    let signal!: AbortSignal;
    const onClose = vi.fn();
    const { unmount } = render(<OutlinePanel path="a.md" load={vi.fn(async (_p, s) => { signal = s; return { server: null, symbols: [] } as OutlineAnswer; })} onPick={vi.fn()} onClose={onClose} />);
    await flush();
    expect(screen.getByTestId('outline-panel')).toHaveTextContent('No language server for this file');
    fireEvent.keyDown(screen.getByTestId('outline-panel'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close outline' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
