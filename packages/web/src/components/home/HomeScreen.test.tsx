import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Worktree } from '../../types';
import { HomeScreen } from './HomeScreen';
import { setSidebarCollapsed } from '../../lib/sidebarStore';

const recent = [
  { worktree: { path: '/wt/a' } as Worktree, name: 'master', repo: 'Fleetx Dashboard', openedAt: Date.now() - 2 * 3600_000 },
  { worktree: { path: '/wt/b' } as Worktree, name: 'FD-29', repo: 'Fleetx Napp', openedAt: Date.now() - 60_000 },
];
function setup(over: Partial<Parameters<typeof HomeScreen>[0]> = {}) {
  const on = { open: vi.fn(), all: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn(), waiting: vi.fn() };
  render(<HomeScreen bar={<input aria-label="the bar" />} recent={recent} waiting={0} onOpenRecent={on.open}
    onAddRepo={on.addRepo} onNewWorktree={on.newWorktree} onWaiting={on.waiting} {...over} />);
  return on;
}

describe('HomeScreen (Spotlight-style start)', () => {
  it('asks what you want to do, above the command box', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'What do you want to do?' })).toBeInTheDocument();
    expect(screen.getByLabelText('the bar')).toBeInTheDocument();
  });

  it('Recent: name · repo · age; one click opens it', () => {
    const on = setup();
    const list = screen.getByRole('list', { name: 'Recent' });
    expect(list).toHaveTextContent('master');
    expect(list).toHaveTextContent('Fleetx Dashboard');
    expect(list).toHaveTextContent('2h');
    fireEvent.click(screen.getByRole('button', { name: /FD-29/ }));
    expect(on.open).toHaveBeenCalledWith(recent[1]!.worktree);
  });

  it('no recent worktrees: no Recent list', () => {
    setup({ recent: [] });
    expect(screen.queryByRole('list', { name: 'Recent' })).not.toBeInTheDocument();
  });

  it('links: add repo, new worktree; no All worktrees (that page is gone)', () => {
    const on = setup();
    expect(screen.queryByRole('button', { name: /All worktrees/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(on.addRepo).toHaveBeenCalled();
    expect(on.newWorktree).toHaveBeenCalled();
  });

  it('"⚑ N waiting" only when stations need you; it opens the Line', () => {
    expect(setup().waiting).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /waiting/ })).not.toBeInTheDocument();
  });

  it('"⚑ 3 waiting" opens the Line', () => {
    const on = setup({ waiting: 3 });
    fireEvent.click(screen.getByRole('button', { name: '⚑ 3 waiting' }));
    expect(on.waiting).toHaveBeenCalled();
  });

  it('with the sidebar hidden, a button brings it back (as the Worktrees page had)', () => {
    const expand = vi.fn();
    setSidebarCollapsed(true);
    setup({ onExpandSidebar: expand });
    fireEvent.click(screen.getByLabelText('Open sidebar'));
    expect(expand).toHaveBeenCalled();
  });
});
