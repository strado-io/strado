import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dock } from './Dock';

const base = { onBrowse: vi.fn() };

describe('Dock', () => {
  it('worktree chip | command box, and nothing else (no station lights, no dev server)', () => {
    render(<Dock {...base} worktree={{ name: 'FD-1', branch: 'fix-login' }}>
      <input aria-label="Global search" />
    </Dock>);
    const dock = screen.getByTestId('dock');
    const chip = screen.getByRole('button', { name: 'Worktree: FD-1 · fix-login — switch' });
    const box = screen.getByLabelText('Global search');
    expect(dock).toContainElement(chip);
    expect(chip.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: /dev server/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /station|—.*(idle|working)/ })).not.toBeInTheDocument();
  });

  it('the chip opens the worktree list (through the box)', () => {
    const onBrowse = vi.fn();
    render(<Dock {...base} onBrowse={onBrowse} worktree={{ name: 'FD-1', branch: null }}><span /></Dock>);
    fireEvent.click(screen.getByRole('button', { name: 'Worktree: FD-1 — switch' }));
    expect(onBrowse).toHaveBeenCalled();
  });

  it('the chip names the project too: "strado-public / master"', () => {
    render(<Dock {...base} worktree={{ repo: 'strado-public', name: 'master', branch: 'master' }}><span /></Dock>);
    const chip = screen.getByRole('button', { name: 'Worktree: strado-public / master — switch' });
    expect(chip).toHaveTextContent('strado-public / master');
  });

  it('no worktree open (the board): the chip says so', () => {
    render(<Dock {...base} worktree={null}><span /></Dock>);
    expect(screen.getByRole('button', { name: 'No worktree open — switch' })).toBeInTheDocument();
  });
});
