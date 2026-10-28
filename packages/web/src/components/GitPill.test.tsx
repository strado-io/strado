import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worktree } from '../types';

const git = vi.hoisted(() => ({
  remotes: vi.fn(async () => ({ remotes: ['origin'] })),
  push: vi.fn(async () => ({ output: '' })),
  pull: vi.fn(async () => ({ output: '' })),
  branches: vi.fn(async () => ({ branches: ['main', 'origin/main', 'origin/develop', 'origin/feat'], current: 'feat' })),
  mrUrl: vi.fn(),
}));
const worktrees = vi.hoisted(() => ({
  refreshGit: vi.fn(async () => ({ branch: 'feat', dirty: false, ahead: 2, behind: 0 })),
  createMergeRequest: vi.fn(async () => ({ kind: 'created', mergeRequest: { provider: 'github', number: 7 } })),
}));
vi.mock('../api', () => ({
  api: { worktrees: { ...worktrees, git } },
  ApiClientError: class extends Error {},
}));

import { GitPill, GIT_REFRESH_EVENT, shortCount } from './GitPill';

const worktree = { path: '/wt' } as Worktree;
const pill = (over: Partial<Parameters<typeof GitPill>[0]> = {}) => {
  const props = {
    wsId: 'ws', worktree, status: { branch: 'feat', ahead: 2, behind: 0 }, additions: 1234, deletions: 5,
    active: false, onOpenChanges: vi.fn(), onOpenTree: vi.fn(), ...over,
  };
  render(<GitPill {...props} />);
  return props;
};

beforeEach(() => { vi.clearAllMocks(); });

describe('GitPill', () => {
  it('shows the branch and counts; the counts open Changes; ↑ shows only when ahead, ↓ only when behind', () => {
    const p = pill();
    const changes = screen.getByRole('button', { name: 'Changes' });
    expect(changes).toHaveTextContent('feat+1.2k−5');
    fireEvent.click(changes);
    expect(p.onOpenChanges).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Push 2 commits' })).toHaveTextContent('↑2');
    expect(screen.queryByRole('button', { name: /^Pull / })).toBeNull();
  });

  it('↑ pushes to origin, says so, and tells Changes to reload', async () => {
    const reloaded = vi.fn();
    window.addEventListener(GIT_REFRESH_EVENT, reloaded);
    pill();
    fireEvent.click(screen.getByRole('button', { name: 'Push 2 commits' }));
    await waitFor(() => expect(git.push).toHaveBeenCalledWith('ws', '/wt', 'origin'));
    expect(await screen.findByRole('status')).toHaveTextContent('Pushed feat to origin');
    expect(reloaded).toHaveBeenCalled();
    window.removeEventListener(GIT_REFRESH_EVENT, reloaded);
  });

  it('the menu: Pull from origin/<branch>, Git tree', async () => {
    const p = pill();
    fireEvent.click(screen.getByRole('button', { name: 'Git actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Pull/ }));
    await waitFor(() => expect(git.pull).toHaveBeenCalledWith('ws', '/wt', 'origin/feat'));
    fireEvent.click(screen.getByRole('button', { name: 'Git actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Git tree/ }));
    expect(p.onOpenTree).toHaveBeenCalled();
  });

  it('Create PR…: pick a branch on origin, then the dialog creates it here', async () => {
    pill();
    fireEvent.click(screen.getByRole('button', { name: 'Git actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Create PR/ }));
    const develop = await screen.findByRole('menuitem', { name: 'develop' });
    expect(screen.queryByRole('menuitem', { name: 'feat' })).toBeNull();
    fireEvent.click(develop);
    const dialog = screen.getByRole('dialog', { name: 'Create merge request' });
    expect(dialog).toHaveTextContent('feat → develop');
    fireEvent.change(screen.getByLabelText('MR title'), { target: { value: 'Add it' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    expect(worktrees.createMergeRequest).toHaveBeenCalledWith('ws', '/wt', { target: 'develop', title: 'Add it', description: undefined });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Created #7 → develop');
  });

  it('shortCount keeps the pill narrow', () => {
    expect([0, 999, 1000, 1234, 9999, 12_345].map(shortCount)).toEqual(['0', '999', '1k', '1.2k', '10k', '12k']);
  });
});
