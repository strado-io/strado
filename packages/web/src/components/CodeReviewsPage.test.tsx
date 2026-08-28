import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CodeReview, RepoConfig, Worktree } from '../types';
import { CodeReviewsPage, paginationItems, reviewTarget } from './CodeReviewsPage';

// The preview pane mounts the real MrReview, which needs a workspace and the
// provider diff endpoint.
vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'default' } }),
}));
const mergeRequestChanges = vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'list' as const, files: [] }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      worktrees: {
        mergeRequestChanges: (...args: unknown[]) => mergeRequestChanges(...args),
        mergeMergeRequest: vi.fn(),
        mergeRequestDiscussion: () => Promise.resolve({
          kind: 'discussion' as const, discussion: { description: null, comments: [] },
        }),
        mergeRequestCommits: () => Promise.resolve({ kind: 'list' as const, commits: [] }),
        commitChanges: () => Promise.resolve({ kind: 'list' as const, files: [] }),
      },
    },
  };
});

const repo = { id: 'r1', name: 'Strado', path: '/repos/strado' } as RepoConfig;
const worktree = {
  path: '/wt/STR-42', repoId: 'r1', branch: 'feature/STR-42',
  process: { status: 'idle' },
} as Worktree;

function review(overrides: Partial<CodeReview> = {}): CodeReview {
  return {
    number: 42,
    title: 'Fix reconnect handling',
    state: 'open',
    webUrl: 'https://github.com/strado-io/strado/pull/42',
    pipeline: 'running',
    approvals: null,
    sourceBranch: 'feature/STR-42',
    targetBranch: 'main',
    updatedAt: new Date().toISOString(),
    author: 'kamlesh',
    provider: 'github',
    repoId: 'r1',
    repoName: 'Strado',
    ...overrides,
  };
}

const props = {
  repositories: [{ repoId: 'r1', repoName: 'Strado', provider: 'github' as const, status: 'ok' as const }],
  counts: { open: 1, merged: 0, closed: 0 },
  state: 'open' as const,
  repoId: 'all',
  repos: [repo],
  worktrees: [worktree],
  loading: false,
  refreshing: false,
  page: 1,
  pageSize: 20,
  hasMore: false,
  error: null,
  onRefresh: vi.fn(),
  onStateChange: vi.fn(),
  onRepoChange: vi.fn(),
  onSearchChange: vi.fn(),
  onPageChange: vi.fn(),
};

