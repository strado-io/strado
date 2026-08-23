import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunningServers } from './RunningServers';
import type { Worktree } from '../types';

const wt = (path: string, over: Partial<Worktree['process']> = {}, ticketId?: string): Worktree =>
  ({
    path,
    repoId: 'r1',
    branch: 'feat/x',
    meta: ticketId ? ({ ticketId } as Worktree['meta']) : null,
    process: {
      status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false,
      ...over,
    },
  } as Worktree);

const handlers = () => ({ onOpen: vi.fn(), onStop: vi.fn(), onKillExternal: vi.fn() });

describe('RunningServers', () => {
  it('renders nothing when no dev server is running', () => {
    const { container } = render(<RunningServers worktrees={[wt('/a'), wt('/b')]} {...handlers()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts running servers on the chip and lists them with their port', () => {
    render(
      <RunningServers
        worktrees={[
          wt('/a', { status: 'running', port: 5173 }, 'FD-1'),
          wt('/b', { status: 'starting' }, 'FD-2'),
          wt('/c'),
        ]}
        {...handlers()}
      />,
    );
    const chip = screen.getByRole('button', { name: /running dev servers/i });
    expect(chip).toHaveTextContent('2');
    fireEvent.click(chip);
    expect(screen.getByText('FD-1')).toBeInTheDocument();
    expect(screen.getByText(':5173')).toBeInTheDocument();
    // no port detected yet — say so rather than print a bare colon
    expect(screen.getByText('starting')).toBeInTheDocument();
  });

  it('opens the worktree when its row is clicked', () => {
    const h = handlers();
    const running = wt('/a', { status: 'running', port: 5173 }, 'FD-1');
    render(<RunningServers worktrees={[running]} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: /running dev servers/i }));
    fireEvent.click(screen.getByText('FD-1'));
    expect(h.onOpen).toHaveBeenCalledWith(running);
  });

  it('stops a server we started, and kills an external one', () => {
    const h = handlers();
    const ours = wt('/a', { status: 'running', port: 5173 }, 'FD-1');
    const theirs = wt('/b', { status: 'idle', external: true, pid: 4242 }, 'FD-2');
    render(<RunningServers worktrees={[ours, theirs]} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: /running dev servers/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop FD-1' }));
    expect(h.onStop).toHaveBeenCalledWith(ours);
    // An external process is not ours to stop — the row offers a kill instead.
    fireEvent.click(screen.getByRole('button', { name: 'Kill external process for FD-2' }));
    expect(h.onKillExternal).toHaveBeenCalledWith(theirs);
  });

  it('closes the list on Escape', () => {
    render(<RunningServers worktrees={[wt('/a', { status: 'running', port: 5173 }, 'FD-1')]} {...handlers()} />);
    fireEvent.click(screen.getByRole('button', { name: /running dev servers/i }));
    expect(screen.getByText('FD-1')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('FD-1')).toBeNull();
  });

  it('closes the list when the last server stops', () => {
    const running = wt('/a', { status: 'running', port: 5173 }, 'FD-1');
    const { rerender, container } = render(<RunningServers worktrees={[running]} {...handlers()} />);
    fireEvent.click(screen.getByRole('button', { name: /running dev servers/i }));
    rerender(<RunningServers worktrees={[wt('/a')]} {...handlers()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
