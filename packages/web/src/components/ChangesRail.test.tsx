import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChangesRail } from './ChangesRail';
import type { MergeRequest, Worktree } from '../types';

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'default' } }),
}));

const changes = vi.fn();
const mergeRequests = vi.fn();
vi.mock('../api', () => ({
  api: {
    worktrees: {
      git: { changes: (...a: unknown[]) => changes(...a) },
      mergeRequests: (...a: unknown[]) => mergeRequests(...a),
    },
  },
}));

const wt = { path: '/wt/FD-9', branch: 'fd-9', meta: { ticketId: 'FD-9' } } as unknown as Worktree;

const openMr: MergeRequest = {
  number: 412,
  title: 'Add feature',
  state: 'open',
  webUrl: 'https://gitlab.example.com/org/repo/-/merge_requests/412',
  pipeline: 'success',
  approvals: { given: 1, required: 2 },
  sourceBranch: 'fd-9',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('ChangesRail', () => {
  beforeEach(() => {
    changes.mockClear();
    mergeRequests.mockClear();
    // Default: no GitLab MR support for this repo, unless a test overrides it.
    mergeRequests.mockResolvedValue({ kind: 'absent' });
  });

  it('renders nothing when closed', () => {
    changes.mockResolvedValue({ files: [] });
    const { container } = render(
      <ChangesRail worktree={wt} open={false} onToggle={vi.fn()} onOpenFile={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists changed files with a count and opens a file on click', async () => {
    changes.mockResolvedValue({
      files: [
        { path: 'src/app.ts', status: 'M', staged: 'none', untracked: false },
        { path: 'src/new.ts', status: 'A', staged: 'none', untracked: true },
      ],
    });
    const onOpenFile = vi.fn();
    const onReviewAll = vi.fn();
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={onOpenFile} onReviewAll={onReviewAll} />);
    await waitFor(() => expect(screen.getByText('src/app.ts')).toBeInTheDocument());
    expect(screen.getByText('Changes (2)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review all changes' }));
    expect(onReviewAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('src/app.ts'));
    expect(onOpenFile).toHaveBeenCalledWith('src/app.ts');
  });

  it('shows an empty state when there are no changes', async () => {
    changes.mockResolvedValue({ files: [] });
    const onReviewAll = vi.fn();
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} onReviewAll={onReviewAll} />);
    await waitFor(() => expect(screen.getByText(/no changes/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Open Git view' }));
    expect(onReviewAll).toHaveBeenCalledTimes(1);
  });

  it('shows an error state when the fetch fails, without crashing', async () => {
    changes.mockRejectedValue(new Error('boom'));
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/couldn.t load changes/i)).toBeInTheDocument());
  });

  it('calls onToggle from the collapse control', async () => {
    changes.mockResolvedValue({ files: [] });
    const onToggle = vi.fn();
    render(<ChangesRail worktree={wt} open onToggle={onToggle} onOpenFile={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /collapse rail/i }));
    expect(onToggle).toHaveBeenCalled();
  });

  it('refetches when refreshKey changes', async () => {
    changes.mockResolvedValue({ files: [] });
    const { rerender } = render(
      <ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} refreshKey={0} />,
    );
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(1));
    rerender(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} refreshKey={1} />);
    await waitFor(() => expect(changes).toHaveBeenCalledTimes(2));
  });

  it('hides the Merge Requests tab when the probe reports absent (not a GitLab repo)', async () => {
    changes.mockResolvedValue({ files: [] });
    mergeRequests.mockResolvedValue({ kind: 'absent' });
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} />);
    await waitFor(() => expect(mergeRequests).toHaveBeenCalled());
    expect(screen.queryByText(/MRs/)).not.toBeInTheDocument();
  });

  it('shows the Merge Requests tab with an open MR, including its number, state, and pipeline', async () => {
    changes.mockResolvedValue({ files: [] });
    mergeRequests.mockResolvedValue({ kind: 'list', mergeRequests: [openMr] });
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} />);
    const tab = await screen.findByText(/MRs/);
    fireEvent.click(tab);
    expect(screen.getByText('!412')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('shows a Connect GitLab prompt when the probe reports needsAuth', async () => {
    changes.mockResolvedValue({ files: [] });
    mergeRequests.mockResolvedValue({ kind: 'needsAuth' });
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} />);
    const tab = await screen.findByText(/MRs/);
    fireEvent.click(tab);
    expect(screen.getByRole('button', { name: 'Connect GitLab' })).toBeInTheDocument();
  });

  it('shows Connect GitHub when a github repo needs auth', async () => {
    changes.mockResolvedValue({ files: [] });
    mergeRequests.mockResolvedValue({ kind: 'needsAuth', provider: 'github' });
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} />);
    const tab = await screen.findByText(/PRs/);
    fireEvent.click(tab);
    expect(await screen.findByText(/Connect GitHub to see pull requests/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument();
  });

  it('labels the tab PRs for github lists', async () => {
    changes.mockResolvedValue({ files: [] });
    mergeRequests.mockResolvedValue({ kind: 'list', provider: 'github', mergeRequests: [] });
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} />);
    expect(await screen.findByText(/PRs/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no merge requests for this branch', async () => {
    changes.mockResolvedValue({ files: [] });
    mergeRequests.mockResolvedValue({ kind: 'list', mergeRequests: [] });
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} />);
    const tab = await screen.findByText(/MRs/);
    fireEvent.click(tab);
    await waitFor(() =>
      expect(screen.getByText('No merge requests for this branch')).toBeInTheDocument(),
    );
  });

  it('calls onOpenMr with the MR when a row is clicked', async () => {
    changes.mockResolvedValue({ files: [] });
    const clickMr: MergeRequest = { ...openMr, webUrl: 'https://gl/mr/412' };
    mergeRequests.mockResolvedValue({ kind: 'list', mergeRequests: [clickMr] });
    const onOpenMr = vi.fn();
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} onOpenMr={onOpenMr} />);
    const tab = await screen.findByText(/MRs/);
    fireEvent.click(tab);
    fireEvent.click(await screen.findByText('!412'));
    expect(onOpenMr).toHaveBeenCalledWith(clickMr);
  });

  it('dragging the left-edge handle resizes and persists the width', async () => {
    localStorage.removeItem('strado.changesRailWidth');
    changes.mockResolvedValue({ files: [] });
    render(<ChangesRail worktree={wt} open onToggle={vi.fn()} onOpenFile={vi.fn()} />);
    await screen.findByText('No changes');
    const handle = screen.getByRole('separator', { name: 'Resize changes rail' });
    expect(screen.getByRole('complementary')).toHaveStyle({ width: '256px' });
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 440, pointerId: 1 }); // leftwards = grow
    expect(screen.getByRole('complementary')).toHaveStyle({ width: '316px' });
    fireEvent.pointerUp(handle, { clientX: 440, pointerId: 1 });
    expect(localStorage.getItem('strado.changesRailWidth')).toBe('316');
  });
});
