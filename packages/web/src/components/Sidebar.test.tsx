import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import type { RemoteWorktree, RunnerStatus } from '../api';
import type { RepoConfig, Worktree, Workspace } from '../types';
import { useMrSummaries } from '../hooks/mrSummaries';

vi.mock('../hooks/mrSummaries', () => ({
  useMrSummaries: vi.fn(() => new Map()),
}));

// The sidebar prefetches its neighbouring spaces on mount; these tests are
// about the rail, not the fetch, so the neighbour panes stay empty. The
// requests never settle on purpose — a late resolve would land after the test
// and print an act() warning.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      repos: { ...actual.api.repos, list: vi.fn(() => new Promise<never>(() => {})) },
      worktrees: { ...actual.api.worktrees, list: vi.fn(() => new Promise<never>(() => {})) },
      license: { ...actual.api.license, get: () => Promise.resolve({ required: false, apiUrl: '', license: null }) },
      profile: { ...actual.api.profile, get: () => Promise.resolve({ fullName: 'Kamlesh Bishnoi', callMe: 'Kamlesh', telemetryOptOut: false }) },
      org: { ...actual.api.org, get: () => Promise.reject(new Error('not signed in')) },
    },
  };
});

// jsdom has no layout, so the carousel would measure every pane as 0 wide.
const PANE_WIDTH = 300;
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(PANE_WIDTH);
  vi.mocked(useMrSummaries).mockReturnValue(new Map());
});
afterEach(() => { vi.restoreAllMocks(); });

/** A two-finger swipe: a run of deltas, then the decay that means "let go". */
function swipe(px: number) {
  const carousel = screen.getByTestId('space-carousel');
  for (const deltaX of [px / 2, px / 2, px / 4, px / 8]) {
    fireEvent.wheel(carousel, { deltaX, deltaY: 0 });
  }
}

const ws: Workspace ={ id: 'w1', name: 'W', color: '#333', icon: 'W', defaultEditor: 'code', defaultPortBase: 8080, logDir: null };
const repo = { id: 'r1', name: 'Repo One', path: '/r1' } as RepoConfig;
const wt = (
  path: string,
  ticketId?: string,
  status: 'idle' | 'running' = 'idle',
  diffStats: Worktree['diffStats'] = null,
): Worktree =>
  ({ path, repoId: 'r1', branch: 'feat/x', meta: ticketId ? ({ ticketId } as Worktree['meta']) : null, diffStats,
     process: { status, pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false } } as Worktree);

const ws2: Workspace = { id: 'w2', name: 'Second', color: '#444', icon: 'S', defaultEditor: 'code', defaultPortBase: 9090, logDir: null };
// Every space's pane renders the same chrome (the search box among it), so a
// query for chrome has to say which pane it means. The active space is the
// first workspace in these tests, hence pane 0.
const activePane = () => within(screen.getAllByTestId('carousel-pane')[0]!);

const ws3: Workspace ={ id: 'w3', name: 'Third', color: '#555', icon: 'T', defaultEditor: 'code', defaultPortBase: 9100, logDir: null };
const switchTo = vi.fn();

function wrap(ui: React.ReactNode, workspaces: Workspace[] = [ws, ws2]) {
  return render(
    <WorkspaceContext.Provider value={{ workspace: ws, allWorkspaces: workspaces, refresh: vi.fn(), switchTo }}>
      {ui}
    </WorkspaceContext.Provider>,
  );
}

const base = {
  repos: [repo],
  worktrees: [wt('/r1/FD-1', 'FD-1', 'running'), wt('/r1/FD-2', 'FD-2')],
  selected: { kind: 'tasks' as const },
  onSelect: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenOrgSettings: vi.fn(),
  onOpenFeedback: vi.fn(),
  taskCount: 0,
  onCollapse: vi.fn(),
  onAddRepo: vi.fn(),
  onDeleteRepo: vi.fn(),
  onOpenWorktree: vi.fn(),
  onNewWorktreeForRepo: vi.fn(),
  onWorktreeSettings: vi.fn(),
  onDeleteWorktree: vi.fn(),
  onToggleRepo: vi.fn(),
  activeWorktreePath: null,
  update: {
    phase: 'idle' as const, info: null, progress: 0, error: null,
    mode: 'swap' as const,
    onUpdate: vi.fn(), onInstall: vi.fn(), onDismiss: vi.fn(),
  },
};

