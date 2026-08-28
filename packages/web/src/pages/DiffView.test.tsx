import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeRequest, Worktree } from '../types';

// --- Mock the workspace hook (pattern of TerminalView.test) ---
vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'default' } }),
}));

// --- Fixtures ---
const changes = {
  files: [
    { path: 'src/a.ts', status: 'M', staged: 'none', untracked: false },
    { path: 'src/b.ts', status: 'A', staged: 'full', untracked: false },
  ],
};
const branchChanges = {
  base: 'abc123',
  baseBranch: 'main',
  files: [{ path: 'src/a.ts', status: 'M', additions: 4, deletions: 2 }],
};
const DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n';

const gitMocks = vi.hoisted(() => ({
  changes: vi.fn(),
  remotes: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  branches: vi.fn(),
  branchChanges: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  discardAll: vi.fn(),
  log: vi.fn(),
  commitInfo: vi.fn(),
  commitDiff: vi.fn(),
  diff: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  discard: vi.fn(),
  applyHunk: vi.fn(),
  discardHunk: vi.fn(),
  commit: vi.fn(),
  mrUrl: vi.fn(),
}));

const worktreeMocks = vi.hoisted(() => ({
  createMergeRequest: vi.fn(),
  mergeRequestChanges: vi.fn(),
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      worktrees: {
        git: gitMocks,
        createMergeRequest: worktreeMocks.createMergeRequest,
        mergeRequestChanges: worktreeMocks.mergeRequestChanges,
        mergeRequestDiscussion: () => Promise.resolve({
          kind: 'discussion' as const, discussion: { description: null, comments: [] },
        }),
        mergeRequestCommits: () => Promise.resolve({ kind: 'list' as const, commits: [] }),
        commitChanges: () => Promise.resolve({ kind: 'list' as const, files: [] }),
      },
    },
  };
});

import { DiffView } from './DiffView';
import { ApiClientError } from '../api';

const worktree = {
  path: '/Users/me/repo.worktrees/FD-1',
  repoId: 'r',
  branch: 'FD-1',
  head: 'abc',
  prunable: false,
  tracked: true,
  meta: {
    ticketId: 'FD-1',
    title: 'T',
    repoId: 'r',
    linkedFrom: null,
    linkedAt: null,
    port: null,
    env: {},
    lastStartedAt: null,
  },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
} as unknown as Worktree;

