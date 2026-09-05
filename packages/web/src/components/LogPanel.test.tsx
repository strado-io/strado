import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogPanel } from './LogPanel';
import type { Worktree } from '../types';

vi.mock('../api', () => ({
  api: { worktrees: { logs: vi.fn().mockResolvedValue({ lines: ['> vite', 'ready in 300ms'] }) } },
}));
vi.mock('../eventStream', () => ({ subscribeLogs: vi.fn(() => () => {}) }));
vi.mock('../hooks/useWorkspace', () => ({ useWorkspace: () => ({ workspace: { id: 'default' } }) }));

const worktree = {
  path: '/wt/FD-1',
  meta: { ticketId: 'FD-1' },
  process: { status: 'running', detectedUrl: 'http://localhost:5173' },
} as unknown as Worktree;

describe('LogPanel', () => {
  // jsdom has no scrollTo; the panel scrolls to the newest line on every update.
  beforeEach(() => { (Element.prototype as any).scrollTo = vi.fn(); });

  it('shows the tail and the served URL', async () => {
    render(<LogPanel worktree={worktree} onClose={() => {}} />);
    expect(await screen.findByText('ready in 300ms')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'http://localhost:5173' })).toBeInTheDocument();
    expect(screen.getByText('FD-1')).toBeInTheDocument();
  });

  it('stacks above the hub panes', () => {
    // The drawer is a fixed element over the hub, whose split panes are
    // positioned with z-10. Without its own z-index it painted *behind*
    // them — the header peeked out beside the sidebar, the lines never did.
    const { container } = render(<LogPanel worktree={worktree} onClose={() => {}} />);
    const drawer = container.firstElementChild!;
    expect(drawer).toHaveClass('fixed', 'bottom-0', 'z-20');
  });
});