describe('Sidebar tree', () => {
  it('shows Code reviews beneath Tasks with its open count', () => {
    wrap(<Sidebar {...base} reviewCount={6} expandedRepos={new Set()} />);
    expect(activePane().getByText('Code reviews')).toBeInTheDocument();
    expect(activePane().getByText('6')).toBeInTheDocument();
  });

  it('shows Usage beneath Code reviews and selects it on click', () => {
    const onSelect = vi.fn();
    wrap(<Sidebar {...base} onSelect={onSelect} expandedRepos={new Set()} />);
    const rows = activePane().getAllByRole('button').map((button) => button.textContent ?? '');
    const reviewIndex = rows.findIndex((text) => text.includes('Code reviews'));
    const usageIndex = rows.findIndex((text) => text.includes('Usage'));
    expect(usageIndex).toBe(reviewIndex + 1);

    fireEvent.click(activePane().getByText('Usage'));

    expect(onSelect).toHaveBeenCalledWith({ kind: 'usage' });
  });

  it('leaves the Usage row without a count', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set()} />);
    const usageRow = activePane().getByText('Usage').closest('button');
    expect(usageRow).toHaveTextContent(/^Usage$/);
  });

  it('shows a spinner instead of zero while code reviews are first loading', () => {
    wrap(<Sidebar {...base} reviewCount={0} reviewLoading expandedRepos={new Set()} />);
    const reviewRow = activePane().getByText('Code reviews').closest('button');
    expect(reviewRow).not.toBeNull();
    expect(reviewRow && within(reviewRow).getByRole('status', { name: 'Loading code reviews' })).toBeInTheDocument();
    expect(reviewRow).not.toHaveTextContent('0');
  });

  describe('pinned worktrees', () => {
    it('shows a hover-only pin button and places the pinned shortcut below Code reviews and above Repos', () => {
      wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);

      const pin = activePane().getByRole('button', { name: 'Pin FD-1' });
      expect(pin).toHaveClass('opacity-0', 'pointer-events-none', 'group-hover:opacity-100', 'group-hover:pointer-events-auto');
      fireEvent.click(pin);

      const pinned = activePane().getByRole('region', { name: 'Pinned worktrees' });
      expect(within(pinned).getByText('FD-1')).toBeInTheDocument();
      const reviews = activePane().getByText('Code reviews');
      const repos = activePane().getByText('Repos');
      expect(reviews.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(pinned.compareDocumentPosition(repos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps a pinned worktree visible when its repo is collapsed and opens it from the shortcut', () => {
      localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: ['local:/r1/FD-1'] }));
      const onOpenWorktree = vi.fn();
      wrap(<Sidebar {...base} onOpenWorktree={onOpenWorktree} expandedRepos={new Set()} />);

      const pinned = activePane().getByRole('region', { name: 'Pinned worktrees' });
      fireEvent.click(within(pinned).getByText('FD-1'));
      expect(onOpenWorktree).toHaveBeenCalledWith(base.worktrees[0]);
      expect(activePane().getAllByText('FD-1')).toHaveLength(1);
    });

    it('unpins from the pinned shortcut and persists pins across remounts', () => {
      const first = wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
      fireEvent.click(activePane().getByRole('button', { name: 'Pin FD-2' }));
      expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws') ?? '{}')).toEqual({
        w1: ['local:/r1/FD-2'],
      });

      first.unmount();
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      const pinned = activePane().getByRole('region', { name: 'Pinned worktrees' });
      expect(within(pinned).getByText('FD-2')).toBeInTheDocument();
      fireEvent.click(within(pinned).getByRole('button', { name: 'Unpin FD-2 from pinned' }));
      expect(activePane().queryByRole('region', { name: 'Pinned worktrees' })).toBeNull();
      expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws') ?? '{}')).toEqual({ w1: [] });
    });
  });

  it('shows the agent-working loader on the specific worktree row, not the repo row', () => {
    const working = { ...wt('/r1/FD-1', 'FD-1'), claudeStatus: 'working' as const };
    wrap(<Sidebar {...base} worktrees={[working, wt('/r1/FD-2', 'FD-2')]} expandedRepos={new Set(['r1'])} />);
    // only the working worktree row spins; the repo row no longer rolls it up
    expect(screen.getAllByRole('status', { name: 'agent working' })).toHaveLength(1);
  });

  it.each(['codexStatus', 'opencodeStatus'] as const)('shows Shell-hosted %s activity through the aggregate status', (field) => {
    const working = { ...wt('/r1/FD-1', 'FD-1'), [field]: 'working' as const };
    wrap(<Sidebar {...base} worktrees={[working]} expandedRepos={new Set(['r1'])} />);
    expect(screen.getByRole('status', { name: 'agent working' })).toBeInTheDocument();
  });

  it('shows no loader for a collapsed repo even when a worktree inside is working', () => {
    const working = { ...wt('/r1/FD-1', 'FD-1'), claudeStatus: 'working' as const };
    wrap(<Sidebar {...base} worktrees={[working]} expandedRepos={new Set()} />);
    // A collapsed repo hides its worktree rows, so there is no working hint here.
    expect(screen.queryByRole('status', { name: 'agent working' })).toBeNull();
  });

  it('shows no loader when agents are idle', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
    expect(screen.queryByRole('status', { name: 'agent working' })).toBeNull();
  });

  it('marks worktrees that own sessions and softly fills the selected row', () => {
    const withSession = { ...wt('/r1/FD-1', 'FD-1'), hasShellSession: true };
    const withoutSession = wt('/r1/FD-2', 'FD-2');
    wrap(
      <Sidebar {...base} worktrees={[withSession, withoutSession]}
        activeWorktreePath={withSession.path} expandedRepos={new Set(['r1'])} />,
    );

    expect(screen.getByTestId(`session-mark-${withSession.path}`)).toHaveClass('left-1', 'w-px', 'bg-sky-500');
    expect(screen.queryByTestId(`session-mark-${withoutSession.path}`)).toBeNull();
    const selectedRow = screen.getByText('FD-1').closest('.group');
    expect(selectedRow).toHaveClass('bg-zinc-800/80');
    expect(selectedRow).not.toHaveClass('ring-1');
  });

  it('shows worktree children with a running dot when the repo is expanded', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
    expect(screen.getByText('FD-1')).toBeInTheDocument();
    expect(screen.getByText('FD-2')).toBeInTheDocument();
    // running worktree row carries a dot (title attr marks it)
    expect(screen.getByTestId('run-dot-/r1/FD-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-dot-/r1/FD-2')).toBeNull();
  });

  it('has no Active nav item — a running dev server shows on its own worktree row', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
    expect(screen.queryByRole('button', { name: /^Active/ })).toBeNull();
    expect(screen.getByTestId('run-dot-/r1/FD-1')).toBeInTheDocument();
  });

  it('never rolls the running dot up to the repo row', () => {
    // The repo row's dot said only "something in here runs" — the worktree row
    // already says which one, and the count column carries the rest.
    wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
    const [repoRow] = screen.getAllByRole('button', { name: /Repo One/ });
    expect(repoRow!.querySelector('.bg-emerald-500')).toBeNull();
  });

  it('shows +adds −dels on a worktree row with uncommitted changes', () => {
    const dirty = wt('/r1/FD-1', 'FD-1', 'idle', { additions: 42, deletions: 7, files: 3 });
    wrap(<Sidebar {...base} worktrees={[dirty, wt('/r1/FD-2', 'FD-2')]} expandedRepos={new Set(['r1'])} />);
    const badge = screen.getByTestId('diff-/r1/FD-1');
    expect(badge).toHaveTextContent('+42');
    expect(badge).toHaveTextContent('-7');
    // a clean worktree stays quiet
    expect(screen.queryByTestId('diff-/r1/FD-2')).toBeNull();
  });

  it('shows no diff badge when the worktree has stats but nothing changed', () => {
    const clean = wt('/r1/FD-1', 'FD-1', 'idle', { additions: 0, deletions: 0, files: 0 });
    wrap(<Sidebar {...base} worktrees={[clean]} expandedRepos={new Set(['r1'])} />);
    expect(screen.queryByTestId('diff-/r1/FD-1')).toBeNull();
  });

  it('uses the PR state as the leading worktree icon and keeps checks in its hover card', () => {
    const dirty = wt('/r1/FD-1', 'FD-1', 'idle', { additions: 12, deletions: 3, files: 2 });
    const onOpenMr = vi.fn();
    const onOpenWorktree = vi.fn();
    vi.mocked(useMrSummaries).mockReturnValue(new Map([[
      dirty.path,
      {
        number: 42,
        title: 'Ship it',
        state: 'open',
        webUrl: 'https://example.test/pull/42',
        pipeline: 'success',
        approvals: null,
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        updatedAt: '2026-08-27T00:00:00Z',
        provider: 'github',
      },
    ]]));
    wrap(<Sidebar {...base} worktrees={[dirty]} expandedRepos={new Set(['r1'])}
      onOpenMr={onOpenMr} onOpenWorktree={onOpenWorktree} />);
    expect(screen.getByTestId(`diff-${dirty.path}`)).toHaveTextContent('+12-3');
    const badge = screen.getByTestId(`pr-status-${dirty.path}`);
    expect(badge).not.toHaveTextContent('PR Open');
    expect(badge).not.toHaveTextContent('✓');
    expect(badge).toHaveAccessibleName('Open PR 42, open, checks passed');
    expect(badge.querySelector('[data-pr-icon="open"]')).not.toBeNull();
    expect(badge).toHaveStyle({ color: '#3fb950' });
    const row = screen.getByText('FD-1').closest('.group')!;
    expect(row.querySelector('[data-worktree-icon="branch"]')).toBeNull();
    // The PR icon carries no tooltip of its own any more — one hover surface
    // per row, and it belongs to the row.
    fireEvent.mouseEnter(badge);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(badge);
    expect(onOpenMr).toHaveBeenCalledWith(dirty, expect.objectContaining({ number: 42 }));
    expect(onOpenWorktree).not.toHaveBeenCalled();
  });

  it('uses the same-size branch icon when a worktree has no PR', () => {
    wrap(<Sidebar {...base} worktrees={[wt('/r1/FD-1', 'FD-1')]} expandedRepos={new Set(['r1'])} />);
    const icon = screen.getByText('FD-1').closest('.group')!.querySelector('[data-worktree-icon="branch"]');
    expect(icon).toHaveAttribute('width', '14');
    expect(icon).toHaveAttribute('height', '14');
    expect(icon?.parentElement).toHaveClass('ml-5');
  });

  it('shows at most three overlapping session avatars plus a count, and lists every session on hover', () => {
    const busy = {
      ...wt('/r1/FD-1', 'FD-1', 'idle', { additions: 4, deletions: 1, files: 2 }),
      claudeSessions: ['1', '2'],
      codexSessions: ['1'],
      shellSessions: ['1', '2', '3'],
    };
    wrap(<Sidebar {...base} worktrees={[busy]} expandedRepos={new Set(['r1'])} />);

    const stack = screen.getByTestId(`session-stack-${busy.path}`);
    // Three faces plus "+3": the name keeps the width the other faces took.
    expect(stack.querySelectorAll('[data-session-avatar]')).toHaveLength(3);
    expect(stack.querySelectorAll('[data-session-avatar]')[1]).toHaveClass('-ml-1', 'h-4', 'w-4', 'ring-1');
    expect(stack.querySelector('[data-session-overflow]')).toHaveTextContent('+3');
    expect(stack).toHaveAccessibleName('6 open sessions: Claude, Claude 2, Codex, Shell, Shell 2, Shell 3');
    const diff = screen.getByTestId(`diff-${busy.path}`);
    expect(diff.compareDocumentPosition(stack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.mouseEnter(stack);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('uses the merge icon for a merged PR', () => {
    const worktree = wt('/r1/FD-1', 'FD-1');
    vi.mocked(useMrSummaries).mockReturnValue(new Map([[
      worktree.path,
      {
        number: 42,
        title: 'Shipped',
        state: 'merged',
        webUrl: 'https://example.test/pull/42',
        pipeline: 'success',
        approvals: null,
        sourceBranch: 'feat/x',
        updatedAt: '2026-08-27T00:00:00Z',
        provider: 'github',
      },
    ]]));
    wrap(<Sidebar {...base} worktrees={[worktree]} expandedRepos={new Set(['r1'])} />);
    const badge = screen.getByTestId(`pr-status-${worktree.path}`);
    expect(badge.querySelector('[data-pr-icon="merged"]')).not.toBeNull();
    expect(badge).toHaveAccessibleName('Open PR 42, merged, checks passed');
    expect(badge).toHaveStyle({ color: '#a371f7' });
  });

  it('uses the closed pull-request icon for a closed PR', () => {
    const worktree = wt('/r1/FD-1', 'FD-1');
    vi.mocked(useMrSummaries).mockReturnValue(new Map([[
      worktree.path,
      {
        number: 42,
        title: 'Closed',
        state: 'closed',
        webUrl: 'https://example.test/pull/42',
        pipeline: null,
        approvals: null,
        sourceBranch: 'feat/x',
        updatedAt: '2026-08-27T00:00:00Z',
        provider: 'github',
      },
    ]]));
    wrap(<Sidebar {...base} worktrees={[worktree]} expandedRepos={new Set(['r1'])} />);
    const badge = screen.getByTestId(`pr-status-${worktree.path}`);
    expect(badge.querySelector('[data-pr-icon="closed"]')).not.toBeNull();
    expect(badge).toHaveAccessibleName('Open PR 42, closed');
    expect(badge).toHaveStyle({ color: '#f85149' });
  });

  it('hides children when collapsed and toggles on repo click', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set()} />);
    expect(screen.queryByText('FD-1')).toBeNull();
    const [toggleButton] = screen.getAllByRole('button', { name: /Repo One/ });
    fireEvent.click(toggleButton!);
    expect(base.onToggleRepo).toHaveBeenCalledWith('r1');
  });

  it('opens a worktree on child click', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
    fireEvent.click(screen.getByText('FD-1'));
    expect(base.onOpenWorktree).toHaveBeenCalledWith(base.worktrees[0]);
  });

  it('repo ⋯ menu fires new-worktree and delete', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set()} />);
    fireEvent.click(screen.getByLabelText('Repo One actions'));
    fireEvent.click(screen.getByRole('button', { name: /^New worktree$/ }));
    expect(base.onNewWorktreeForRepo).toHaveBeenCalledWith(repo);
    fireEvent.click(screen.getByLabelText('Repo One actions'));
    fireEvent.click(screen.getByRole('button', { name: /Remove repo/ }));
    expect(base.onDeleteRepo).toHaveBeenCalledWith(repo);
  });

  it('worktree ⋯ menu fires settings and delete', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
    fireEvent.click(screen.getByLabelText('FD-1 actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(base.onWorktreeSettings).toHaveBeenCalledWith(base.worktrees[0]);
    fireEvent.click(screen.getByLabelText('FD-1 actions'));
    fireEvent.click(screen.getByRole('button', { name: /Delete worktree/ }));
    expect(base.onDeleteWorktree).toHaveBeenCalledWith(base.worktrees[0]);
  });

  it('overlays worktree actions on hover without reserving row width', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
    const actions = screen.getByLabelText('FD-1 actions');
    expect(actions).toHaveClass('inline-flex', 'opacity-0', 'group-hover:opacity-100', 'h-5', 'w-5', 'p-[3px]');
    expect(actions.parentElement).toHaveClass('absolute', 'right-1');
  });

  it('repo-row + button fires new-worktree without opening the menu', () => {
    const onNewWorktreeForRepo = vi.fn();
    const onToggleRepo = vi.fn();
    wrap(<Sidebar {...base} onNewWorktreeForRepo={onNewWorktreeForRepo} onToggleRepo={onToggleRepo} expandedRepos={new Set()} />);
    const plus = screen.getByRole('button', { name: 'New worktree in Repo One' });
    expect(plus).toHaveClass('inline-flex');
    expect(plus).not.toHaveClass('hidden');
    expect(screen.getByLabelText('Repo One actions')).not.toHaveClass('invisible');
    const repoRow = screen.getByText('Repo One').closest('button')!;
    expect(within(repoRow).queryByText('2')).toBeNull();
    fireEvent.click(plus);
    expect(onNewWorktreeForRepo).toHaveBeenCalledWith(repo);
    expect(onToggleRepo).not.toHaveBeenCalled();
  });

  it('has no bottom New worktree button', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set()} />);
    expect(screen.queryByRole('button', { name: /^New worktree$/ })).toBeNull();
  });

  describe('large repos (> 7 worktrees)', () => {
    const many = Array.from({ length: 10 }, (_, i) => wt(`/r1/FD-${i}`, `FD-${i}`));
    const bigBase = { ...base, worktrees: many };

    it('shows every worktree without Show-more or Show-less controls', () => {
      wrap(<Sidebar {...bigBase} expandedRepos={new Set(['r1'])} />);
      expect(screen.getByText('FD-0')).toBeInTheDocument();
      expect(screen.getByText('FD-6')).toBeInTheDocument();
      expect(screen.getByText('FD-7')).toBeInTheDocument();
      expect(screen.getByText('FD-9')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Show less/ })).toBeNull();
    });

  });

  describe('resizable width', () => {
    beforeEach(() => localStorage.removeItem('strado.sidebarWidth'));

    it('restores the persisted width', () => {
      localStorage.setItem('strado.sidebarWidth', '340');
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      expect(screen.getByRole('complementary')).toHaveStyle({ width: '340px' });
    });

    it('clamps an out-of-range persisted width and defaults when unset', () => {
      localStorage.setItem('strado.sidebarWidth', '9999');
      const { unmount } = wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      expect(screen.getByRole('complementary')).toHaveStyle({ width: '480px' });
      unmount();
      localStorage.removeItem('strado.sidebarWidth');
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      expect(screen.getByRole('complementary')).toHaveStyle({ width: '288px' });
    });

    it('dragging the handle resizes live and persists on release', () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      const handle = screen.getByRole('separator', { name: 'Resize sidebar' });
      fireEvent.pointerDown(handle, { clientX: 288, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 348, pointerId: 1 });
      expect(screen.getByRole('complementary')).toHaveStyle({ width: '348px' });
      fireEvent.pointerUp(handle, { clientX: 348, pointerId: 1 });
      expect(localStorage.getItem('strado.sidebarWidth')).toBe('348');
    });
  });
  describe('runner worktrees', () => {
    const remote = (over: Partial<RemoteWorktree> = {}): RemoteWorktree => ({
      runnerId: 'runner-dev-wq3p',
      runnerName: 'runner-dev',
      wsBase: 'wss://runner-dev-wq3p.r.strado.io',
      remoteWsId: 'default',
      path: '/home/strado/demo-repo.worktrees/FD-9',
      name: 'FD-9',
      branch: 'FD-9',
      head: 'abc',
      remoteRepoId: 'demo-repo',
      isRepoRoot: false,
      cloneUrl: 'https://github.com/o/r.git',
      localRepoId: 'r1',
      remoteRepoName: 'demo-repo',
      ...over,
    });
    const statuses = (online: boolean): RunnerStatus[] => [
      { runnerId: 'runner-dev-wq3p', name: 'runner-dev', online, error: null },
    ];

    it('gives a runner worktree the same hover card, named with its machine', () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const onOpenRemoteWorktree = vi.fn();
      const w = remote({ hasShellSession: true, shellSessions: ['1'] } as Partial<RemoteWorktree>);
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])} remoteWorktrees={[w]}
          runnerStatuses={statuses(true)} onOpenRemoteWorktree={onOpenRemoteWorktree} />,
      );
      const row = within(screen.getByRole('complementary')).getByText('FD-9').closest('.group')!;
      fireEvent.pointerEnter(row);
      act(() => { vi.advanceTimersByTime(250); });

      const card = screen.getByRole('dialog');
      expect(card).toHaveTextContent('on runner-dev');
      // No per-session deep link exists for a remote worktree, so a session
      // click opens the worktree itself rather than pretending otherwise.
      fireEvent.click(within(card).getByRole('button', { name: /Shell/ }));
      expect(onOpenRemoteWorktree).toHaveBeenCalledWith(w);
      vi.useRealTimers();
    });

    it('lists a runner worktree under the repo it belongs to, badged with the machine', () => {
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])}
          remoteWorktrees={[remote()]} runnerStatuses={statuses(true)} />,
      );
      expect(screen.getByText('FD-9')).toBeInTheDocument();
      // The compact machine glyph still exposes where the worktree runs.
      expect(screen.getByRole('img', { name: 'runner-dev runner' })).toHaveClass('h-3.5', 'w-3.5');
      expect(screen.queryByText('runner-dev')).toBeNull();
    });

    it('keeps an offline runner’s rows visible and marked, never hidden', () => {
      // A row that vanishes reads as data loss. The worktree is fine; the
      // machine is just unreachable.
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])}
          remoteWorktrees={[remote()]} runnerStatuses={statuses(false)} />,
      );
      expect(screen.getByText('FD-9')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'runner-dev runner, offline' })).toHaveClass('text-red-400/70');
      expect(screen.queryByText('runner-dev · offline')).toBeNull();
    });

    it('groups unmatched runner worktrees under a repo folder, never a bottom bucket', () => {
      // The old flat "Only on runners" section at the sidebar's bottom made
      // the same rows jump around between spaces — everything lives in the
      // repos list now, under a folder named for the remote repo.
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])}
          remoteWorktrees={[remote({ localRepoId: null, name: 'orphan', branch: 'orphan' })]}
          runnerStatuses={statuses(true)} />,
      );
      expect(screen.queryByText('Only on runners')).toBeNull();
      expect(screen.getByText('demo-repo')).toBeInTheDocument();
      expect(screen.getByText('orphan')).toBeInTheDocument();
    });

    it('shows a loading hint while the runner list is still being fetched', () => {
      wrap(
        <Sidebar {...base} expandedRepos={new Set()} remoteLoading
          remoteWorktrees={[]} runnerStatuses={[]} />,
      );
      expect(activePane().getByText('Checking runners…')).toBeInTheDocument();
    });

    it('drops the loading hint once the runner list has arrived', () => {
      wrap(
        <Sidebar {...base} expandedRepos={new Set()}
          remoteWorktrees={[]} runnerStatuses={[]} />,
      );
      expect(screen.queryByText('Checking runners…')).toBeNull();
    });

    it('surfaces a reachable runner whose API failed, rather than implying it has none', () => {
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])} remoteWorktrees={[]}
          runnerStatuses={[{ runnerId: 'x', name: 'runner-dev', online: true, error: 'timed out' }]} />,
      );
      expect(screen.getByText(/runner-dev: timed out/)).toBeInTheDocument();
    });

    it('opens the runner worktree on click', () => {
      const onOpen = vi.fn();
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])} remoteWorktrees={[remote()]}
          runnerStatuses={statuses(true)} onOpenRemoteWorktree={onOpen} />,
      );
      fireEvent.click(screen.getByText('FD-9'));
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/strado/demo-repo.worktrees/FD-9' }));
    });

    it('pins a runner worktree into the same workspace-level pinned section', () => {
      const w = remote();
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])} remoteWorktrees={[w]}
          runnerStatuses={statuses(true)} />,
      );
      fireEvent.click(activePane().getByRole('button', { name: 'Pin FD-9 on runner-dev' }));

      const pinned = activePane().getByRole('region', { name: 'Pinned worktrees' });
      expect(within(pinned).getByText('FD-9')).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws') ?? '{}')).toEqual({
        w1: [`remote:${w.runnerId}:${w.path}`],
      });
    });

    it('offers delete on a runner worktree, and never on a repo root', () => {
      const onDelete = vi.fn();
      const { unmount } = wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])} remoteWorktrees={[remote()]}
          runnerStatuses={statuses(true)} onDeleteRemoteWorktree={onDelete} />,
      );
      const actions = screen.getByLabelText('FD-9 on runner-dev actions');
      expect(actions).toHaveClass('h-5', 'w-5', 'p-[3px]');
      fireEvent.click(actions);
      fireEvent.click(screen.getByText('Delete worktree'));
      expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/strado/demo-repo.worktrees/FD-9' }));
      unmount();

      // A repo's main working tree isn't removable as a worktree — the delete
      // route refuses it — so offering the action would be a dead end.
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])}
          remoteWorktrees={[remote({ isRepoRoot: true, name: 'main', branch: 'main' })]}
          runnerStatuses={statuses(true)} onDeleteRemoteWorktree={onDelete} />,
      );
      expect(screen.queryByLabelText('main on runner-dev actions')).toBeNull();
      expect(screen.getByRole('button', { name: 'Pin main on runner-dev' }).parentElement).toHaveClass('absolute', 'right-1');
    });
  });

  describe('Sidebar space rail', () => {
    beforeEach(() => { switchTo.mockClear(); });

    it('shows the active workspace in a header picker', () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      expect(screen.getByTestId('space-name')).toHaveTextContent('W');
      expect(screen.getByRole('button', { name: 'Switch workspace, current: W' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('button', { name: 'Space actions' })).toBeNull();
    });

    it('switches workspaces from the header picker', () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />, [ws, ws2, ws3]);
      fireEvent.click(screen.getByRole('button', { name: 'Switch workspace, current: W' }));
      expect(screen.getByRole('menu', { name: 'Workspaces' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Third' }));
      expect(switchTo).toHaveBeenCalledWith('w3');
      expect(screen.queryByRole('menu', { name: 'Workspaces' })).toBeNull();
    });

    it('renders a dot per space without a second settings menu', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      expect(screen.getByRole('button', { name: 'Switch to W' })).toHaveAttribute('aria-current', 'true');
      expect(screen.getByRole('button', { name: 'Switch to Second' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Space actions' })).toBeNull();
      expect(await screen.findByRole('button', { name: 'Account: Kamlesh' })).toBeInTheDocument();
    });

    it('switches workspace when a dot with no pane of its own is clicked', () => {
      // ws3 is two spaces away: there is no pane to slide, so it switches
      // straight over instead of animating.
      wrap(<Sidebar {...base} expandedRepos={new Set()} />, [ws, ws2, ws3]);
      fireEvent.click(screen.getByRole('button', { name: 'Switch to Third' }));
      expect(switchTo).toHaveBeenCalledWith('w3');
    });

    it('animates rather than jumping when the neighbouring dot is clicked', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch to Second' }));
      expect(switchTo).not.toHaveBeenCalled(); // the landing commits, not the click
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
    });
  });

  describe('Sidebar carousel', () => {
    beforeEach(() => { switchTo.mockClear(); });

    it('renders one pane per space with the active space centred', () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      const panes = screen.getAllByTestId('carousel-pane');
      expect(panes).toHaveLength(2); // active ws, then its next neighbour ws2
      expect(panes[0]).not.toHaveAttribute('aria-hidden');
      expect(panes[1]).toHaveAttribute('aria-hidden', 'true');
    });

    it('switches workspace when a swipe lands on a neighbour', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      swipe(PANE_WIDTH * 0.6);
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
    });

    it('stays put when the swipe is only a twitch', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      swipe(10); // ~14px in total — sideways noise during a vertical scroll
      await new Promise((r) => setTimeout(r, 400));
      expect(switchTo).not.toHaveBeenCalled();
    });

    it('moves to the next space on Cmd+Shift+ArrowRight', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, shiftKey: true });
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
    });

    it('ignores Cmd+Shift+ArrowLeft at the first space', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true, shiftKey: true });
      await new Promise((r) => setTimeout(r, 400));
      expect(switchTo).not.toHaveBeenCalled();
    });

    it('leaves plain Cmd+ArrowRight alone — that chord belongs to the tabs', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true });
      await new Promise((r) => setTimeout(r, 400));
      expect(switchTo).not.toHaveBeenCalled();
    });

    it('moves between spaces from inside a terminal', async () => {
      // xterm takes its keys through a hidden <textarea> inside .xterm, so a
      // tagName guard would kill this chord in the surface the app is mostly
      // used through — which is the one place users will try it.
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      const term = document.createElement('div');
      term.className = 'xterm';
      const helper = document.createElement('textarea');
      helper.className = 'xterm-helper-textarea';
      term.appendChild(helper);
      document.body.appendChild(term);
      try {
        helper.focus();
        fireEvent.keyDown(helper, { key: 'ArrowRight', metaKey: true, shiftKey: true });
        await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
      } finally {
        term.remove();
      }
    });

    it('leaves Cmd+Shift+Arrow alone in a plain text field', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      const input = document.createElement('input');
      document.body.appendChild(input);
      try {
        input.focus();
        fireEvent.keyDown(input, { key: 'ArrowRight', metaKey: true, shiftKey: true });
        await new Promise((r) => setTimeout(r, 400));
        expect(switchTo).not.toHaveBeenCalled();
      } finally {
        input.remove();
      }
    });

    it('responds to the space-next hotkey forwarded from an embed', async () => {
      const handlers: ((combo: string) => void)[] = [];
      (window as unknown as { strado: unknown }).strado = {
        onHotkey: (cb: (combo: string) => void) => { handlers.push(cb); return () => {}; },
      };
      try {
        wrap(<Sidebar {...base} expandedRepos={new Set()} />);
        handlers.forEach((h) => h('space-next'));
        await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
      } finally {
        delete (window as unknown as { strado?: unknown }).strado;
      }
    });

    it('puts the track back and reports it when the switch fails', async () => {
      // Without this the sidebar is parked on a pane that is inert and
      // aria-hidden: search box, repo rows, every + button dead, nothing said,
      // and swiping back re-commits the same space. Only a reload recovers.
      switchTo.mockRejectedValueOnce(new Error('server is restarting'));
      const onSwitchError = vi.fn();
      wrap(<Sidebar {...base} expandedRepos={new Set()} onSwitchError={onSwitchError} />);
      swipe(PANE_WIDTH * 0.6);
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
      await waitFor(() =>
        expect(onSwitchError).toHaveBeenCalledWith(expect.stringContaining('server is restarting')),
      );
      // Seat 0: the active space is the first of the two panes here.
      expect(screen.getByTestId('carousel-track').style.transform).toBe('translate3d(0px, 0, 0)');
    });

    it('renders a single pane and no dots for a lone workspace', () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />, [ws]);
      expect(screen.getAllByTestId('carousel-pane')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Switch to W' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Space actions' })).toBeNull();
    });
  });

  describe('action menus', () => {
    // The carousel track carries a transform (translate3d + will-change), which
    // makes it the containing block for position:fixed descendants: a popover
    // rendered inside a pane lands shifted by the track's offset and clipped by
    // the carousel's overflow-hidden — invisible on any space but the first.
    // The popover and its backdrop must therefore portal to document.body.
    it('portals the kebab popover out of the transformed carousel track', () => {
      wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
      fireEvent.click(activePane().getByRole('button', { name: 'Repo One actions' }));
      const track = screen.getByTestId('carousel-track');
      expect(track.contains(screen.getByRole('button', { name: 'Remove repo' }))).toBe(false);
      expect(track.contains(document.querySelector('.fixed.inset-0.z-40'))).toBe(false);
    });
  });
});