beforeEach(() => {
  gitMocks.changes.mockReset().mockResolvedValue(changes);
  gitMocks.branchChanges.mockReset().mockResolvedValue(branchChanges);
  gitMocks.branches.mockReset().mockResolvedValue({ branches: ['master', 'main', 'origin/master'] });
  gitMocks.remotes.mockReset().mockResolvedValue({ remotes: ['origin', 'upstream'] });
  gitMocks.push.mockReset().mockResolvedValue({ output: 'ok' });
  gitMocks.pull.mockReset().mockResolvedValue({ output: 'Already up to date.' });
  gitMocks.diff.mockReset().mockImplementation((_wsId: string, _p: string, _file: string, scope: string) =>
    Promise.resolve({ diff: scope === 'staged' ? '' : DIFF }),
  );
  gitMocks.stage.mockReset().mockResolvedValue(undefined);
  gitMocks.stageAll.mockReset().mockResolvedValue(undefined);
  gitMocks.unstageAll.mockReset().mockResolvedValue(undefined);
  gitMocks.discardAll.mockReset().mockResolvedValue(undefined);
  const LOG_COMMITS = [
    { hash: 'aaa1111', parents: ['bbb2222'], author: 'Kam B', date: '2026-07-08T10:00:00+05:30', refs: ['FD-1'], subject: 'feat: newest' },
    { hash: 'bbb2222', parents: [], author: 'Kam B', date: '2026-07-07T10:00:00+05:30', refs: ['master'], subject: 'init' },
  ];
  gitMocks.log.mockReset().mockImplementation((_w: string, _p: string, _l: number, q?: string) =>
    Promise.resolve({
      head: 'aaa1111',
      commits: q
        ? LOG_COMMITS.filter((c) => c.subject.includes(q) || c.hash.startsWith(q))
        : LOG_COMMITS,
    }),
  );
  gitMocks.commitInfo.mockReset().mockResolvedValue({
    hash: 'aaa1111',
    author: 'Kam B',
    date: '2026-07-08T10:00:00+05:30',
    message: 'feat: newest\n\nbody text',
    files: [{ path: 'src/x.ts', status: 'M' }],
  });
  gitMocks.commitDiff.mockReset().mockResolvedValue({ diff: DIFF });
  gitMocks.unstage.mockReset().mockResolvedValue(undefined);
  gitMocks.discard.mockReset().mockResolvedValue(undefined);
  gitMocks.applyHunk.mockReset().mockResolvedValue(undefined);
  gitMocks.discardHunk.mockReset().mockResolvedValue(undefined);
  gitMocks.commit.mockReset().mockResolvedValue({ head: 'def456', summary: 'ok' });
  gitMocks.mrUrl.mockReset().mockResolvedValue({ url: 'https://bitbucket.org/x/y/pull-requests/new', sourceBranch: 'FD-1' });
  worktreeMocks.createMergeRequest.mockReset();
  worktreeMocks.mergeRequestChanges.mockReset().mockResolvedValue({ kind: 'list', files: [] });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('DiffView', () => {
  it('renders file tree from git.changes and shows the first file diff sections', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    expect(await screen.findByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('b.ts')).toBeInTheDocument();
    // src/a.ts is auto-selected; its unstaged diff has a hunk → "Stage hunk" + rendered line text
    expect(await screen.findByText('Stage hunk')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
  });

  it('shows the live checked-out branch from the server, not the stale row snapshot', async () => {
    // Row snapshot says FD-1, but the user has since switched the worktree to
    // FD-99: the header must show what the branches endpoint reports.
    gitMocks.branches.mockResolvedValue({ branches: ['master', 'FD-99'], current: 'FD-99' });
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    expect(await screen.findByText('FD-99')).toBeInTheDocument();
  });

  it('groups files into Staged Changes and Changes sections', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');
    // a.ts (staged: none) → Changes section; b.ts (staged: full) → Staged section
    expect(screen.getByText(/Staged Changes \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/^Changes \(1\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Stage src/a.ts')).toBeInTheDocument();
    expect(screen.getByLabelText('Unstage src/b.ts')).toBeInTheDocument();
  });

  it('stage icon stages an unstaged file and unstage icon unstages a staged file', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');

    fireEvent.click(screen.getByLabelText('Stage src/a.ts'));
    expect(gitMocks.stage).toHaveBeenCalledWith('default', worktree.path, 'src/a.ts');
    await waitFor(() => expect(gitMocks.changes.mock.calls.length).toBeGreaterThan(1));

    fireEvent.click(screen.getByLabelText('Unstage src/b.ts'));
    expect(gitMocks.unstage).toHaveBeenCalledWith('default', worktree.path, 'src/b.ts');
    await waitFor(() => expect(gitMocks.changes.mock.calls.length).toBeGreaterThan(2));
  });

  it('Stage all stages the whole tree in one call and refreshes', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');
    fireEvent.click(screen.getByLabelText('Stage all'));
    expect(gitMocks.stageAll).toHaveBeenCalledWith('default', worktree.path);
    await waitFor(() => expect(gitMocks.changes.mock.calls.length).toBeGreaterThan(1));
  });

  it('Unstage all unstages the whole index in one call', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');
    fireEvent.click(screen.getByLabelText('Unstage all'));
    expect(gitMocks.unstageAll).toHaveBeenCalledWith('default', worktree.path);
    await waitFor(() => expect(gitMocks.changes.mock.calls.length).toBeGreaterThan(1));
  });

  it('Discard all is gated behind a confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');

    fireEvent.click(screen.getByLabelText('Discard all'));
    expect(gitMocks.discardAll).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByLabelText('Discard all'));
    expect(gitMocks.discardAll).toHaveBeenCalledWith('default', worktree.path);
    confirmSpy.mockRestore();
  });

  it('git tree button sits before Create MR and toggles the graph panel', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');
    const treeBtn = screen.getByLabelText('Git tree');
    const mrBtn = screen.getByLabelText('Create MR');
    expect(treeBtn.compareDocumentPosition(mrBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(treeBtn);
    expect(await screen.findByText('feat: newest')).toBeInTheDocument();
    expect(screen.getByText('init')).toBeInTheDocument();
    expect(screen.getByText('master')).toBeInTheDocument(); // ref pill
    expect(gitMocks.log).toHaveBeenCalledWith('default', worktree.path, 100);

    // toggling back restores the changes view
    fireEvent.click(treeBtn);
    expect(await screen.findByText('a.ts')).toBeInTheDocument();
  });

  it('tree search queries the server (full history) and shows the results', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');
    fireEvent.click(screen.getByLabelText('Git tree'));
    await screen.findByText('feat: newest');

    const search = screen.getByPlaceholderText('Search commits…');
    fireEvent.change(search, { target: { value: 'init' } });
    // debounced server search
    await waitFor(() => expect(gitMocks.log).toHaveBeenCalledWith('default', worktree.path, 100, 'init'));
    await waitFor(() => expect(screen.queryByText('feat: newest')).not.toBeInTheDocument());
    expect(screen.getByText('init')).toBeInTheDocument();

    // hash prefix matches too
    fireEvent.change(search, { target: { value: 'aaa1' } });
    await waitFor(() => expect(screen.queryByText('init')).not.toBeInTheDocument());
    expect(screen.getByText('feat: newest')).toBeInTheDocument();

    // clearing restores the full graph without a new search request
    fireEvent.change(search, { target: { value: '' } });
    expect(await screen.findByText('init')).toBeInTheDocument();
    expect(screen.getByText('feat: newest')).toBeInTheDocument();
  });

  it('selecting a commit in the tree shows details, files and the file diff', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');
    fireEvent.click(screen.getByLabelText('Git tree'));
    fireEvent.click(await screen.findByText('feat: newest'));

    expect(await screen.findByText(/body text/)).toBeInTheDocument();
    expect(gitMocks.commitInfo).toHaveBeenCalledWith('default', worktree.path, 'aaa1111');

    fireEvent.click(screen.getByText('src/x.ts'));
    expect(await screen.findByText('+new')).toBeInTheDocument();
    expect(gitMocks.commitDiff).toHaveBeenCalledWith('default', worktree.path, 'aaa1111', 'src/x.ts');
  });

  it('discard icon asks for confirmation then discards the file', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');

    fireEvent.click(screen.getByLabelText('Discard src/a.ts'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(gitMocks.discard).toHaveBeenCalledWith('default', worktree.path, 'src/a.ts'));
    confirmSpy.mockRestore();
  });

  it('discard is a no-op when the confirmation is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');

    fireEvent.click(screen.getByLabelText('Discard src/a.ts'));
    expect(gitMocks.discard).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Discard hunk confirms then posts the hunk patch to discardHunk', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    const btn = await screen.findByText('Discard hunk');
    fireEvent.click(btn);
    await waitFor(() => expect(gitMocks.discardHunk).toHaveBeenCalled());
    const [wsId, p, patch] = gitMocks.discardHunk.mock.calls[0]!;
    expect(wsId).toBe('default');
    expect(p).toBe(worktree.path);
    expect(patch).toContain('@@ -1,1 +1,1 @@');
    confirmSpy.mockRestore();
  });

  it('Stage hunk posts a patch containing the hunk header and the file header', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    const btn = await screen.findByText('Stage hunk');
    fireEvent.click(btn);
    expect(gitMocks.applyHunk).toHaveBeenCalled();
    const [wsId, p, patch, reverse] = gitMocks.applyHunk.mock.calls[0]!;
    expect(wsId).toBe('default');
    expect(p).toBe(worktree.path);
    expect(patch).toContain('--- a/src/a.ts');
    expect(patch).toContain('@@ -1,1 +1,1 @@');
    expect(reverse).toBe(false);
    await waitFor(() => expect(gitMocks.changes.mock.calls.length).toBeGreaterThan(1));
  });

  it('commit button is disabled with empty message or zero staged, enabled otherwise, and commits', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');

    const commitBtn = screen.getByRole('button', { name: 'Commit' });
    // b.ts is staged full, but message is empty → disabled
    expect(commitBtn).toBeDisabled();

    const textarea = screen.getByPlaceholderText('Commit message');
    fireEvent.change(textarea, { target: { value: 'fix things' } });
    expect(commitBtn).not.toBeDisabled();

    fireEvent.click(commitBtn);
    expect(gitMocks.commit).toHaveBeenCalledWith('default', worktree.path, 'fix things');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(''));
    // refreshes after commit
    expect(gitMocks.changes.mock.calls.length).toBeGreaterThan(1);
  });

  it('switching to "vs base" tab calls git.branchChanges and hides checkboxes/commit bar', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');

    fireEvent.click(screen.getByRole('button', { name: 'vs base' }));
    await waitFor(() => expect(gitMocks.branchChanges).toHaveBeenCalled());

    expect(screen.queryByLabelText(/^Stage /)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Commit message')).not.toBeInTheDocument();
    expect(screen.queryByText(/files staged/)).not.toBeInTheDocument();
  });

  it('searchable base dropdown filters branches and re-fetches with the chosen base', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');

    fireEvent.click(screen.getByRole('button', { name: 'vs base' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Comparison base' }));

    const search = screen.getByLabelText('Comparison base search');
    fireEvent.change(search, { target: { value: 'origin' } });
    // filtered: only origin/master remains visible
    expect(screen.queryByRole('button', { name: 'main' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'origin/master' }));

    await waitFor(() =>
      expect(gitMocks.branchChanges).toHaveBeenCalledWith(expect.anything(), worktree.path, 'origin/master'),
    );
    // popover closed after selection
    expect(screen.queryByLabelText('Comparison base search')).not.toBeInTheDocument();
  });

  it('push and pull buttons open a remote picker and call the api with the chosen remote', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    fireEvent.click(await screen.findByRole('button', { name: 'upstream' }));
    await waitFor(() => expect(gitMocks.push).toHaveBeenCalledWith('default', worktree.path, 'upstream'));
    expect(await screen.findByText(/Pushed to upstream/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
    fireEvent.click(await screen.findByRole('button', { name: 'origin/master' }));
    await waitFor(() => expect(gitMocks.pull).toHaveBeenCalledWith('default', worktree.path, 'origin/master'));
    // pull refreshes the current tab
    await waitFor(() => expect(gitMocks.changes.mock.calls.length).toBeGreaterThan(1));
  });

  it('discards a stale slow diff response after switching files (no cross-file overwrite)', async () => {
    const DIFF_A =
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+aaa-line\n';
    const DIFF_B =
      'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,1 @@\n-old\n+bbb-line\n';

    // File A (auto-selected first) resolves only when we say so; file B is fast.
    const resolveA: Array<(v: { diff: string }) => void> = [];
    gitMocks.diff.mockImplementation((_wsId: string, _p: string, file: string, scope: string) => {
      if (file === 'src/a.ts') {
        return new Promise<{ diff: string }>((res) => {
          resolveA.push(res);
        });
      }
      return Promise.resolve({ diff: scope === 'staged' ? '' : DIFF_B });
    });

    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts'); // list loaded; A's diff fetch is now pending

    // Switch to file B while A's fetch is still in flight.
    fireEvent.click(screen.getByText('b.ts'));
    expect(await screen.findByText('bbb-line')).toBeInTheDocument();

    // A's slow response lands late — it must be discarded, not overwrite B.
    resolveA.forEach((res) => res({ diff: DIFF_A }));
    await waitFor(() => expect(screen.getByText('bbb-line')).toBeInTheDocument());
    expect(screen.queryByText('aaa-line')).not.toBeInTheDocument();
  });

  it('arrow keys walk the file list in visual order (staged section first)', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');
    // Visual order: b.ts (staged) then a.ts (unstaged); a.ts is auto-selected.
    gitMocks.diff.mockClear();

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(gitMocks.diff).toHaveBeenCalledWith('default', worktree.path, 'src/b.ts', 'staged'),
    );

    gitMocks.diff.mockClear();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(gitMocks.diff).toHaveBeenCalledWith('default', worktree.path, 'src/a.ts', 'staged'),
    );

    // At the bottom, ArrowDown stays put — no refetch.
    gitMocks.diff.mockClear();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(gitMocks.diff).not.toHaveBeenCalled();
  });

  it('arrow keys inside the commit message textarea do not steal navigation', async () => {
    render(<DiffView worktree={worktree} onClose={() => {}} />);
    await screen.findByText('a.ts');
    gitMocks.diff.mockClear();
    fireEvent.keyDown(screen.getByPlaceholderText('Commit message'), { key: 'ArrowUp' });
    expect(gitMocks.diff).not.toHaveBeenCalled();
  });

  it('Esc calls onClose', async () => {
    const onClose = vi.fn();
    render(<DiffView worktree={worktree} onClose={onClose} />);
    await screen.findByText('a.ts');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  describe('in-app create-MR dialog', () => {
    // Deterministic current branch across these tests (default mock's
    // `branches` response has no `current`, so it would otherwise settle
    // to null once the branches effect resolves).
    async function openCreateMrDialog(onClose: () => void = () => {}) {
      gitMocks.branches.mockResolvedValue({ branches: ['master', 'main', 'origin/master'], current: 'FD-1' });
      render(<DiffView worktree={worktree} onClose={onClose} />);
      await screen.findByText('a.ts');
      fireEvent.click(screen.getByLabelText('Create MR'));
      fireEvent.click(await screen.findByRole('button', { name: 'master' }));
    }

    const mr: MergeRequest = {
      number: 42,
      title: 'FD-1: T',
      state: 'open',
      webUrl: 'https://github.com/acme/repo/pull/42',
      pipeline: null,
      approvals: null,
      sourceBranch: 'FD-1',
      targetBranch: 'master',
      updatedAt: '2026-07-24T00:00:00Z',
      provider: 'github',
    };

    it('picking a target opens the dialog with the prefilled title', async () => {
      await openCreateMrDialog();
      expect(screen.getByText('Create MR: FD-1 → master')).toBeInTheDocument();
      expect(screen.getByLabelText('MR title')).toHaveValue('FD-1: T');
    });

    it('successful create closes the dialog, shows the notice and an Open review button', async () => {
      worktreeMocks.createMergeRequest.mockResolvedValue({ kind: 'created', mergeRequest: mr });
      await openCreateMrDialog();

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(await screen.findByText('Created #42 → master')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open review' })).toBeInTheDocument();
      expect(screen.queryByLabelText('MR title')).not.toBeInTheDocument();
      expect(worktreeMocks.createMergeRequest).toHaveBeenCalledWith('default', worktree.path, {
        target: 'master',
        title: 'FD-1: T',
        description: undefined,
      });
    });

    it('create error (ApiClientError) renders the message inside the dialog', async () => {
      worktreeMocks.createMergeRequest.mockRejectedValue(new ApiClientError('VALIDATION', 'already exists'));
      await openCreateMrDialog();

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(await screen.findByText('already exists')).toBeInTheDocument();
      // dialog stays open
      expect(screen.getByLabelText('MR title')).toBeInTheDocument();
    });

    it('"absent" falls back to mrUrl + window.open', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      worktreeMocks.createMergeRequest.mockResolvedValue({ kind: 'absent' });
      await openCreateMrDialog();

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() =>
        expect(openSpy).toHaveBeenCalledWith(
          'https://bitbucket.org/x/y/pull-requests/new',
          '_blank',
          'noopener',
        ),
      );
      expect(gitMocks.mrUrl).toHaveBeenCalledWith('default', worktree.path, 'master');
      expect(screen.queryByLabelText('MR title')).not.toBeInTheDocument();
      openSpy.mockRestore();
    });

    it('Esc after opening the review modal closes only the review, leaving DiffView open', async () => {
      const onClose = vi.fn();
      worktreeMocks.createMergeRequest.mockResolvedValue({ kind: 'created', mergeRequest: mr });
      await openCreateMrDialog(onClose);

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Open review' }));
      expect(await screen.findByLabelText('Close review')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });

      // Review modal (top layer) is gone...
      await waitFor(() => expect(screen.queryByLabelText('Close review')).not.toBeInTheDocument());
      // ...but DiffView itself is still open underneath.
      expect(screen.getByText('a.ts')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Close (Esc)' })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('clicking the review modal backdrop closes only the review, not DiffView', async () => {
      const onClose = vi.fn();
      worktreeMocks.createMergeRequest.mockResolvedValue({ kind: 'created', mergeRequest: mr });
      await openCreateMrDialog(onClose);

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Open review' }));
      const closeReviewBtn = await screen.findByLabelText('Close review');

      // The review modal's own backdrop is the nearest ".fixed.inset-0.z-50"
      // ancestor — DiffView's backdrop (same classes) sits further out and
      // must not receive this click.
      const reviewBackdrop = closeReviewBtn.closest('.fixed.inset-0.z-50') as HTMLElement;
      fireEvent.click(reviewBackdrop);

      await waitFor(() => expect(screen.queryByLabelText('Close review')).not.toBeInTheDocument());
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText('a.ts')).toBeInTheDocument();
    });

    it('"needsAuth" shows an inline Connect prompt that fires strado:open-settings', async () => {
      worktreeMocks.createMergeRequest.mockResolvedValue({ kind: 'needsAuth', provider: 'github' });
      const eventSpy = vi.fn();
      window.addEventListener('strado:open-settings', eventSpy);
      await openCreateMrDialog();

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(await screen.findByText(/Connect GitHub first/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
      expect(eventSpy).toHaveBeenCalled();
      const evt = eventSpy.mock.calls[0]![0] as CustomEvent<{ section: string }>;
      expect(evt.detail).toEqual({ section: 'github' });
      window.removeEventListener('strado:open-settings', eventSpy);
    });
  });
});
