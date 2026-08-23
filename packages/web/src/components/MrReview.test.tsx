import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MrReview } from './MrReview';
import { ApiClientError } from '../api';
import type { MergeRequest, MergeRequestChange, Worktree } from '../types';

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'default' } }),
}));

const mergeRequestChanges = vi.fn();
const mergeMergeRequest = vi.fn();
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      worktrees: {
        mergeRequestChanges: (...a: unknown[]) => mergeRequestChanges(...a),
        mergeMergeRequest: (...a: unknown[]) => mergeMergeRequest(...a),
      },
    },
  };
});

const wt = { path: '/wt/FD-9', branch: 'fd-9', meta: { ticketId: 'FD-9' } } as unknown as Worktree;

const mr: MergeRequest = {
  number: 412,
  title: 'Add feature',
  state: 'open',
  webUrl: 'https://gitlab.example.com/org/repo/-/merge_requests/412',
  pipeline: 'success',
  approvals: { given: 1, required: 2 },
  sourceBranch: 'fd-9',
  targetBranch: 'master',
  updatedAt: '2024-01-01T00:00:00Z',
};

const diffA = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  ' unchanged line',
  '+added line in app',
  '-removed line in app',
].join('\n');

const diffB = [
  'diff --git a/src/new.ts b/src/new.ts',
  '--- a/src/new.ts',
  '+++ b/src/new.ts',
  '@@ -1,1 +1,1 @@',
  '+added line in new',
].join('\n');

describe('MrReview', () => {
  beforeEach(() => {
    mergeRequestChanges.mockClear();
    mergeMergeRequest.mockReset();
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files: [] });
  });

  it('lists changed files, shows the first diff, and switches on click', async () => {
    const files: MergeRequestChange[] = [
      { path: 'src/app.ts', status: 'M', diff: diffA },
      { path: 'src/new.ts', status: 'A', diff: diffB },
    ];
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('src/app.ts')).toBeInTheDocument());
    expect(screen.getByText('src/new.ts')).toBeInTheDocument();
    expect(screen.getByText('added line in app')).toBeInTheDocument();

    fireEvent.click(screen.getByText('src/new.ts'));
    await waitFor(() => expect(screen.getByText('added line in new')).toBeInTheDocument());
  });

  it('shows source → target branches in the header', async () => {
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files: [] });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    expect(screen.getByTitle('fd-9 → master')).toBeInTheDocument();
    expect(screen.getByText('master')).toBeInTheDocument();
  });

  it('hyperlinks the MR number to the provider (replaces the Open in GitLab button)', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
      expect(screen.queryByText('Open in GitLab')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '!412' }));
      expect(open).toHaveBeenCalledWith(mr.webUrl, '_blank', 'noopener');
    } finally {
      open.mockRestore();
    }
  });

  it('shows the author and raised/merged dates when present', async () => {
    render(
      <MrReview
        worktree={wt}
        mr={{ ...mr, state: 'merged', author: 'Ravi Kumar', createdAt: '2024-01-10T00:00:00Z', mergedAt: '2024-01-12T00:00:00Z' }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Ravi Kumar')).toBeInTheDocument();
    expect(screen.getByText(/raised/)).toBeInTheDocument();
    expect(screen.getByText(/· merged/)).toBeInTheDocument();
  });

  it('omits the author/date block when the fields are absent (stale cache)', async () => {
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    expect(screen.queryByText(/raised/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^by/)).not.toBeInTheDocument();
  });

  it('omits the branch pair when targetBranch is missing (stale cache)', async () => {
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files: [] });
    render(<MrReview worktree={wt} mr={{ ...mr, targetBranch: undefined }} onClose={vi.fn()} />);
    expect(screen.queryByTitle(/→/)).not.toBeInTheDocument();
  });

  it('shows a too-large notice for a truncated file', async () => {
    const files: MergeRequestChange[] = [
      { path: 'src/big.ts', status: 'M', diff: '', truncated: true },
    ];
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/too large/i)).toBeInTheDocument());
    expect(screen.getByText('open in GitLab')).toBeInTheDocument();
  });

  it('shows a Connect GitLab prompt when the probe reports needsAuth', async () => {
    mergeRequestChanges.mockResolvedValue({ kind: 'needsAuth' });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect GitLab' })).toBeInTheDocument(),
    );
  });

  it('shows a Merge button for an open MR but not for closed/merged ones', async () => {
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument());

    render(<MrReview worktree={wt} mr={{ ...mr, state: 'closed' }} onClose={vi.fn()} />);
    render(<MrReview worktree={wt} mr={{ ...mr, state: 'merged' }} onClose={vi.fn()} />);
    expect(screen.queryAllByRole('button', { name: 'Merge' })).toHaveLength(1);
  });

  it('confirms then calls mergeMergeRequest with (wsId, path, number)', async () => {
    mergeMergeRequest.mockImplementation(() => new Promise(() => {})); // stays pending
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    const mergeBtn = await screen.findByRole('button', { name: 'Merge' });
    fireEvent.click(mergeBtn);
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm merge?' });

    fireEvent.click(confirmBtn);
    expect(mergeMergeRequest).toHaveBeenCalledWith('default', '/wt/FD-9', 412);
  });

  it('flips the header chip to merged and hides the Merge button on success', async () => {
    const merged: MergeRequest = { ...mr, state: 'merged' };
    mergeMergeRequest.mockResolvedValue({ kind: 'merged', mergeRequest: merged });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm merge?' }));

    await waitFor(() => expect(screen.getByText('merged')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm merge?' })).not.toBeInTheDocument();
  });

  it('shows the provider message on a VALIDATION rejection and returns to Merge', async () => {
    mergeMergeRequest.mockRejectedValue(new ApiClientError('VALIDATION', 'Fast-forward merge is not possible'));
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm merge?' }));

    await waitFor(() => expect(screen.getByText('Fast-forward merge is not possible')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });

  it('shows a reconnect prompt on needsAuth without a raw error, and reverts to Merge', async () => {
    mergeMergeRequest.mockResolvedValue({ kind: 'needsAuth', provider: 'gitlab' });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm merge?' }));

    await waitFor(() => expect(screen.getByText('Reconnect GitLab to merge.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Connect GitLab' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
  });

  it('shows a refresh-and-retry message on an absent result, and reverts to Merge', async () => {
    mergeMergeRequest.mockResolvedValue({ kind: 'absent' });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm merge?' }));

    await waitFor(() =>
      expect(
        screen.getByText('This worktree no longer maps to a provider — refresh and retry.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
  });

  it('does not warn (setState-on-unmounted) when the merge resolves after unmount', async () => {
    let resolveMerge: (v: { kind: 'merged'; mergeRequest: MergeRequest }) => void;
    mergeMergeRequest.mockImplementation(
      () => new Promise((resolve) => { resolveMerge = resolve; }),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount } = render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm merge?' }));

      unmount();
      await act(async () => {
        resolveMerge({ kind: 'merged', mergeRequest: { ...mr, state: 'merged' } });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('auto-reverts the confirm state to Merge after 5s if left untouched', async () => {
    vi.useFakeTimers();
    try {
      render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
      // flush the (unrelated) diff-probe microtask chain so it doesn't
      // resolve mid- or post-test outside of act().
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
      expect(screen.getByRole('button', { name: 'Confirm merge?' })).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
      expect(mergeMergeRequest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
