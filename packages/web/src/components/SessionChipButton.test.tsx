import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionChipButton } from './SessionChipButton';
import type { SessionChip } from '../hooks/sessions';

function chip(over: Partial<SessionChip> = {}): SessionChip {
  return {
    path: '/w/FD-1', mode: 'codex', sessionId: '1',
    modeLabel: 'codex', label: 'FD-1', title: null, ...over,
  } as SessionChip;
}

describe('SessionChipButton', () => {
  it('opens the session on click with path, mode and id', () => {
    const onOpen = vi.fn();
    render(<SessionChipButton chip={chip()} worktreeLabel="Strado" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Strado Codex' }));
    expect(onOpen).toHaveBeenCalledWith('/w/FD-1', 'codex', '1');
  });

  it('surfaces a working status in the label, tooltip and a pulsing dot', () => {
    render(<SessionChipButton chip={chip({ codexStatus: 'working' })} worktreeLabel="Strado" onOpen={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Strado Codex (working)' });
    expect(btn).toHaveAttribute('title', 'Strado — Codex (working)');
    expect(btn.parentElement?.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('closes the session via the ✕ without opening it', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<SessionChipButton chip={chip()} worktreeLabel="Strado" onOpen={onOpen} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Strado Codex' }));
    expect(onClose).toHaveBeenCalledWith('/w/FD-1', 'codex', '1');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows no close affordance when onClose is omitted', () => {
    render(<SessionChipButton chip={chip()} worktreeLabel="Strado" onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: /Close/ })).toBeNull();
  });
});
