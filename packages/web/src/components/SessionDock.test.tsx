import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionDock } from './SessionDock';
import type { Worktree } from '../types';

function wt(path: string, opts: Partial<Worktree> = {}): Worktree {
  return { path, meta: { ticketId: path.split('/').pop() } as any, ...opts } as unknown as Worktree;
}

describe('SessionDock', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <SessionDock
        wsId="w1"
        worktrees={[wt('/wt/FD-9', { hasClaudeSession: true })]}
        onOpen={vi.fn()}
        open={false}
        onToggle={vi.fn()}
        count={1}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('when open, shows the count, session chips, and a collapse toggle', () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(
      <SessionDock
        wsId="w1"
        worktrees={[wt('/wt/FD-9', { hasClaudeSession: true })]}
        onOpen={onOpen}
        open
        onToggle={onToggle}
        count={1}
      />,
    );
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(within(screen.getByText('Sessions').parentElement!).getByText('1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /FD-9.*claude/i }));
    expect(onOpen).toHaveBeenCalledWith('/wt/FD-9', 'claude', '1');

    fireEvent.click(screen.getByLabelText('Collapse sessions'));
    expect(onToggle).toHaveBeenCalled();
  });

  it('shows the count pill and filters as you type', () => {
    render(
      <SessionDock
        wsId="w1"
        worktrees={[wt('/wt/FD-9', { hasClaudeSession: true })]}
        onOpen={vi.fn()} open onToggle={vi.fn()} count={1}
      />,
    );
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(within(screen.getByText('Sessions').parentElement!).getByText('1')).toBeInTheDocument(); // count pill
    const filter = screen.getByPlaceholderText('Filter sessions…');
    fireEvent.change(filter, { target: { value: 'nope' } });
    expect(screen.getByText('No matching sessions')).toBeInTheDocument();
  });
});