describe('worktree hover card', () => {
  const busy = (): Worktree => ({
    ...wt('/r1/FD-1', 'FD-1', 'running', { additions: 12, deletions: 3, files: 2 }),
    claudeSessions: ['1', '2'],
    shellSessions: ['1'],
    claudeStatusById: { '2': 'working' },
  } as Worktree);

  const pr = {
    number: 42,
    title: 'Ship it',
    state: 'open' as const,
    webUrl: 'https://example.test/pull/42',
    pipeline: 'success' as const,
    approvals: null,
    sourceBranch: 'feat/x',
    targetBranch: 'main',
    updatedAt: '2026-08-27T00:00:00Z',
    provider: 'github' as const,
  };

  function rowFor(label: string) {
    // The card repeats the worktree label, and it renders outside the rail —
    // scope to the rail so "the row" never resolves to the card's own header.
    return within(screen.getByRole('complementary')).getByText(label).closest('.group')!;
  }

  function hoverRow(label = 'FD-1') {
    const row = rowFor(label);
    fireEvent.pointerEnter(row);
    act(() => { vi.advanceTimersByTime(250); });
    return row;
  }

  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens one card for the row carrying both the PR and every session', () => {
    const worktree = busy();
    vi.mocked(useMrSummaries).mockReturnValue(new Map([[worktree.path, pr]]));
    wrap(<Sidebar {...base} worktrees={[worktree]} expandedRepos={new Set(['r1'])} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    hoverRow();

    const card = screen.getByRole('dialog');
    expect(card).toHaveTextContent('#42');
    expect(card).toHaveTextContent('Ship it');
    expect(within(card).getByRole('button', { name: /Claude 2/ })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /Shell/ })).toBeInTheDocument();
  });

  it('does not open while the cursor is only passing over the row', () => {
    wrap(<Sidebar {...base} worktrees={[busy()]} expandedRepos={new Set(['r1'])} />);
    const row = screen.getByText('FD-1').closest('.group')!;
    fireEvent.pointerEnter(row);
    act(() => { vi.advanceTimersByTime(120); });
    fireEvent.pointerLeave(row);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('jumps straight into the session that was clicked', () => {
    const worktree = busy();
    const onOpenWorktree = vi.fn();
    wrap(<Sidebar {...base} worktrees={[worktree]} onOpenWorktree={onOpenWorktree}
      expandedRepos={new Set(['r1'])} />);
    hoverRow();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Claude 2/ }));
    expect(onOpenWorktree).toHaveBeenCalledWith(worktree, 'claude', '2');
  });

  it('opens the review from the card', () => {
    const worktree = busy();
    const onOpenMr = vi.fn();
    vi.mocked(useMrSummaries).mockReturnValue(new Map([[worktree.path, pr]]));
    wrap(<Sidebar {...base} worktrees={[worktree]} onOpenMr={onOpenMr} expandedRepos={new Set(['r1'])} />);
    hoverRow();
    fireEvent.click(screen.getByTestId('hover-card-pr'));
    expect(onOpenMr).toHaveBeenCalledWith(worktree, expect.objectContaining({ number: 42 }));
  });

  it('routes its quick actions to the worktree they belong to', () => {
    const worktree = busy();
    const onOpenDiff = vi.fn();
    const onWorktreeSettings = vi.fn();
    const onOpenWorktree = vi.fn();
    wrap(<Sidebar {...base} worktrees={[worktree]} onOpenDiff={onOpenDiff}
      onWorktreeSettings={onWorktreeSettings} onOpenWorktree={onOpenWorktree}
      expandedRepos={new Set(['r1'])} />);
    for (const action of ['Changes', 'New shell', 'Settings']) {
      hoverRow();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: action }));
      // acting on the card dismisses it — the work continues in a modal or the hub
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    expect(onOpenDiff).toHaveBeenCalledWith(worktree);
    expect(onOpenWorktree).toHaveBeenCalledWith(worktree, 'shell', undefined);
    expect(onWorktreeSettings).toHaveBeenCalledWith(worktree);
  });

  it('closes once the cursor leaves both the row and the card', () => {
    wrap(<Sidebar {...base} worktrees={[busy()]} expandedRepos={new Set(['r1'])} />);
    const row = hoverRow();
    fireEvent.pointerLeave(row);
    fireEvent.pointerEnter(screen.getByRole('dialog'));
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.pointerLeave(screen.getByRole('dialog'));
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps only one card open when the cursor moves between rows', () => {
    wrap(<Sidebar {...base} worktrees={[busy(), wt('/r1/FD-2', 'FD-2')]} expandedRepos={new Set(['r1'])} />);
    hoverRow('FD-1');
    fireEvent.pointerLeave(rowFor('FD-1'));
    hoverRow('FD-2');
    const cards = screen.getAllByRole('dialog');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('FD-2');
  });
});
