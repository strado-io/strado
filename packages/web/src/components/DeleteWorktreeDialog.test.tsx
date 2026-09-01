// The confirm has to sit ABOVE the worktree hub. The hub's toolbar and panes are
// positioned elements, so a backdrop with no stacking layer dims the whole app
// while the panel itself renders behind the terminal — the dialog looks like it
// never opened.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteWorktreeDialog } from './DeleteWorktreeDialog';
import type { Worktree } from '../types';

const worktree: Worktree = {
  path: '/repo/wt-a',
  repoId: 'r1',
  branch: 'feature',
  head: 'abc1234',
  prunable: false,
  tracked: true,
  meta: null,
  process: {
    status: 'idle', pid: null, startedAt: null, port: null,
    detectedUrl: null, exitCode: null,
  },
};

const renderDialog = () => render(
  <DeleteWorktreeDialog worktree={worktree} onCancel={vi.fn()} onDeleted={vi.fn()} />,
);

describe('DeleteWorktreeDialog', () => {
  it('layers its backdrop above the hub', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: 'Delete worktree' });
    expect(dialog.className).toContain('fixed');
    expect(dialog.className).toContain('z-50');
  });

  it('names the worktree it is about to remove', () => {
    renderDialog();

    // The path and branch share a paragraph, so match on the container.
    expect(screen.getByRole('dialog', { name: 'Delete worktree' }))
      .toHaveTextContent('/repo/wt-a');
    expect(screen.getByText('feature')).toBeInTheDocument();
  });
});