describe('CodeReviewsPage', () => {
  it('shows a centered code-review icon while loading', () => {
    render(<CodeReviewsPage {...props} reviews={[]} loading />);
    expect(screen.getByRole('status', { name: 'Loading code reviews' })).toBeInTheDocument();
    expect(document.querySelector('[data-pr-icon="open"]')).toHaveClass('h-9', 'w-9');
    expect(document.querySelector('[data-loading-review-row]')).not.toBeInTheDocument();
  });

  it('shows open reviews as one uninterrupted list without section headers', () => {
    const failed = review({ number: 1, title: 'Broken checks', pipeline: 'failed' });
    const ready = review({ number: 2, title: 'Approved change', pipeline: 'success', approvals: { given: 1, required: 1 } });
    const pending = review({ number: 3, title: 'Waiting for checks', pipeline: 'running' });
    render(<CodeReviewsPage {...props} reviews={[pending, ready, failed]} />);

    expect(screen.getByText('Broken checks')).toBeInTheDocument();
    expect(screen.getByText('Approved change')).toBeInTheDocument();
    expect(screen.getByText('Waiting for checks')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows provider totals rather than the number of rows currently loaded', () => {
    render(<CodeReviewsPage
      {...props}
      reviews={[review()]}
      counts={{ open: 36, merged: 21020, closed: 977 }}
    />);
    expect(screen.getByRole('button', { name: /Open 36/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Merged 21,020/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Closed 977/i })).toBeInTheDocument();
  });

  it('keeps a compact toolbar and omits redundant page and state headings', () => {
    render(<CodeReviewsPage
      {...props}
      reviews={[review({ state: 'merged' })]}
      state="merged"
      counts={{ open: 0, merged: 1, closed: 0 }}
    />);
    expect(screen.queryByRole('heading', { name: 'Pull requests and merge requests' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Merged' })).not.toBeInTheDocument();
    // Search leads the row, then the repository picker, then Refresh.
    const search = screen.getByRole('searchbox', { name: 'Search code reviews' });
    const picker = screen.getByRole('combobox', { name: 'Filter by repository' });
    expect(search.nextElementSibling).toBe(picker);
    expect(picker.nextElementSibling).toBe(screen.getByRole('button', { name: 'Refresh' }));
  });

  it('filters by state but leaves text search to the remote provider', () => {
    const reviews = [
      review(),
      review({ number: 9, title: 'Old sidebar work', state: 'merged' }),
    ];
    const onStateChange = vi.fn();
    const { rerender } = render(<CodeReviewsPage {...props} reviews={reviews} onStateChange={onStateChange} />);
    expect(screen.getByText('Fix reconnect handling')).toBeInTheDocument();
    expect(screen.queryByText('Old sidebar work')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Merged 0/i }));
    expect(onStateChange).toHaveBeenCalledWith('merged');
    rerender(<CodeReviewsPage
      {...props}
      reviews={reviews}
      counts={{ open: 1, merged: 1, closed: 0 }}
      state="merged"
      onStateChange={onStateChange}
    />);
    expect(screen.getByText('Old sidebar work')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search code reviews' }), { target: { value: 'nothing' } });
    expect(screen.getByText('Old sidebar work')).toBeInTheDocument();
    expect(screen.queryByText(/No merged reviews match/)).not.toBeInTheDocument();
  });

  it('keeps the preview pane open, prompting for a pick until a row is clicked', async () => {
    render(<CodeReviewsPage {...props} reviews={[review()]} />);
    expect(screen.getByText('Select a review to see it here.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open PR 42/ }));

    expect(await screen.findByRole('button', { name: 'Close review' })).toBeInTheDocument();
    expect(screen.queryByText('Select a review to see it here.')).not.toBeInTheDocument();
    expect(mergeRequestChanges).toHaveBeenCalledWith('default', worktree.path, 42);
    expect(screen.getByRole('button', { name: /Open PR 42/ })).toHaveAttribute('aria-current', 'true');
  });

  it('closing the review returns the pane to the prompt', async () => {
    render(<CodeReviewsPage {...props} reviews={[review()]} />);
    fireEvent.click(screen.getByRole('button', { name: /Open PR 42/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Close review' }));
    expect(screen.getByText('Select a review to see it here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open PR 42/ })).not.toHaveAttribute('aria-current');
  });

  it('drops the preview when the state tab changes', async () => {
    const { rerender } = render(<CodeReviewsPage {...props} reviews={[review()]} />);
    fireEvent.click(screen.getByRole('button', { name: /Open PR 42/ }));
    expect(await screen.findByRole('button', { name: 'Close review' })).toBeInTheDocument();

    rerender(<CodeReviewsPage
      {...props}
      reviews={[review({ state: 'merged' })]}
      state="merged"
      counts={{ open: 0, merged: 1, closed: 0 }}
    />);
    expect(screen.getByText('Select a review to see it here.')).toBeInTheDocument();
  });

  it('hands the repository filter to the server rather than filtering rows locally', () => {
    const onRepoChange = vi.fn();
    const other = review({ number: 8, title: 'Other repo work', repoId: 'r2', repoName: 'Napp' });
    render(<CodeReviewsPage
      {...props}
      reviews={[review(), other]}
      repositories={[
        { repoId: 'r1', repoName: 'Strado', provider: 'github', status: 'ok' },
        { repoId: 'r2', repoName: 'Napp', provider: 'github', status: 'ok' },
      ]}
      onRepoChange={onRepoChange}
    />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by repository' }), { target: { value: 'r2' } });
    expect(onRepoChange).toHaveBeenCalledWith('r2');
  });

  it('pages against the picked repository totals, not the workspace list', () => {
    // Regression: a repo filter applied only to the loaded page showed "no
    // matching reviews" over that repo's full page count.
    render(<CodeReviewsPage
      {...props}
      reviews={[review({ number: 8, state: 'merged', repoId: 'r2', repoName: 'Napp' })]}
      repositories={[
        { repoId: 'r1', repoName: 'Strado', provider: 'github', status: 'ok', counts: { open: 4, merged: 21020, closed: 42 } },
        { repoId: 'r2', repoName: 'Napp', provider: 'github', status: 'ok', counts: { open: 4, merged: 806, closed: 42 } },
      ]}
      counts={{ open: 8, merged: 21826, closed: 84 }}
      repoId="r2"
      state="merged"
      hasMore
    />);
    expect(screen.getByText('Showing 1–1 of 806')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Merged 806/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page 41' })).toBeInTheDocument();
  });

  it('carries the sidebar re-open control itself when the sidebar is hidden', () => {
    const onExpandSidebar = vi.fn();
    const { rerender } = render(<CodeReviewsPage {...props} reviews={[review()]} />);
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).not.toBeInTheDocument();

    rerender(<CodeReviewsPage
      {...props}
      reviews={[review()]}
      sidebarCollapsed
      onExpandSidebar={onExpandSidebar}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    expect(onExpandSidebar).toHaveBeenCalled();
  });

  it('falls back to the repository root when no branch worktree exists', () => {
    const target = reviewTarget(review({ sourceBranch: 'fork/branch' }), [repo], [worktree]);
    expect(target).toMatchObject({ path: '/repos/strado', repoId: 'r1', branch: 'fork/branch' });
  });

  it('offers provider connection recovery per repository', () => {
    render(<CodeReviewsPage
      {...props}
      reviews={[]}
      repositories={[{ repoId: 'r1', repoName: 'Strado', provider: 'github', status: 'needsAuth' }]}
    />);
    expect(screen.getByRole('heading', { name: 'Connect GitHub to load reviews' })).toBeInTheDocument();
    expect(screen.getByText('Strado needs a connection before its reviews can be shown.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.queryByText(/Strado: connect/i)).not.toBeInTheDocument();
  });

  it('does not replace a selected repository empty state with another repository connection error', () => {
    render(<CodeReviewsPage
      {...props}
      repoId="r1"
      reviews={[]}
      repositories={[
        { repoId: 'r1', repoName: 'Strado', provider: 'github', status: 'ok', counts: { open: 0, merged: 0, closed: 0 } },
        { repoId: 'r2', repoName: 'Other', provider: 'gitlab', status: 'needsAuth' },
      ]}
    />);

    expect(screen.getByRole('heading', { name: 'No matching reviews' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Connect GitLab/ })).not.toBeInTheDocument();
  });

  it('shows a centered actionable empty state for a remote search', () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    const { unmount } = render(<CodeReviewsPage {...props} reviews={[]} onSearchChange={onSearchChange} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing review' } });
    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByRole('heading', { name: 'No matching reviews' })).toBeInTheDocument();
    expect(screen.getByText('Try a different search or repository.')).toBeInTheDocument();
    expect(document.querySelector('[data-pr-icon="open"]')).toHaveClass('h-6', 'w-6');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(onSearchChange).toHaveBeenLastCalledWith('');
    unmount();
    vi.useRealTimers();
  });

  it('shows every repository as a subtle identity chip', () => {
    render(<CodeReviewsPage {...props} reviews={[review()]} />);
    const chip = document.querySelector('[data-repo-chip="r1"]');
    expect(chip).toHaveAttribute('data-repo-chip', 'r1');
    expect(chip).toHaveClass('text-zinc-400');
  });

  it('shows 20-row numbered pagination with a last-page shortcut', () => {
    const onPageChange = vi.fn();
    const reviews = Array.from({ length: 20 }, (_, index) => review({ number: index + 1 }));
    render(<CodeReviewsPage
      {...props}
      reviews={reviews}
      counts={{ open: 21021, merged: 0, closed: 0 }}
      hasMore
      onPageChange={onPageChange}
    />);
    expect(screen.getByText('Showing 1–20 of 21,021')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Page 1052' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    expect(paginationItems(1, 1052)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 1052]);
  });

  it('offers only a provider-reachable page window and explains the boundary', () => {
    const reviews = Array.from({ length: 20 }, (_, index) => review({ number: index + 1 }));
    render(<CodeReviewsPage
      {...props}
      reviews={reviews}
      counts={{ open: 21021, merged: 0, closed: 0 }}
      hasMore
      pageLimit={5}
    />);
    // 21,021 open reviews would be 1,052 pages, but only 5 are exact.
    expect(screen.getByRole('button', { name: 'Page 5' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page 1052' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page 6' })).not.toBeInTheDocument();
    expect(screen.getByText(/combined view shows the newest 100 reviews/i)).toBeInTheDocument();
  });

  it('debounces provider-backed search', () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();
    const { unmount } = render(<CodeReviewsPage {...props} reviews={[review()]} onSearchChange={onSearchChange} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reconnect' } });
    expect(onSearchChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(onSearchChange).toHaveBeenCalledWith('reconnect');
    unmount();
    vi.useRealTimers();
  });
});
