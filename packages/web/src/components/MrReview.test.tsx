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
const mergeRequestDiscussion = vi.fn();
const postMergeRequestReview = vi.fn();
const mergeRequestCommits = vi.fn();
const commitChanges = vi.fn();
const postMergeRequestLineComment = vi.fn();
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      worktrees: {
        mergeRequestChanges: (...a: unknown[]) => mergeRequestChanges(...a),
        mergeMergeRequest: (...a: unknown[]) => mergeMergeRequest(...a),
        mergeRequestDiscussion: (...a: unknown[]) => mergeRequestDiscussion(...a),
        postMergeRequestReview: (...a: unknown[]) => postMergeRequestReview(...a),
        mergeRequestCommits: (...a: unknown[]) => mergeRequestCommits(...a),
        commitChanges: (...a: unknown[]) => commitChanges(...a),
        postMergeRequestLineComment: (...a: unknown[]) => postMergeRequestLineComment(...a),
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
    mergeRequestDiscussion.mockReset();
    mergeRequestDiscussion.mockResolvedValue({ kind: 'discussion', discussion: { description: null, comments: [] } });
    postMergeRequestReview.mockReset();
    postMergeRequestReview.mockResolvedValue({ kind: 'posted' });
    mergeRequestCommits.mockReset();
    mergeRequestCommits.mockResolvedValue({ kind: 'list', commits: [] });
    commitChanges.mockReset();
    commitChanges.mockResolvedValue({ kind: 'list', files: [] });
    postMergeRequestLineComment.mockReset();
    postMergeRequestLineComment.mockResolvedValue({ kind: 'posted' });
  });

  it('shows the centered code-review icon while the diff loads', () => {
    mergeRequestChanges.mockReturnValue(new Promise(() => {}));
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    expect(screen.getByRole('status', { name: 'Loading code review' })).toBeInTheDocument();
    expect(screen.getByText('Loading code review…')).toBeInTheDocument();
    expect(document.querySelector('[data-pr-icon="open"]')).toHaveClass('h-9', 'w-9');
  });

  it('lists changed files, shows the first diff, and switches on click', async () => {
    const files: MergeRequestChange[] = [
      { path: 'src/app.ts', status: 'M', diff: diffA },
      { path: 'src/new.ts', status: 'A', diff: diffB },
    ];
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    // The path appears twice now: in the file list and in the header above
    // the diff, so pick the list button explicitly.
    await waitFor(() => expect(screen.getByRole('button', { name: /src\/app\.ts/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /src\/new\.ts/ })).toBeInTheDocument();
    expect(screen.getByText('added line in app')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /src\/new\.ts/ }));
    await waitFor(() => expect(screen.getByText('added line in new')).toBeInTheDocument());
  });

  it('lets a long code line scroll sideways rather than clipping it', async () => {
    mergeRequestChanges.mockResolvedValue({
      kind: 'list',
      files: [{ path: 'src/app.ts', status: 'M', diff: diffA }] satisfies MergeRequestChange[],
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('added line in app')).toBeInTheDocument());
    // The widest line sets the width inside the scrolling pane; without this
    // the hunk's overflow clip swallowed everything past the pane edge.
    expect(document.querySelector('.diff-surface')).toHaveClass('w-max', 'min-w-full');
  });

  it('reads the description and comments in a Conversation tab', async () => {
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files: [] });
    mergeRequestDiscussion.mockResolvedValue({
      kind: 'discussion',
      discussion: {
        description: 'Why **this** exists',
        comments: [
          {
            id: '1', author: 'Ada', body: 'nit: rename', createdAt: new Date().toISOString(),
            path: 'src/app.ts', line: 12, kind: 'comment' as const, webUrl: null,
          },
          {
            id: '2', author: 'Lin', body: '', createdAt: new Date().toISOString(),
            path: null, line: null, kind: 'approved' as const, webUrl: null,
          },
        ],
      },
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    const tab = await screen.findByRole('button', { name: /Conversation 2/ });
    fireEvent.click(tab);

    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('this')).toBeInTheDocument();
    expect(screen.getByText('nit: rename')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts:12')).toBeInTheDocument();
    expect(screen.getByText('approved')).toBeInTheDocument();
  });

  it('renders HTML embedded in a comment instead of printing the tags', async () => {
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files: [] });
    mergeRequestDiscussion.mockResolvedValue({
      kind: 'discussion',
      discussion: {
        description: null,
        comments: [{
          id: '1', author: 'devops',
          body: '<details><summary>File walkthrough</summary>\n\n<table><tr><td>effort</td></tr></table>\n\n</details>',
          createdAt: new Date().toISOString(), path: null, line: null, kind: 'comment', webUrl: null,
        }],
      },
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));

    expect(document.querySelector('details summary')).toHaveTextContent('File walkthrough');
    expect(document.querySelector('table td')).toHaveTextContent('effort');
    expect(screen.queryByText(/<table>/)).not.toBeInTheDocument();
  });

  it('strips executable markup from a comment before rendering it', async () => {
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files: [] });
    mergeRequestDiscussion.mockResolvedValue({
      kind: 'discussion',
      discussion: {
        description: '<img src=x onerror="globalThis.__pwned = true"><script>globalThis.__pwned = true</script>ok',
        comments: [],
      },
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));

    await screen.findByText('Description');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[onerror]')).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('lists the review commits in their own tab, in provider order', async () => {
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files: [] });
    mergeRequestCommits.mockResolvedValue({
      kind: 'list',
      commits: [
        {
          sha: 'aaaaaaaabbbb', shortSha: 'aaaaaaaa', title: 'rename issuedAtWithUser to issuedTo',
          author: 'Tejasvi', createdAt: new Date().toISOString(), webUrl: 'https://gitlab/x/-/commit/aaaaaaaabbbb',
        },
        {
          sha: 'ccccccccdddd', shortSha: 'cccccccc', title: 'add regression test',
          author: 'Tejasvi', createdAt: new Date().toISOString(), webUrl: null,
        },
      ],
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Commits 2/ }));

    const titles = screen.getAllByTitle(/rename issuedAtWithUser|add regression test/);
    expect(titles.map((el) => el.textContent)).toEqual([
      'rename issuedAtWithUser to issuedTo',
      'add regression test',
    ]);
    // The row reads the commit in-app; the sha chip copies rather than leaving.
    expect(screen.getByRole('button', { name: 'View commit aaaaaaaa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy commit sha aaaaaaaa' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open aaaaaaaa in GitLab/ })).not.toBeInTheDocument();
  });

  it('opens a commit’s own diff in the pane instead of the browser', async () => {
    mergeRequestCommits.mockResolvedValue({
      kind: 'list',
      commits: [{
        sha: 'aaaaaaaabbbb', shortSha: 'aaaaaaaa', title: 'rename param',
        author: 'Tejasvi', createdAt: new Date().toISOString(), webUrl: 'https://gitlab/x/-/commit/aaaaaaaabbbb',
      }],
    });
    commitChanges.mockResolvedValue({
      kind: 'list',
      files: [{ path: 'src/only.ts', status: 'M', diff: diffA }],
    });
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Commits 1/ }));

    fireEvent.click(screen.getByRole('button', { name: 'View commit aaaaaaaa' }));

    await waitFor(() => expect(commitChanges).toHaveBeenCalledWith('default', '/wt/FD-9', 'aaaaaaaabbbb'));
    expect(await screen.findByRole('button', { name: /src\/only\.ts/ })).toBeInTheDocument();
    expect(screen.getByText('added line in app')).toBeInTheDocument();
    expect(opened).not.toHaveBeenCalled();

    // Back returns to the list rather than closing the whole review.
    fireEvent.click(screen.getByRole('button', { name: '‹ Commits' }));
    expect(screen.getByRole('button', { name: 'View commit aaaaaaaa' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('copies the full sha from the chip without opening the commit', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mergeRequestCommits.mockResolvedValue({
      kind: 'list',
      commits: [{
        sha: 'aaaaaaaabbbbccccdddd', shortSha: 'aaaaaaaa', title: 'rename param',
        author: 'Tejasvi', createdAt: new Date().toISOString(), webUrl: null,
      }],
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Commits 1/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Copy commit sha aaaaaaaa' }));

    expect(writeText).toHaveBeenCalledWith('aaaaaaaabbbbccccdddd');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    // Copying must not drill into the diff.
    expect(commitChanges).not.toHaveBeenCalled();
  });

  it('pins existing review comments to their line in the diff', async () => {
    mergeRequestChanges.mockResolvedValue({
      kind: 'list', files: [{ path: 'src/app.ts', status: 'M', diff: diffA }],
    });
    mergeRequestDiscussion.mockResolvedValue({
      kind: 'discussion',
      discussion: {
        description: null,
        anchor: { headSha: 'head1', baseSha: 'base1', startSha: 'start1' },
        comments: [{
          id: '1', author: 'Ada', body: 'this needs a guard', createdAt: new Date().toISOString(),
          path: 'src/app.ts', line: 2, side: 'new', kind: 'comment', webUrl: null,
        }],
      },
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    expect(await screen.findByText('this needs a guard')).toBeInTheDocument();
    // The comment renders inside the diff, not only in the conversation tab.
    expect(document.querySelector('.diff-surface')).toContainElement(screen.getByText('this needs a guard'));
  });

  it('posts a comment on a diff line and reloads the thread', async () => {
    mergeRequestChanges.mockResolvedValue({
      kind: 'list', files: [{ path: 'src/app.ts', status: 'M', diff: diffA }],
    });
    mergeRequestDiscussion.mockResolvedValue({
      kind: 'discussion',
      discussion: {
        description: null,
        anchor: { headSha: 'head1', baseSha: 'base1', startSha: 'start1' },
        comments: [],
      },
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    const add = await screen.findByRole('button', { name: 'Comment on line 2' });
    fireEvent.click(add);
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment on line 2' }), {
      target: { value: 'needs a guard' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => expect(postMergeRequestLineComment).toHaveBeenCalledWith(
      'default', '/wt/FD-9', 412,
      { body: 'needs a guard', path: 'src/app.ts', line: 2, side: 'new' },
    ));
    await waitFor(() => expect(mergeRequestDiscussion).toHaveBeenCalledTimes(2));
  });

  it('offers no line composer when the provider gave no anchor', async () => {
    mergeRequestChanges.mockResolvedValue({
      kind: 'list', files: [{ path: 'src/app.ts', status: 'M', diff: diffA }],
    });
    mergeRequestDiscussion.mockResolvedValue({
      kind: 'discussion', discussion: { description: null, anchor: null, comments: [] },
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    await screen.findByText('added line in app');
    expect(screen.queryByRole('button', { name: /Comment on line/ })).not.toBeInTheDocument();
  });

  it('jumps from a conversation comment to its line in the diff', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mergeRequestChanges.mockResolvedValue({
      kind: 'list', files: [{ path: 'src/app.ts', status: 'M', diff: diffA }],
    });
    mergeRequestDiscussion.mockResolvedValue({
      kind: 'discussion',
      discussion: {
        description: null,
        anchor: { headSha: 'head1', baseSha: null, startSha: null },
        comments: [{
          id: '1', author: 'Ada', body: 'guard this', createdAt: new Date().toISOString(),
          path: 'src/app.ts', line: 2, side: 'new', kind: 'comment', webUrl: null,
        }],
      },
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'src/app.ts:2' }));

    // Lands on the diff, scrolled to the commented line.
    expect(await screen.findByText('added line in app')).toBeInTheDocument();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.querySelector('[data-line-key="new:2"]')).toBeInTheDocument();
  });

  it('leaves the anchor unclickable when its file is not in the diff', async () => {
    mergeRequestChanges.mockResolvedValue({
      kind: 'list', files: [{ path: 'src/app.ts', status: 'M', diff: diffA }],
    });
    mergeRequestDiscussion.mockResolvedValue({
      kind: 'discussion',
      discussion: {
        description: null,
        anchor: null,
        comments: [{
          id: '1', author: 'Ada', body: 'old note', createdAt: new Date().toISOString(),
          path: 'src/gone.ts', line: 9, side: 'new', kind: 'comment', webUrl: null,
        }],
      },
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));

    expect(await screen.findByText('src/gone.ts:9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'src/gone.ts:9' })).not.toBeInTheDocument();
  });

  it('shows the full file path and its line counts above the diff', async () => {
    const long = 'dashboard/src/components/dashboard/rateCharts/clientRateCharts/form/AddEditClientRateChartComponent.tsx';
    mergeRequestChanges.mockResolvedValue({
      kind: 'list', files: [{ path: long, status: 'M', diff: diffA }],
    });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    // The list column truncates it; the header carries it whole.
    const header = (await screen.findAllByText(long)).find((el) => el.classList.contains('break-all'));
    expect(header).toBeDefined();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy file path' })).toBeInTheDocument();
  });

  it('orders the tabs conversation, commits, files changed', async () => {
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /Conversation/ });

    const tabs = [...document.querySelectorAll('button')]
      .map((b) => b.textContent ?? '')
      .filter((text) => /^(Conversation|Commits|Files changed)/.test(text));
    expect(tabs.map((t) => t.replace(/\d+$/, '').trim())).toEqual(['Conversation', 'Commits', 'Files changed']);
  });

  it('offers a reconnect from the conversation tab when the token lapsed', async () => {
    mergeRequestChanges.mockResolvedValue({ kind: 'list', files: [] });
    mergeRequestDiscussion.mockResolvedValue({ kind: 'needsAuth', provider: 'gitlab' });
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));
    expect(screen.getByText(/Reconnect GitLab to read this conversation/)).toBeInTheDocument();
  });

  it('posts a comment and reloads the conversation', async () => {
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Leave a comment' }), {
      target: { value: 'one nit and a question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => expect(postMergeRequestReview).toHaveBeenCalledWith(
      'default', '/wt/FD-9', 412, { body: 'one nit and a question', event: 'comment' },
    ));
    // Refetched, so a comment posted from here shows up without a manual reload.
    await waitFor(() => expect(mergeRequestDiscussion).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox', { name: 'Leave a comment' })).toHaveValue('');
  });

  it('approves with an empty body and tells the review list to refresh', async () => {
    const changed = vi.fn();
    window.addEventListener('strado:code-reviews-changed', changed);
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(postMergeRequestReview).toHaveBeenCalledWith(
      'default', '/wt/FD-9', 412, { body: '', event: 'approve' },
    ));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener('strado:code-reviews-changed', changed);
  });

  it('surfaces the provider’s own refusal instead of failing silently', async () => {
    postMergeRequestReview.mockRejectedValue(new Error('Can not approve your own pull request'));
    render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Can not approve your own pull request')).toBeInTheDocument();
  });

  it('offers request-changes on GitHub only — GitLab has no such verdict', async () => {
    const { unmount } = render(<MrReview worktree={wt} mr={mr} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));
    expect(screen.queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument();
    unmount();

    render(<MrReview worktree={wt} mr={{ ...mr, provider: 'github' }} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Conversation/ }));
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeInTheDocument();
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

  it('keeps the merge date but leaves author and raised date to the list', async () => {
    render(
      <MrReview
        worktree={wt}
        mr={{ ...mr, state: 'merged', author: 'Ravi Kumar', createdAt: '2024-01-10T00:00:00Z', mergedAt: '2024-01-12T00:00:00Z' }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Ravi Kumar')).not.toBeInTheDocument();
    expect(screen.queryByText(/raised/)).not.toBeInTheDocument();
    expect(screen.getByText(/^merged /)).toBeInTheDocument();
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
