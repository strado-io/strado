import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, Worktree } from '../../types';
import type { RemoteWorktree } from '../../api';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { publishTickets } from '../../hooks/tickets';
import { SidebarBody, type SidebarBodyProps } from './SidebarBody';

vi.mock('../../hooks/mrSummaries', () => ({ useMrSummaries: vi.fn(() => new Map()) }));

const r1 = { id: 'r1', name: 'api', path: '/r1' } as RepoConfig;
const r2 = { id: 'r2', name: 'web', path: '/r2' } as RepoConfig;
const wt = (path: string, repoId: string): Worktree => ({
  path, repoId, branch: 'fx-412', meta: null, diffStats: null,
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false },
} as Worktree);

function props(over: Partial<SidebarBodyProps> = {}): SidebarBodyProps {
  return {
    wsId: 'w1', repos: [r1, r2], worktrees: [wt('/r1/wt', 'r1'), wt('/r2/wt', 'r2'), wt('/r2/other', 'r2')],
    remoteWorktrees: [], runnerStatuses: [],
    onAddRepo: vi.fn(), onOpenWorktree: vi.fn(), activeWorktreePath: null, onNewWorktree: vi.fn(),
    onWorktreeSettings: vi.fn(), onDeleteWorktree: vi.fn(), onSearch: vi.fn(),
    ...over,
  };
}
// Loose rows come from storage, the way the Dashboard adds them when a worktree opens.
const loose = (...ids: string[]) => localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: ids }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(useMrSummaries).mockReturnValue(new Map());
});

