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

// One active Focus, its members set per test by seedFocus; the server store
// is not under test here.
const focusMock = vi.hoisted(() => ({ members: [] as string[], setMembership: vi.fn() }));
vi.mock('../hooks/useFocuses', () => ({
  useFocuses: () => {
    const f = { id: 'f1', name: 'Working on', members: focusMock.members, createdAt: 't', lastActiveAt: 't' };
    return { focuses: [f], loaded: true, active: f, activeId: 'f1', activate: vi.fn(), create: vi.fn(), rename: vi.fn(), setMembership: focusMock.setMembership, remove: vi.fn() };
  },
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
  sessionStorage.setItem('strado:focus-expanded', JSON.stringify(['f1'])); // these tests read the cards: expanded
  seedFocus();
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

const ws: Workspace ={ id: 'w1', name: 'W', color: '#333', icon: 'W', defaultPortBase: 8080, logDir: null };
const repo = { id: 'r1', name: 'Repo One', path: '/r1' } as RepoConfig;
const wt = (
  path: string,
  ticketId?: string,
  status: 'idle' | 'running' = 'idle',
  diffStats: Worktree['diffStats'] = null,
): Worktree =>
  ({ path, repoId: 'r1', branch: 'feat/x', meta: ticketId ? ({ ticketId } as Worktree['meta']) : null, diffStats,
     process: { status, pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false } } as Worktree);

const ws2: Workspace = { id: 'w2', name: 'Second', color: '#444', icon: 'S', defaultPortBase: 9090, logDir: null };
// Every space's pane renders the same chrome (the search box among it), so a
// query for chrome has to say which pane it means. The active space is the
// first workspace in these tests, hence pane 0.
const activePane = () => within(screen.getAllByTestId('carousel-pane')[0]!);

const ws3: Workspace ={ id: 'w3', name: 'Third', color: '#555', icon: 'T', defaultPortBase: 9100, logDir: null };
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
  selected: { kind: 'worktrees' as const },
  onSelect: vi.fn(),
  onOpenSettings: vi.fn(),
  onCollapse: vi.fn(),
  onAddRepo: vi.fn(),
  onOpenWorktree: vi.fn(),
  onNewWorktree: vi.fn(),
  onWorktreeSettings: vi.fn(),
  onDeleteWorktree: vi.fn(),
  activeWorktreePath: null,
  update: {
    phase: 'idle' as const, info: null, progress: 0, error: null,
    mode: 'swap' as const,
    onUpdate: vi.fn(), onInstall: vi.fn(), onDismiss: vi.fn(),
  },
};

// Worktree rows are the active Focus's members; seed every path these tests
// use. Ids that match no worktree render nothing, so the list is safe to over-fill.
const MEMBERS = [...new Set(['/r1/FD-1', '/r1/FD-2', ...Array.from({ length: 10 }, (_, i) => `/r1/FD-${i}`)])].map((p) => `local:${p}`);
function seedFocus(extra: string[] = []) {
  focusMock.members = [...MEMBERS, ...extra];
  focusMock.setMembership.mockReset().mockResolvedValue(undefined);
}

describe('Sidebar tree', () => {
  // Code reviews / Usage / Settings live in one icon row at the bottom,
  // leaving the rail above for groups and worktrees. No Tasks entry and no
  // counts: the Worktrees page is where you land anyway, and numbers there were noise.
  it('collapsed, it stays built, parked off-screen and invisible (its layout kept), out of the flow', () => {
    wrap(<Sidebar {...base} hidden />);
    const aside = screen.getByTestId('sidebar');
    expect(aside.className.split(/\s+/)).toEqual(expect.arrayContaining(['invisible', 'fixed', '-left-[200vw]']));
    expect(aside).toHaveAttribute('aria-hidden', 'true');
  });

  it('puts the page switcher in an icon row at the bottom, below the Focus, without Tasks or counts', () => {
    wrap(<Sidebar {...base} />);
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(nav).queryByRole('button', { name: 'Tasks' })).toBeNull();
    expect(within(nav).getByRole('button', { name: 'Code reviews' })).toHaveTextContent(/^$/);
    expect(within(nav).queryByRole('status')).toBeNull();
    const body = activePane().getByRole('region', { name: 'Focus' });
    expect(body.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('selects a page and opens settings from the icon row', () => {
    const onSelect = vi.fn();
    const onOpenSettings = vi.fn();
    wrap(<Sidebar {...base} onSelect={onSelect} onOpenSettings={onOpenSettings} />);
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Usage' }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'usage' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('marks only the page you are on; the dock has no Worktrees page', () => {
    const { unmount } = wrap(<Sidebar {...base} selected={{ kind: 'usage' }} />);
    const nav = () => within(screen.getByRole('navigation', { name: 'Pages' }));
    expect(nav().getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-current', 'page');
    expect(nav().getByRole('button', { name: 'Code reviews' })).not.toHaveAttribute('aria-current');
    expect(nav().getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Code reviews', 'Usage', 'Open settings']);
    unmount();
    wrap(<Sidebar {...base} selected={{ kind: 'worktrees' }} />);
    expect(nav().queryAllByRole('button', { current: 'page' })).toHaveLength(0);
  });

  describe('focus members', () => {
    it('shows the active Focus open in the list with its worktrees as cards, and opens them', () => {
      const onOpenWorktree = vi.fn();
      wrap(<Sidebar {...base} onOpenWorktree={onOpenWorktree} />);
      expect(within(activePane().getByTestId('focus-open')).getByRole('heading', { name: 'Working on' })).toBeInTheDocument();
      const body = activePane().getByRole('region', { name: 'Focus' });
      fireEvent.click(within(body).getByRole('button', { name: 'FD-1' }));
      expect(onOpenWorktree).toHaveBeenCalledWith(base.worktrees[0]);
      expect(activePane().queryByRole('button', { name: /^Pin / })).toBeNull();
    });

    it('removes a worktree from the Focus by name', () => {
      wrap(<Sidebar {...base} />);
      fireEvent.click(activePane().getByLabelText('FD-2 actions'));
      fireEvent.click(screen.getByRole('button', { name: 'Remove from Working on' }));
      expect(focusMock.setMembership).toHaveBeenCalledWith('f1', 'local:/r1/FD-2', false);
    });
  });

  it('shows the agent-working loader on the specific worktree row, not the repo row', () => {
    const working = { ...wt('/r1/FD-1', 'FD-1'), claudeStatus: 'working' as const };
    wrap(<Sidebar {...base} worktrees={[working, wt('/r1/FD-2', 'FD-2')]} />);
    // only the working worktree row spins; the repo row no longer rolls it up
    expect(screen.getAllByRole('status', { name: 'agent working' })).toHaveLength(1);
  });

  it.each(['codexStatus', 'opencodeStatus'] as const)('shows Shell-hosted %s activity through the aggregate status', (field) => {
    const working = { ...wt('/r1/FD-1', 'FD-1'), [field]: 'working' as const };
    wrap(<Sidebar {...base} worktrees={[working]} />);
    expect(screen.getByRole('status', { name: 'agent working' })).toBeInTheDocument();
  });

  it('shows no loader when agents are idle', () => {
    wrap(<Sidebar {...base} />);
    expect(screen.queryByRole('status', { name: 'agent working' })).toBeNull();
  });

  it('the selected row is the raised glass pill; cards carry their own session faces, not the board\'s stack', () => {
    const withSession = { ...wt('/r1/FD-1', 'FD-1'), hasShellSession: true };
    const withoutSession = wt('/r1/FD-2', 'FD-2');
    wrap(
      <Sidebar {...base} worktrees={[withSession, withoutSession]}
        activeWorktreePath={withSession.path} />,
    );

    expect(screen.queryByTestId(`session-stack-${withSession.path}`)).toBeNull();
    expect(screen.queryByTestId(`session-stack-${withoutSession.path}`)).toBeNull();
    const selectedRow = screen.getByRole('button', { name: 'FD-1' }).closest('.group');
    expect(selectedRow).toHaveClass('glass-pill');
    expect(selectedRow).not.toHaveClass('ring-1');
    expect(screen.getByTestId(`card-sessions-${withSession.path}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`card-sessions-${withoutSession.path}`)).toBeNull();
  });

  it('shows worktree children with a running dot when the repo is expanded', () => {
    wrap(<Sidebar {...base} />);
    expect(screen.getByRole('button', { name: 'FD-1' })).toBeInTheDocument();
    expect(screen.getByText('FD-2')).toBeInTheDocument();
    // running worktree row carries a dot (title attr marks it)
    expect(screen.getByTestId('run-dot-/r1/FD-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-dot-/r1/FD-2')).toBeNull();
  });

  it('has no Active nav item — a running dev server shows on its own worktree row', () => {
    wrap(<Sidebar {...base} />);
    expect(screen.queryByRole('button', { name: /^Active/ })).toBeNull();
    expect(screen.getByTestId('run-dot-/r1/FD-1')).toBeInTheDocument();
  });

  it('shows +adds −dels on a worktree row with uncommitted changes', () => {
    const dirty = wt('/r1/FD-1', 'FD-1', 'idle', { additions: 42, deletions: 7, files: 3 });
    wrap(<Sidebar {...base} worktrees={[dirty, wt('/r1/FD-2', 'FD-2')]} />);
    const badge = screen.getByTestId('diff-/r1/FD-1');
    expect(badge).toHaveTextContent('+42');
    expect(badge).toHaveTextContent('-7');
    // a clean worktree stays quiet
    expect(screen.queryByTestId('diff-/r1/FD-2')).toBeNull();
  });

  it('shows no diff badge when the worktree has stats but nothing changed', () => {
    const clean = wt('/r1/FD-1', 'FD-1', 'idle', { additions: 0, deletions: 0, files: 0 });
    wrap(<Sidebar {...base} worktrees={[clean]} />);
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
    wrap(<Sidebar {...base} worktrees={[dirty]}
      onOpenMr={onOpenMr} onOpenWorktree={onOpenWorktree} />);
    expect(screen.getByTestId(`diff-${dirty.path}`)).toHaveTextContent('+12-3');
    const badge = screen.getByTestId(`pr-status-${dirty.path}`);
    expect(badge).not.toHaveTextContent('PR Open');
    expect(badge).not.toHaveTextContent('✓');
    expect(badge).toHaveAccessibleName('Open PR 42, open, checks passed');
    expect(badge.querySelector('[data-pr-icon="open"]')).not.toBeNull();
    expect(badge).toHaveStyle({ color: '#3fb950' });
    const row = screen.getByRole('button', { name: 'FD-1' }).closest('.group')!;
    expect(row.querySelector('[data-worktree-icon="branch"]')).toBeNull();
    // The PR icon carries no tooltip of its own any more — one hover surface
    // per row, and it belongs to the row.
    fireEvent.mouseEnter(badge);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(badge);
    expect(onOpenMr).toHaveBeenCalledWith(dirty, expect.objectContaining({ number: 42 }));
    expect(onOpenWorktree).not.toHaveBeenCalled();
  });

  it('lays a worktree out as a card: name, then repo · branch, no PR icon without a PR', () => {
    wrap(<Sidebar {...base} worktrees={[wt('/r1/FD-1', 'FD-1')]} />);
    const card = screen.getByRole('button', { name: 'FD-1' }).closest('.group') as HTMLElement;
    expect(within(card).getByText('Repo One')).toBeInTheDocument();
    // At rest the name is zinc-200; the open worktree's is brighter still.
    expect(within(card).getByRole('button', { name: 'FD-1' })).toHaveClass('text-zinc-200');
    expect(within(card).getByText('feat/x')).toHaveClass('font-mono');
    expect(card.querySelector('[data-testid^="pr-status-"]')).toBeNull();
    expect(card.querySelector('[data-worktree-icon="branch"]')).toBeNull();
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
    wrap(<Sidebar {...base} worktrees={[worktree]} />);
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
    wrap(<Sidebar {...base} worktrees={[worktree]} />);
    const badge = screen.getByTestId(`pr-status-${worktree.path}`);
    expect(badge.querySelector('[data-pr-icon="closed"]')).not.toBeNull();
    expect(badge).toHaveAccessibleName('Open PR 42, closed');
    expect(badge).toHaveStyle({ color: '#f85149' });
  });

  it('opens a worktree on child click', () => {
    wrap(<Sidebar {...base} />);
    fireEvent.click(screen.getByRole('button', { name: 'FD-1' }));
    expect(base.onOpenWorktree).toHaveBeenCalledWith(base.worktrees[0]);
  });

  it('worktree ⋯ menu fires settings and delete', () => {
    wrap(<Sidebar {...base} />);
    fireEvent.click(screen.getByLabelText('FD-1 actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(base.onWorktreeSettings).toHaveBeenCalledWith(base.worktrees[0]);
    fireEvent.click(screen.getByLabelText('FD-1 actions'));
    fireEvent.click(screen.getByRole('button', { name: /Delete worktree/ }));
    expect(base.onDeleteWorktree).toHaveBeenCalledWith(base.worktrees[0]);
  });

  it('overlays worktree actions on hover without reserving row width', () => {
    wrap(<Sidebar {...base} />);
    const actions = screen.getByLabelText('FD-1 actions');
    expect(actions).toHaveClass('inline-flex', 'opacity-0', 'group-hover:opacity-100', 'h-5', 'w-5', 'p-[3px]');
    expect(actions.parentElement).toHaveClass('absolute', 'right-1');
  });

  it('the new-focus event opens one composer, in the active pane only', () => {
    wrap(<Sidebar {...base} />);
    fireEvent(window, new Event('strado:new-focus'));
    expect(screen.getAllByRole('dialog', { name: 'New focus' })).toHaveLength(1);
  });

  it('New worktree and Add repo live in the blank-space menu (and the open Focus\'s ⋯ menu)', () => {
    const onNewWorktree = vi.fn(); const onAddRepo = vi.fn();
    wrap(<Sidebar {...base} onNewWorktree={onNewWorktree} onAddRepo={onAddRepo} />);
    fireEvent.contextMenu(activePane().getByRole('region', { name: 'Focus' }).parentElement!, { clientX: 5, clientY: 50 });
    fireEvent.click(screen.getByRole('button', { name: 'New worktree…' }));
    expect(onNewWorktree).toHaveBeenCalled();
    expect(activePane().queryByRole('button', { name: 'Add repo' })).toBeNull();
    fireEvent.contextMenu(activePane().getByRole('region', { name: 'Focus' }).parentElement!, { clientX: 5, clientY: 50 });
    fireEvent.click(screen.getByRole('button', { name: 'Add repo…' }));
    expect(onAddRepo).toHaveBeenCalledWith(expect.objectContaining({ bottom: 50 }));
  });

  it('has no New worktree button of its own; the workspace row is just its name and chevron, New is in the toolbar under it', () => {
    wrap(<Sidebar {...base} />);
    expect(activePane().queryByRole('button', { name: 'New worktree' })).toBeNull();
    // One dropdown button: the chevron is inside the switcher, and the row has no other button.
    const button = screen.getByTestId('space-chevron').closest('button')!;
    expect(button).toHaveAttribute('aria-label', expect.stringMatching(/^Switch workspace/));
    const row = button.parentElement!;
    expect(within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^Switch workspace/)]);
    const plus = within(activePane().getByTestId('sidebar-toolbar')).getByRole('button', { name: 'New' });
    expect(plus).toHaveAttribute('title', 'New (⇧⌘N)');
    fireEvent.click(plus);
    expect(screen.getAllByRole('dialog', { name: 'New focus' })).toHaveLength(1);
  });

  it('the chevron opens the workspace menu too', () => {
    wrap(<Sidebar {...base} />);
    fireEvent.click(screen.getByTestId('space-chevron'));
    expect(screen.getByRole('menu', { name: 'Workspaces' })).toBeInTheDocument();
  });

  describe('many worktrees (> 7)', () => {
    const many = Array.from({ length: 10 }, (_, i) => wt(`/r1/FD-${i}`, `FD-${i}`));
    const bigBase = { ...base, worktrees: many };

    it('shows every worktree without Show-more or Show-less controls', () => {
      wrap(<Sidebar {...bigBase} />);
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
      wrap(<Sidebar {...base} />);
      expect(screen.getByRole('complementary')).toHaveStyle({ width: '340px' });
    });

    it('clamps an out-of-range persisted width and defaults when unset', () => {
      localStorage.setItem('strado.sidebarWidth', '9999');
      const { unmount } = wrap(<Sidebar {...base} />);
      expect(screen.getByRole('complementary')).toHaveStyle({ width: '480px' });
      unmount();
      localStorage.removeItem('strado.sidebarWidth');
      wrap(<Sidebar {...base} />);
      expect(screen.getByRole('complementary')).toHaveStyle({ width: '288px' });
    });

    it('dragging the handle resizes live and persists on release', () => {
      wrap(<Sidebar {...base} />);
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
    // Runner rows render only as Focus members; every test here uses this path.
    beforeEach(() => { seedFocus([`remote:runner-dev-wq3p:${remote().path}`]); });

    const statuses = (online: boolean): RunnerStatus[] => [
      { runnerId: 'runner-dev-wq3p', name: 'runner-dev', online, error: null },
    ];

    it('gives a runner worktree the same hover card, named with its machine', () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const onOpenRemoteWorktree = vi.fn();
      const w = remote({ hasShellSession: true, shellSessions: ['1'] } as Partial<RemoteWorktree>);
      wrap(
        <Sidebar {...base} remoteWorktrees={[w]}
          runnerStatuses={statuses(true)} onOpenRemoteWorktree={onOpenRemoteWorktree} />,
      );
      const row = within(screen.getByRole('complementary')).getByText('FD-9').closest('.group')!;
      fireEvent.pointerEnter(row);
      act(() => { vi.advanceTimersByTime(250); });

      const card = screen.getByRole('dialog');
      expect(card).toHaveTextContent('runner-dev');
      // No per-session deep link exists for a remote worktree, so a session
      // click opens the worktree itself rather than pretending otherwise.
      fireEvent.click(within(card).getByRole('button', { name: /Shell/ }));
      expect(onOpenRemoteWorktree).toHaveBeenCalledWith(w);
      vi.useRealTimers();
    });

    it("a runner worktree's card opens its Files tab by name", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const onOpenRemoteWorktree = vi.fn();
      const w = remote();
      wrap(
        <Sidebar {...base} remoteWorktrees={[w]}
          runnerStatuses={statuses(true)} onOpenRemoteWorktree={onOpenRemoteWorktree} />,
      );
      fireEvent.pointerEnter(within(screen.getByRole('complementary')).getByText('FD-9').closest('.group')!);
      act(() => { vi.advanceTimersByTime(250); });
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Files' }));
      expect(onOpenRemoteWorktree).toHaveBeenCalledWith(w, 'files');
      vi.useRealTimers();
    });

    it('lists a runner worktree under the repo it belongs to, badged with the machine', () => {
      wrap(
        <Sidebar {...base}
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
        <Sidebar {...base}
          remoteWorktrees={[remote()]} runnerStatuses={statuses(false)} />,
      );
      expect(screen.getByText('FD-9')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'runner-dev runner, offline' })).toHaveClass('text-red-400/70');
      expect(screen.queryByText('runner-dev · offline')).toBeNull();
    });

    it('shows a loading hint while the runner list is still being fetched', () => {
      wrap(
        <Sidebar {...base} remoteLoading
          remoteWorktrees={[]} runnerStatuses={[]} />,
      );
      expect(activePane().getByText('Checking runners…')).toBeInTheDocument();
    });

    it('drops the loading hint once the runner list has arrived', () => {
      wrap(
        <Sidebar {...base}
          remoteWorktrees={[]} runnerStatuses={[]} />,
      );
      expect(screen.queryByText('Checking runners…')).toBeNull();
    });

    it('surfaces a reachable runner whose API failed, rather than implying it has none', () => {
      wrap(
        <Sidebar {...base} remoteWorktrees={[]}
          runnerStatuses={[{ runnerId: 'x', name: 'runner-dev', online: true, error: 'timed out' }]} />,
      );
      expect(screen.getByText(/runner-dev: timed out/)).toBeInTheDocument();
    });

    it('opens the runner worktree on click', () => {
      const onOpen = vi.fn();
      wrap(
        <Sidebar {...base} remoteWorktrees={[remote()]}
          runnerStatuses={statuses(true)} onOpenRemoteWorktree={onOpen} />,
      );
      fireEvent.click(screen.getByText('FD-9'));
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/strado/demo-repo.worktrees/FD-9' }));
    });

    it('offers delete on a runner worktree, and never on a repo root', () => {
      const onDelete = vi.fn();
      const { unmount } = wrap(
        <Sidebar {...base} remoteWorktrees={[remote()]}
          runnerStatuses={statuses(true)} onDeleteRemoteWorktree={onDelete} />,
      );
      const actions = screen.getByLabelText('FD-9 on runner-dev actions');
      expect(actions).toHaveClass('h-5', 'w-5', 'p-[3px]');
      fireEvent.click(actions);
      fireEvent.click(screen.getByText('Delete worktree'));
      expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/strado/demo-repo.worktrees/FD-9' }));
      unmount();

      // A repo's main working tree isn't removable as a worktree — the delete
      // route refuses it — so offering the action would be a dead end. Its
      // menu still exists to take it out of Working on.
      wrap(
        <Sidebar {...base}
          remoteWorktrees={[remote({ isRepoRoot: true, name: 'main', branch: 'main' })]}
          runnerStatuses={statuses(true)} onDeleteRemoteWorktree={onDelete} />,
      );
      fireEvent.click(screen.getByLabelText('main on runner-dev actions'));
      expect(screen.getByText('Remove from Working on')).toBeInTheDocument();
      expect(screen.queryByText('Delete worktree')).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    it('flags a worktree that fell back to the host on a sandboxing runner, and offers a rebuild', () => {
      const onRebuild = vi.fn();
      const { unmount } = wrap(
        <Sidebar {...base} remoteWorktrees={[remote({ sandbox: 'fallback' })]}
          runnerStatuses={statuses(true)} onRebuildSandbox={onRebuild} />,
      );
      // The badge is the whole point: a silent fallback is agents running
      // unisolated with nothing on screen saying so.
      expect(screen.getByText('no sandbox')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('FD-9 on runner-dev actions'));
      fireEvent.click(screen.getByText('Rebuild sandbox'));
      expect(onRebuild).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/strado/demo-repo.worktrees/FD-9' }));
      unmount();

      // Sandboxed, or a runner that never sandboxes: nothing to flag, nothing to rebuild.
      for (const sandbox of ['on', 'off'] as const) {
        const { unmount: done } = wrap(
          <Sidebar {...base} remoteWorktrees={[remote({ sandbox })]}
            runnerStatuses={statuses(true)} onRebuildSandbox={onRebuild} />,
        );
        expect(screen.queryByText('no sandbox')).toBeNull();
        fireEvent.click(screen.getByLabelText('FD-9 on runner-dev actions'));
        expect(screen.queryByText('Rebuild sandbox')).toBeNull();
        fireEvent.keyDown(window, { key: 'Escape' });
        done();
      }
    });
  });

  describe('Sidebar space rail', () => {
    beforeEach(() => { switchTo.mockClear(); });

    it('shows the active workspace in a header picker', () => {
      wrap(<Sidebar {...base} />);
      expect(screen.getByTestId('space-name')).toHaveTextContent('W');
      expect(screen.getByRole('button', { name: 'Switch workspace, current: W' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('button', { name: 'Space actions' })).toBeNull();
    });

    it('switches workspaces from the header picker', () => {
      wrap(<Sidebar {...base} />, [ws, ws2, ws3]);
      fireEvent.click(screen.getByRole('button', { name: 'Switch workspace, current: W' }));
      expect(screen.getByRole('menu', { name: 'Workspaces' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Third' }));
      expect(switchTo).toHaveBeenCalledWith('w3');
      expect(screen.queryByRole('menu', { name: 'Workspaces' })).toBeNull();
    });

    it('the dots live in the workspace popover, not in a row of their own', () => {
      wrap(<Sidebar {...base} />);
      expect(screen.queryByRole('button', { name: 'Switch to W' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Switch workspace, current: W' }));
      const menu = screen.getByRole('menu', { name: 'Workspaces' });
      expect(within(menu).getByTestId('space-dots-row')).toBeInTheDocument();
      expect(within(menu).getByRole('button', { name: 'Switch to W' })).toHaveAttribute('aria-current', 'true');
      expect(within(menu).getByRole('button', { name: 'Switch to Second' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Space actions' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument();
    });

    it('switches workspace when a dot with no pane of its own is clicked, and closes the popover', () => {
      // ws3 is two spaces away: there is no pane to slide, so it switches
      // straight over instead of animating.
      wrap(<Sidebar {...base} />, [ws, ws2, ws3]);
      fireEvent.click(screen.getByRole('button', { name: 'Switch workspace, current: W' }));
      fireEvent.click(screen.getByRole('button', { name: 'Switch to Third' }));
      expect(switchTo).toHaveBeenCalledWith('w3');
      expect(screen.queryByRole('menu', { name: 'Workspaces' })).toBeNull();
    });

    it('animates rather than jumping when the neighbouring dot is clicked', async () => {
      wrap(<Sidebar {...base} />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch workspace, current: W' }));
      fireEvent.click(screen.getByRole('button', { name: 'Switch to Second' }));
      expect(switchTo).not.toHaveBeenCalled(); // the landing commits, not the click
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
    });

    it('frame: on the app canvas with no edge, a 14px workspace name, the page icons in one glass bar', () => {
      wrap(<Sidebar {...base} />);
      const aside = screen.getByTestId('sidebar');
      expect(aside.className).toMatch(/\bbg-zinc-950\b/);
      expect(aside.className).not.toMatch(/\bborder-r\b/);
      expect(screen.getByTestId('space-name').className).toMatch(/text-\[14px\]/);
      expect(screen.getByTestId('sidebar-nav').className).toMatch(/\bglass\b/);
      expect(aside.innerHTML).not.toMatch(/border-t border-white/);
    });
  });

  describe('Sidebar carousel', () => {
    beforeEach(() => { switchTo.mockClear(); });

    it('renders one pane per space with the active space centred', () => {
      wrap(<Sidebar {...base} />);
      const panes = screen.getAllByTestId('carousel-pane');
      expect(panes).toHaveLength(2); // active ws, then its next neighbour ws2
      expect(panes[0]).not.toHaveAttribute('aria-hidden');
      expect(panes[1]).toHaveAttribute('aria-hidden', 'true');
    });

    it('switches workspace when a swipe lands on a neighbour', async () => {
      wrap(<Sidebar {...base} />);
      swipe(PANE_WIDTH * 0.6);
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
    });

    it('stays put when the swipe is only a twitch', async () => {
      wrap(<Sidebar {...base} />);
      swipe(10); // ~14px in total — sideways noise during a vertical scroll
      await new Promise((r) => setTimeout(r, 400));
      expect(switchTo).not.toHaveBeenCalled();
    });

    it('moves to the next space on Cmd+Shift+ArrowRight', async () => {
      wrap(<Sidebar {...base} />);
      fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, shiftKey: true });
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
    });

    it('ignores Cmd+Shift+ArrowLeft at the first space', async () => {
      wrap(<Sidebar {...base} />);
      fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true, shiftKey: true });
      await new Promise((r) => setTimeout(r, 400));
      expect(switchTo).not.toHaveBeenCalled();
    });

    it('leaves plain Cmd+ArrowRight alone — that chord belongs to the tabs', async () => {
      wrap(<Sidebar {...base} />);
      fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true });
      await new Promise((r) => setTimeout(r, 400));
      expect(switchTo).not.toHaveBeenCalled();
    });

    it('moves between spaces from inside a terminal', async () => {
      // xterm takes its keys through a hidden <textarea> inside .xterm, so a
      // tagName guard would kill this chord in the surface the app is mostly
      // used through — which is the one place users will try it.
      wrap(<Sidebar {...base} />);
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
      wrap(<Sidebar {...base} />);
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
        wrap(<Sidebar {...base} />);
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
      wrap(<Sidebar {...base} onSwitchError={onSwitchError} />);
      swipe(PANE_WIDTH * 0.6);
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('w2'), { timeout: 2000 });
      await waitFor(() =>
        expect(onSwitchError).toHaveBeenCalledWith(expect.stringContaining('server is restarting')),
      );
      // Seat 0: the active space is the first of the two panes here.
      expect(screen.getByTestId('carousel-track').style.transform).toBe('translate3d(0px, 0, 0)');
    });

    it('renders a single pane and no dots for a lone workspace', () => {
      wrap(<Sidebar {...base} />, [ws]);
      expect(screen.getAllByTestId('carousel-pane')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Switch to W' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Switch workspace, current: W' }));
      expect(screen.queryByTestId('space-dots-row')).toBeNull();
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
      wrap(<Sidebar {...base} />);
      fireEvent.click(activePane().getByLabelText('FD-1 actions'));
      const track = screen.getByTestId('carousel-track');
      expect(track.contains(screen.getByRole('button', { name: 'Remove from Working on' }))).toBe(false);
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
    return within(screen.getByRole('complementary')).getByRole('button', { name: label }).closest('.group')!;
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
    wrap(<Sidebar {...base} worktrees={[worktree]} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    hoverRow();

    const card = screen.getByRole('dialog');
    expect(card).toHaveTextContent('#42');
    expect(card).toHaveTextContent('Ship it');
    expect(within(card).getByRole('button', { name: /Claude 2/ })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /Shell/ })).toBeInTheDocument();
  });

  it('does not open while the cursor is only passing over the row', () => {
    wrap(<Sidebar {...base} worktrees={[busy()]} />);
    const row = screen.getByRole('button', { name: 'FD-1' }).closest('.group')!;
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
      />);
    hoverRow();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Claude 2/ }));
    expect(onOpenWorktree).toHaveBeenCalledWith(worktree, 'claude', '2');
  });

  it('opens the review from the card', () => {
    const worktree = busy();
    const onOpenMr = vi.fn();
    vi.mocked(useMrSummaries).mockReturnValue(new Map([[worktree.path, pr]]));
    wrap(<Sidebar {...base} worktrees={[worktree]} onOpenMr={onOpenMr} />);
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
      />);
    for (const action of ['Changes', 'Files', 'New shell', 'Settings']) {
      hoverRow();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: action }));
      // acting on the card dismisses it — the work continues in a modal or the hub
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    expect(onOpenDiff).toHaveBeenCalledWith(worktree);
    expect(onOpenWorktree).toHaveBeenCalledWith(worktree, 'shell', undefined);
    expect(onOpenWorktree).toHaveBeenCalledWith(worktree, 'files', undefined);
    expect(onWorktreeSettings).toHaveBeenCalledWith(worktree);
  });

  it('dismisses the card when the row ⋯ menu takes over', () => {
    const worktree = busy();
    const onWorktreeSettings = vi.fn();
    wrap(<Sidebar {...base} worktrees={[worktree]} onWorktreeSettings={onWorktreeSettings}
      />);
    hoverRow();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // The menu opens over the row; a preview card beside it is just clutter.
    fireEvent.click(screen.getByLabelText('FD-1 actions'));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Picking Settings opens a modal whose backdrop swallows pointer events,
    // so nothing downstream could ever close a card left behind here.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onWorktreeSettings).toHaveBeenCalledWith(worktree);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes once the cursor leaves both the row and the card', () => {
    wrap(<Sidebar {...base} worktrees={[busy()]} />);
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
    wrap(<Sidebar {...base} worktrees={[busy(), wt('/r1/FD-2', 'FD-2')]} />);
    hoverRow('FD-1');
    fireEvent.pointerLeave(rowFor('FD-1'));
    hoverRow('FD-2');
    const cards = screen.getAllByRole('dialog');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('FD-2');
  });
});
