import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import type { RemoteWorktree, RunnerStatus } from '../api';
import type { RepoConfig, Worktree, Workspace } from '../types';

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
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(PANE_WIDTH);
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
  it('shows the agent-working loader on the specific worktree row, not the repo row', () => {
    const working = { ...wt('/r1/FD-1', 'FD-1'), claudeStatus: 'working' as const };
    wrap(<Sidebar {...base} worktrees={[working, wt('/r1/FD-2', 'FD-2')]} expandedRepos={new Set(['r1'])} />);
    // only the working worktree row spins; the repo row no longer rolls it up
    expect(screen.getAllByRole('status', { name: 'agent working' })).toHaveLength(1);
  });

  it('shows no loader for a collapsed repo even when a worktree inside is working', () => {
    const working = { ...wt('/r1/FD-1', 'FD-1'), claudeStatus: 'working' as const };
    wrap(<Sidebar {...base} worktrees={[working]} expandedRepos={new Set()} />);
    // accepted tradeoff: a collapsed repo hides its worktree rows, so there is
    // no working hint here — the session rail is the at-a-glance view instead
    expect(screen.queryByRole('status', { name: 'agent working' })).toBeNull();
  });

  it('shows no loader when agents are idle', () => {
    wrap(<Sidebar {...base} expandedRepos={new Set(['r1'])} />);
    expect(screen.queryByRole('status', { name: 'agent working' })).toBeNull();
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

  it('repo-row + button fires new-worktree without opening the menu', () => {
    const onNewWorktreeForRepo = vi.fn();
    const onToggleRepo = vi.fn();
    wrap(<Sidebar {...base} onNewWorktreeForRepo={onNewWorktreeForRepo} onToggleRepo={onToggleRepo} expandedRepos={new Set()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New worktree in Repo One' }));
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

    it('caps the list at 7 and offers a Show-more control', () => {
      wrap(<Sidebar {...bigBase} expandedRepos={new Set(['r1'])} />);
      expect(screen.getByText('FD-0')).toBeInTheDocument();
      expect(screen.getByText('FD-6')).toBeInTheDocument();
      expect(screen.queryByText('FD-7')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Show 3 more/ }));
      expect(screen.getByText('FD-7')).toBeInTheDocument();
      expect(screen.getByText('FD-9')).toBeInTheDocument();
    });

    it('filters worktrees via the global search, showing all matches uncapped', () => {
      wrap(<Sidebar {...bigBase} expandedRepos={new Set(['r1'])} />);
      const search = activePane().getByLabelText('Search worktrees');
      fireEvent.change(search, { target: { value: 'FD-8' } });
      expect(screen.getByText('FD-8')).toBeInTheDocument();
      expect(screen.queryByText('FD-0')).toBeNull();
      expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull();
    });

    it('global search force-expands matching repos and hides non-matching ones', () => {
      // repo collapsed, no expandedRepos entry — a query must still surface matches
      wrap(<Sidebar {...bigBase} expandedRepos={new Set()} />);
      fireEvent.change(activePane().getByLabelText('Search worktrees'), { target: { value: 'FD-8' } });
      expect(screen.getByText('FD-8')).toBeInTheDocument();
      fireEvent.change(activePane().getByLabelText('Search worktrees'), { target: { value: 'zzz-nope' } });
      expect(screen.queryByText(/Repo One/)).toBeNull();
      expect(screen.getByText('No matches')).toBeInTheDocument();
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

    it('lists a runner worktree under the repo it belongs to, badged with the machine', () => {
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])}
          remoteWorktrees={[remote()]} runnerStatuses={statuses(true)} />,
      );
      expect(screen.getByText('FD-9')).toBeInTheDocument();
      // The badge is not decoration: where it runs decides what it can see.
      expect(screen.getByText('runner-dev')).toBeInTheDocument();
    });

    it('keeps an offline runner’s rows visible and marked, never hidden', () => {
      // A row that vanishes reads as data loss. The worktree is fine; the
      // machine is just unreachable.
      wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])}
          remoteWorktrees={[remote()]} runnerStatuses={statuses(false)} />,
      );
      expect(screen.getByText('FD-9')).toBeInTheDocument();
      expect(screen.getByText('runner-dev · offline')).toBeInTheDocument();
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
    it('offers delete on a runner worktree, and never on a repo root', () => {
      const onDelete = vi.fn();
      const { unmount } = wrap(
        <Sidebar {...base} expandedRepos={new Set(['r1'])} remoteWorktrees={[remote()]}
          runnerStatuses={statuses(true)} onDeleteRemoteWorktree={onDelete} />,
      );
      fireEvent.click(screen.getByLabelText('FD-9 on runner-dev actions'));
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

    it('leaves Cmd+Shift+Arrow alone while typing — it selects text there', async () => {
      wrap(<Sidebar {...base} expandedRepos={new Set()} />);
      const search = activePane().getByLabelText('Search worktrees');
      search.focus();
      fireEvent.keyDown(search, { key: 'ArrowRight', metaKey: true, shiftKey: true });
      await new Promise((r) => setTimeout(r, 400));
      expect(switchTo).not.toHaveBeenCalled();
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