describe('SidebarBody: Working on and Settled', () => {
  it('shows the worktrees you have opened as cards, in open order, and ignores an id that no longer exists', () => {
    loose('local:/r2/other', 'local:/gone', 'local:/r1/wt');
    render(<SidebarBody {...props()} />);
    const working = screen.getByRole('region', { name: 'Working on' });
    const cards = within(working).getAllByRole('button', { name: 'fx-412' });
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!.closest('.group') as HTMLElement).getByText('web')).toBeInTheDocument();
    expect(within(cards[1]!.closest('.group') as HTMLElement).getByText('api')).toBeInTheDocument();
    expect(screen.queryByText('Repos')).not.toBeInTheDocument();
    expect(screen.queryByText('Working on')).not.toBeInTheDocument(); // no heading text
  });

  it('opens a worktree from its card', () => {
    const onOpenWorktree = vi.fn();
    loose('local:/r1/wt');
    render(<SidebarBody {...props({ onOpenWorktree })} />);
    fireEvent.click(screen.getByRole('button', { name: 'fx-412' }));
    expect(onOpenWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: '/r1/wt' }));
  });

  it('removes a card from its menu, leaving the worktree alone', () => {
    loose('local:/r2/other');
    const onDeleteWorktree = vi.fn();
    render(<SidebarBody {...props({ onDeleteWorktree })} />);
    fireEvent.click(screen.getByRole('button', { name: 'fx-412 actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Working on' }));
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: [] });
    expect(onDeleteWorktree).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing yet. Search to open a worktree, or ✎ to start one.')).toBeInTheDocument();
  });

  it('dates a card by when it was last opened here, and a settled card by its PR', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    localStorage.setItem('strado:worktree-lru', JSON.stringify({ '/r2/other': twoHoursAgo }));
    loose('local:/r2/other');
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r1/wt', { state: 'merged', mergedAt: new Date(Date.now() - 3 * 86400000).toISOString(), updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    render(<SidebarBody {...props()} />);
    const working = screen.getByRole('region', { name: 'Working on' });
    const looseCard = within(working).getByRole('button', { name: 'fx-412' }).closest('.group') as HTMLElement;
    expect(within(looseCard).getByText('2h')).toBeInTheDocument();
    expect(within(looseCard).getByText('web')).toBeInTheDocument(); // repo line
    expect(within(looseCard).getAllByText('fx-412')).toHaveLength(2); // title and the branch line
    const settled = screen.getByRole('region', { name: 'Settled' });
    expect(within(settled).getByText('3d')).toBeInTheDocument();
  });

  it('titles a card from its ticket summary, else its PR title, when the worktree has no title of its own', () => {
    const ticketed = { ...wt('/r2/other', 'r2'), branch: 'FD-9-login', meta: { ticketId: 'FD-9', ticketProvider: 'jira' } } as Worktree;
    const pr = { ...wt('/r1/wt', 'r1'), branch: 'feat/x' } as Worktree;
    publishTickets({ issues: { 'jira:FD-9': { key: 'FD-9', summary: 'Fix login redirect', provider: 'jira', url: '' } as never } });
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r1/wt', { state: 'open', title: 'Add rate limiting', updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    loose('local:/r2/other', 'local:/r1/wt');
    render(<SidebarBody {...props({ worktrees: [ticketed, pr] })} />);
    expect(screen.getByRole('button', { name: 'FD-9' })).toHaveTextContent('Fix login redirect');
    expect(screen.getByRole('button', { name: 'feat/x' })).toHaveTextContent('Add rate limiting');
  });

  it('moves a worktree with a merged PR into Settled; a repo checkout never settles', () => {
    const root = { ...wt('/r1', 'r1'), branch: 'master' } as Worktree;
    const done = { ...wt('/r2/done', 'r2'), branch: 'fx-old' } as Worktree;
    vi.mocked(useMrSummaries).mockReturnValue(new Map([
      ['/r2/done', { state: 'merged', updatedAt: '2026-01-01' }],
      ['/r1', { state: 'merged', updatedAt: '2026-01-01' }],
    ]) as ReturnType<typeof useMrSummaries>);
    loose('local:/r1', 'local:/r2/done');
    render(<SidebarBody {...props({ worktrees: [root, done] })} />);
    const settled = screen.getByRole('region', { name: 'Settled' });
    expect(within(settled).getByRole('button', { name: 'fx-old' })).toBeInTheDocument();
    expect(within(settled).queryByRole('button', { name: 'master' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Working on' })).getByRole('button', { name: 'master' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'fx-old' })).toHaveLength(1);
    fireEvent.click(within(settled).getByRole('button', { name: /^Settled \(/ }));
    expect(within(settled).queryByRole('button', { name: 'fx-old' })).not.toBeInTheDocument();
  });

  it('shows no Settled section when nothing has settled', () => {
    render(<SidebarBody {...props()} />);
    expect(screen.queryByRole('region', { name: 'Settled' })).not.toBeInTheDocument();
  });

  it('toolbar: Search opens the palette, New worktree and Add repo call out', () => {
    const onSearch = vi.fn(); const onNewWorktree = vi.fn(); const onAddRepo = vi.fn();
    render(<SidebarBody {...props({ onSearch, onNewWorktree, onAddRepo })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(onNewWorktree).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    expect(onAddRepo).toHaveBeenCalledWith(expect.objectContaining({ bottom: expect.any(Number) }));
    expect(screen.queryByRole('button', { name: 'New group' })).toBeNull();
  });

  it('right-clicking a card opens its menu at the cursor', () => {
    loose('local:/r1/wt');
    render(<SidebarBody {...props()} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'fx-412' }), { clientX: 40, clientY: 80 });
    const menu = screen.getByRole('menu');
    expect(menu).toHaveStyle({ left: '40px', top: '80px' });
    expect(within(menu).getByRole('button', { name: 'Delete worktree' })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Remove from Working on' })).toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: /group/ })).toBeNull();
  });

  it('right-clicking blank sidebar space offers New worktree and Add repo only', () => {
    const onNewWorktree = vi.fn();
    const { container } = render(<SidebarBody {...props({ onNewWorktree })} />);
    fireEvent.contextMenu(container.querySelector('.overflow-y-auto')!, { clientX: 20, clientY: 300 });
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual(['New worktree…', 'Add repo…']);
    fireEvent.click(within(menu).getByRole('button', { name: 'New worktree…' }));
    expect(onNewWorktree).toHaveBeenCalled();
  });

  describe('Focus switch', () => {
    const focusOff = () => fireEvent.click(screen.getByRole('button', { name: 'Focus' }));

    it('is on by default: only opened worktrees show, and the whole space is one click away', () => {
      loose('local:/r1/wt');
      render(<SidebarBody {...props()} />);
      expect(screen.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getAllByRole('button', { name: 'fx-412' })).toHaveLength(1);
      expect(screen.queryByRole('region', { name: 'All worktrees' })).toBeNull();
      focusOff();
      expect(screen.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByRole('region', { name: 'Working on' })).toBeNull();
      const all = screen.getByRole('region', { name: 'All worktrees' });
      expect(within(within(all).getByRole('group', { name: 'api' })).getAllByRole('button', { name: 'fx-412' })).toHaveLength(1);
      expect(within(within(all).getByRole('group', { name: 'web' })).getAllByRole('button', { name: 'fx-412' })).toHaveLength(2);
      expect(localStorage.getItem('strado:sidebar-focus')).toBe('off');
    });

    it('remembers being off across mounts, and comes back on with another click', () => {
      localStorage.setItem('strado:sidebar-focus', 'off');
      render(<SidebarBody {...props()} />);
      expect(screen.getByRole('region', { name: 'All worktrees' })).toBeInTheDocument();
      focusOff();
      expect(screen.getByRole('region', { name: 'Working on' })).toBeInTheDocument();
      expect(localStorage.getItem('strado:sidebar-focus')).toBe('on');
    });

    it('with Focus off, a settled worktree sits in its repo like any other; there is no Settled section', () => {
      localStorage.setItem('strado:sidebar-focus', 'off');
      vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r1/wt', { state: 'merged', updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
      render(<SidebarBody {...props()} />);
      expect(screen.queryByRole('region', { name: 'Settled' })).toBeNull();
      expect(within(screen.getByRole('group', { name: 'api' })).getByRole('button', { name: 'fx-412' })).toBeInTheDocument();
    });

    it('opens a worktree from the tree; its menu has no Remove, since it is not a Working on row', () => {
      localStorage.setItem('strado:sidebar-focus', 'off');
      const onOpenWorktree = vi.fn();
      render(<SidebarBody {...props({ onOpenWorktree, worktrees: [wt('/r2/other', 'r2')] })} />);
      fireEvent.click(screen.getByRole('button', { name: 'fx-412' }));
      expect(onOpenWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: '/r2/other' }));
      fireEvent.click(screen.getByRole('button', { name: 'fx-412 actions' }));
      expect(screen.getByRole('menu').textContent).not.toContain('Remove from Working on');
    });

    it('lists runner worktrees under their runner; an empty repo gets no heading', () => {
      localStorage.setItem('strado:sidebar-focus', 'off');
      const remote = {
        runnerId: 'rn1', runnerName: 'gpu-box', wsBase: 'wss://rn1', remoteWsId: 'default',
        path: '/srv/wt/FX-77', name: 'FX-77', branch: 'fx-77', head: 'h', remoteRepoId: null,
        isRepoRoot: false, cloneUrl: null, localRepoId: 'r1', remoteRepoName: null,
      } as RemoteWorktree;
      render(<SidebarBody {...props({ worktrees: [], remoteWorktrees: [remote], runnerStatuses: [{ runnerId: 'rn1', name: 'gpu-box', online: true, error: null }] as never })} />);
      expect(screen.queryByRole('group', { name: 'api' })).toBeNull();
      expect(within(screen.getByRole('group', { name: 'gpu-box' })).getByRole('button', { name: 'fx-77 on gpu-box' })).toBeInTheDocument();
    });

    it('with Focus off and nothing in the space, says so', () => {
      localStorage.setItem('strado:sidebar-focus', 'off');
      render(<SidebarBody {...props({ worktrees: [] })} />);
      expect(screen.getByText('No worktrees yet. Add a repo, or ✎ to start one.')).toBeInTheDocument();
    });
  });
});
