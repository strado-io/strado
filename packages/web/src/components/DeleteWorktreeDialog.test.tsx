// The confirm has to sit ABOVE the worktree hub. The hub's toolbar and panes are
// positioned elements, so a backdrop with no stacking layer dims the whole app
// while the panel itself renders behind the terminal — the dialog looks like it
// never opened.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobProgress } from '../hooks/jobSteps';
import type { Worktree } from '../types';

let progress: JobProgress;
vi.mock('../hooks/jobSteps', () => ({
  useJobSteps: () => progress,
}));

import { DeleteWorktreeDialog } from './DeleteWorktreeDialog';

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

beforeEach(() => {
  progress = {
    steps: [],
    currentIndex: -1,
    detail: null,
    elapsed: 0,
    done: false,
    error: null,
  };
});

const renderDialog = () => render(
  <DeleteWorktreeDialog worktree={worktree} onCancel={vi.fn()} onConfirm={vi.fn()} />,
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

  it('shows a fast background error and re-enables Cancel and Retry', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const onCancel = vi.fn();
    const onDone = vi.fn();
    const view = render(
      <DeleteWorktreeDialog
        worktree={worktree}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onDone={onDone}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();

    progress = { ...progress, error: 'could not remove worktree: fatal: directory not empty' };
    view.rerender(
      <DeleteWorktreeDialog
        worktree={worktree}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onDone={onDone}
      />,
    );

    expect(await screen.findByText(/fatal: directory not empty/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
