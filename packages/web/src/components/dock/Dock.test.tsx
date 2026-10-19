import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dock } from './Dock';

const base = {
  stations: [], worktreePath: '/wt/a', onBrowse: vi.fn(), onOpenStation: vi.fn(), onOpenLine: vi.fn(),
};

describe('Dock', () => {
  it('worktree chip | command box | lights | ▶ dev, in that order', () => {
    render(<Dock {...base} worktree={{ name: 'FD-1', branch: 'fix-login' }} dev={{ status: 'idle', port: null, error: null, onStart: vi.fn(), onStop: vi.fn(), onLogs: vi.fn() }}>
      <input aria-label="Global search" />
    </Dock>);
    const dock = screen.getByTestId('dock');
    const chip = screen.getByRole('button', { name: 'Worktree: FD-1 · fix-login — switch' });
    const box = screen.getByLabelText('Global search');
    const dev = screen.getByRole('button', { name: 'Start dev server' });
    expect(dock).toContainElement(chip);
    expect(chip.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.compareDocumentPosition(dev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the chip opens the worktree list (through the box)', () => {
    const onBrowse = vi.fn();
    render(<Dock {...base} onBrowse={onBrowse} worktree={{ name: 'FD-1', branch: null }}><span /></Dock>);
    fireEvent.click(screen.getByRole('button', { name: 'Worktree: FD-1 — switch' }));
    expect(onBrowse).toHaveBeenCalled();
  });

  it('no worktree open (the board): the chip says so, and there is no ▶ dev', () => {
    render(<Dock {...base} worktreePath={null} worktree={null}><span /></Dock>);
    expect(screen.getByRole('button', { name: 'No worktree open — switch' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dev server/ })).not.toBeInTheDocument();
  });

  it('an open panel (a station card) closes on a click outside the dock, not on one inside it', () => {
    const onClosePanel = vi.fn();
    render(<div><div data-testid="outside" /><Dock {...base} worktree={null} panel={<div data-testid="card">card</div>} onClosePanel={onClosePanel}><span /></Dock></div>);
    fireEvent.mouseDown(screen.getByTestId('card'));
    expect(onClosePanel).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(onClosePanel).toHaveBeenCalled();
  });
});
