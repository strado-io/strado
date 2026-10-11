import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reposList = vi.hoisted(() => vi.fn());
const reposRemove = vi.hoisted(() => vi.fn());
const worktreesList = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({
  api: { repos: { list: reposList, remove: reposRemove, detect: vi.fn(), add: vi.fn(), clone: vi.fn(), create: vi.fn() }, worktrees: { list: worktreesList } },
}));
vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'w1', name: 'W' }, allWorkspaces: [], refresh: vi.fn(), switchTo: vi.fn() }),
}));
import { RepositoriesSection } from './RepositoriesSection';

beforeEach(() => {
  reposList.mockReset().mockResolvedValue([{ id: 'r1', name: 'Fleetx Dashboard', path: '/code/fleetx' }, { id: 'r2', name: 'Strado', path: '/code/strado' }]);
  worktreesList.mockReset().mockResolvedValue([{ path: '/code/fleetx', repoId: 'r1' }, { path: '/code/fleetx.wt/a', repoId: 'r1' }, { path: '/code/strado', repoId: 'r2' }]);
  reposRemove.mockReset().mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('RepositoriesSection', () => {
  it('lists each repo with its path and worktree count', async () => {
    render(<RepositoriesSection />);
    expect(await screen.findByText('Fleetx Dashboard')).toBeInTheDocument();
    expect(screen.getByText('/code/fleetx')).toBeInTheDocument();
    expect(screen.getByText('2 worktrees')).toBeInTheDocument();
    expect(screen.getByText('1 worktree')).toBeInTheDocument();
  });

  it('removes a repo after confirming, then reports the change', async () => {
    const onChanged = vi.fn();
    render(<RepositoriesSection onChanged={onChanged} />);
    await screen.findByText('Strado');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Strado' }));
    await waitFor(() => expect(reposRemove).toHaveBeenCalledWith('w1', 'r2'));
    expect(window.confirm).toHaveBeenCalledWith('Remove "Strado" from this workspace? Worktrees on disk are left untouched.');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('starts a new worktree in a repo', async () => {
    const onNewWorktree = vi.fn();
    render(<RepositoriesSection onNewWorktree={onNewWorktree} />);
    await screen.findByText('Strado');
    fireEvent.click(screen.getByRole('button', { name: 'New worktree in Strado' }));
    expect(onNewWorktree).toHaveBeenCalledWith('r2');
  });

  it('opens the Add repository dialog', async () => {
    render(<RepositoriesSection />);
    await screen.findByText('Strado');
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(await screen.findByRole('menu', { name: 'Add repository' })).toBeInTheDocument();
  });
});
