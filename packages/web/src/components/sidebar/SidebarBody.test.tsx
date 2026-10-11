import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, Worktree } from '../../types';
import type { Focus, RemoteWorktree } from '../../api';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { publishTickets } from '../../hooks/tickets';
import { SidebarBody, type SidebarBodyProps } from './SidebarBody';

vi.mock('../../hooks/mrSummaries', () => ({ useMrSummaries: vi.fn(() => new Map()) }));

// The Focus list is a shared server-backed store; here it is a plain in-memory
// one so each test can say which Focuses exist and which is active.
const focusMock = vi.hoisted(() => ({
  focuses: [] as { id: string; name: string; members: string[]; createdAt: string; lastActiveAt: string }[],
  activeId: null as string | null,
  activate: vi.fn(), create: vi.fn(), rename: vi.fn(), setMembership: vi.fn(), remove: vi.fn(),
}));
vi.mock('../../hooks/useFocuses', () => ({
  useFocuses: () => ({
    focuses: focusMock.focuses, loaded: true, activeId: focusMock.activeId,
    active: focusMock.focuses.find((f) => f.id === focusMock.activeId) ?? null,
    activate: focusMock.activate, create: focusMock.create, rename: focusMock.rename,
    setMembership: focusMock.setMembership, remove: focusMock.remove,
  }),
}));
const focus = (id: string, name: string, members: string[] = [], lastActiveAt = '2026-01-01'): Focus =>
  ({ id, name, members, createdAt: '2026-01-01', lastActiveAt });
const withFocus = (...members: string[]) => { focusMock.focuses = [focus('f1', 'Billing', members)]; focusMock.activeId = 'f1'; };

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
const pill = () => screen.getByRole('button', { name: /^Focus: / });
const popover = () => screen.getByRole('dialog', { name: 'Switch focus' });

beforeEach(() => {
  localStorage.clear();
  focusMock.focuses = [];
  focusMock.activeId = null;
  for (const fn of [focusMock.activate, focusMock.create, focusMock.rename, focusMock.setMembership, focusMock.remove]) fn.mockReset();
  focusMock.setMembership.mockResolvedValue(undefined);
  focusMock.create.mockResolvedValue(focus('new', 'New'));
  focusMock.rename.mockResolvedValue(undefined);
  focusMock.remove.mockResolvedValue(undefined);
  vi.mocked(useMrSummaries).mockReturnValue(new Map());
});

describe('SidebarBody: the active Focus', () => {
  it('names the active Focus in the pill and shows its worktrees as cards, in member order, skipping ids that resolve to nothing', () => {
    withFocus('local:/r2/other', 'local:/gone', 'local:/r1/wt');
    render(<SidebarBody {...props()} />);
    expect(pill()).toHaveAccessibleName('Focus: Billing');
    expect(pill()).toHaveTextContent('Billing');
    const section = screen.getByRole('region', { name: 'Focus' });
    const cards = within(section).getAllByRole('button', { name: 'fx-412' });
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!.closest('.group') as HTMLElement).getByText('web')).toBeInTheDocument();
    expect(within(cards[1]!.closest('.group') as HTMLElement).getByText('api')).toBeInTheDocument();
    expect(screen.queryByText('Working on')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Settled' })).toBeNull();
  });

  it('opens a worktree from its card', () => {
    const onOpenWorktree = vi.fn();
    withFocus('local:/r1/wt');
    render(<SidebarBody {...props({ onOpenWorktree })} />);
    fireEvent.click(screen.getByRole('button', { name: 'fx-412' }));
    expect(onOpenWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: '/r1/wt' }));
  });

  it('removes a card from the Focus by name, leaving the worktree alone', () => {
    withFocus('local:/r2/other');
    const onDeleteWorktree = vi.fn();
    render(<SidebarBody {...props({ onDeleteWorktree })} />);
    fireEvent.click(screen.getByRole('button', { name: 'fx-412 actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Billing' }));
    expect(focusMock.setMembership).toHaveBeenCalledWith('f1', 'local:/r2/other', false);
    expect(onDeleteWorktree).not.toHaveBeenCalled();
  });

  it('keeps a merged worktree in the Focus, with its PR badge; nothing settles away', () => {
    withFocus('local:/r1/wt');
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r1/wt', { state: 'merged', updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    render(<SidebarBody {...props()} />);
    expect(within(screen.getByRole('region', { name: 'Focus' })).getByRole('button', { name: 'fx-412' })).toBeInTheDocument();
  });

  it('dates a card by when it was last opened here', () => {
    localStorage.setItem('strado:worktree-lru', JSON.stringify({ '/r2/other': Date.now() - 2 * 60 * 60 * 1000 }));
    withFocus('local:/r2/other');
    render(<SidebarBody {...props()} />);
    const card = screen.getByRole('button', { name: 'fx-412' }).closest('.group') as HTMLElement;
    expect(within(card).getByText('2h')).toBeInTheDocument();
    expect(within(card).getAllByText('fx-412')).toHaveLength(2); // title and the branch line
  });

  it('titles a card from its ticket summary, else its PR title, when the worktree has no title of its own', () => {
    const ticketed = { ...wt('/r2/other', 'r2'), branch: 'FD-9-login', meta: { ticketId: 'FD-9', ticketProvider: 'jira' } } as Worktree;
    const pr = { ...wt('/r1/wt', 'r1'), branch: 'feat/x' } as Worktree;
    publishTickets({ issues: { 'jira:FD-9': { key: 'FD-9', summary: 'Fix login redirect', provider: 'jira', url: '' } as never } });
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r1/wt', { state: 'open', title: 'Add rate limiting', updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    withFocus('local:/r2/other', 'local:/r1/wt');
    render(<SidebarBody {...props({ worktrees: [ticketed, pr] })} />);
    expect(screen.getByRole('button', { name: 'FD-9' })).toHaveTextContent('Fix login redirect');
    expect(screen.getByRole('button', { name: 'feat/x' })).toHaveTextContent('Add rate limiting');
  });

  it('shows a runner worktree in the Focus and lets it be removed', () => {
    const remote = {
      runnerId: 'rn1', runnerName: 'gpu-box', wsBase: 'wss://rn1', remoteWsId: 'default',
      path: '/srv/wt/FX-77', name: 'FX-77', branch: 'fx-77', head: 'h', remoteRepoId: null,
      isRepoRoot: false, cloneUrl: null, localRepoId: 'r1', remoteRepoName: null,
    } as RemoteWorktree;
    withFocus('remote:rn1:/srv/wt/FX-77');
    render(<SidebarBody {...props({ remoteWorktrees: [remote], runnerStatuses: [{ runnerId: 'rn1', name: 'gpu-box', online: true, error: null }] as never })} />);
    fireEvent.click(screen.getByRole('button', { name: 'fx-77 on gpu-box actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Billing' }));
    expect(focusMock.setMembership).toHaveBeenCalledWith('f1', 'remote:rn1:/srv/wt/FX-77', false);
  });

  it('with no Focus, says so and offers to make one; the empty Focus says what to do', () => {
    const { unmount } = render(<SidebarBody {...props()} />);
    expect(pill()).toHaveAccessibleName('Focus: none');
    expect(screen.getByText(/^No focus\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New focus' }));
    expect(within(popover()).getByLabelText('New focus name')).toHaveFocus();
    unmount();
    withFocus();
    render(<SidebarBody {...props()} />);
    expect(screen.getByText('Nothing in Billing yet. Search to open a worktree into it, or ✎ to start one.')).toBeInTheDocument();
  });

  it('toolbar: Search opens the palette, New worktree calls out; no Add repo button', () => {
    const onSearch = vi.fn(); const onNewWorktree = vi.fn();
    render(<SidebarBody {...props({ onSearch, onNewWorktree })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(onNewWorktree).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Add repo' })).toBeNull();
  });

  it('right-clicking a card opens its menu at the cursor; blank space offers New worktree, Add repo and New focus', () => {
    withFocus('local:/r1/wt');
    const onAddRepo = vi.fn();
    const { container } = render(<SidebarBody {...props({ onAddRepo })} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'fx-412' }), { clientX: 40, clientY: 80 });
    let menu = screen.getByRole('menu');
    expect(menu).toHaveStyle({ left: '40px', top: '80px' });
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual(['Settings', 'Remove from Billing', 'Delete worktree']);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.contextMenu(container.querySelector('.overflow-y-auto')!, { clientX: 20, clientY: 300 });
    menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual(['New worktree…', 'Add repo…', 'New focus…']);
    fireEvent.click(within(menu).getByRole('button', { name: 'Add repo…' }));
    expect(onAddRepo).toHaveBeenCalledWith({ left: 20, right: 20, bottom: 300 });
  });
});

describe('SidebarBody: the Focus switcher', () => {
  beforeEach(() => {
    focusMock.focuses = [
      focus('f1', 'Billing', ['local:/r1/wt'], '2026-02-01'),
      focus('f2', 'Onboarding', [], '2026-03-01'),
      focus('f3', 'Perf', ['local:/r2/wt', 'local:/r2/other'], '2026-01-01'),
    ];
    focusMock.activeId = 'f1';
  });

  it('lists Focuses by last use with ⌘ hints and a check on the active one; picking one activates it and closes', () => {
    render(<SidebarBody {...props()} />);
    fireEvent.click(pill());
    const rows = within(popover()).getAllByRole('button').filter((b) => /⌘\d/.test(b.textContent ?? ''));
    expect(rows.map((b) => b.textContent)).toEqual(['Onboarding⌘1', 'Billing1⌘2', 'Perf2⌘3']);
    expect(within(popover()).getByRole('button', { name: /Billing/ })).toHaveAttribute('aria-current', 'true');
    expect(within(popover()).getByLabelText('Filter or create')).toHaveFocus();
    fireEvent.click(within(popover()).getByRole('button', { name: /Perf/ }));
    expect(focusMock.activate).toHaveBeenCalledWith('f3');
    expect(screen.queryByRole('dialog', { name: 'Switch focus' })).toBeNull();
  });

  it('filters by name; Enter picks the highlighted row, or creates when the name is new', () => {
    render(<SidebarBody {...props()} />);
    fireEvent.click(pill());
    const input = within(popover()).getByLabelText('Filter or create');
    fireEvent.change(input, { target: { value: 'perf' } });
    expect(within(popover()).queryByRole('button', { name: /Billing/ })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(focusMock.activate).toHaveBeenCalledWith('f3');
    expect(focusMock.create).not.toHaveBeenCalled();

    fireEvent.click(pill());
    const again = within(popover()).getByLabelText('Filter or create');
    fireEvent.change(again, { target: { value: 'Checkout flow' } });
    expect(within(popover()).getByRole('button', { name: 'Create “Checkout flow”' })).toBeInTheDocument();
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(focusMock.create).toHaveBeenCalledWith('Checkout flow');
  });

  it('New focus in the footer switches the field to naming mode', () => {
    render(<SidebarBody {...props()} />);
    fireEvent.click(pill());
    fireEvent.click(within(popover()).getByRole('button', { name: /New focus/ }));
    const input = within(popover()).getByLabelText('New focus name');
    fireEvent.change(input, { target: { value: 'Infra' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(focusMock.create).toHaveBeenCalledWith('Infra');
  });

  it('renames inline and deletes from a row\'s right-click menu, confirming when the Focus has members', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SidebarBody {...props()} />);
    fireEvent.click(pill());
    fireEvent.contextMenu(within(popover()).getByRole('button', { name: /Onboarding/ }), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const field = within(popover()).getByLabelText('Rename Onboarding');
    fireEvent.change(field, { target: { value: 'Signup' } });
    fireEvent.submit(field.closest('form')!);
    expect(focusMock.rename).toHaveBeenCalledWith('f2', 'Signup');

    fireEvent.contextMenu(within(popover()).getByRole('button', { name: /Perf/ }), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete focus' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('2 worktrees stay'));
    expect(focusMock.remove).toHaveBeenCalledWith('f3');
    confirmSpy.mockRestore();
  });

  it('offers All worktrees only when the page exists, and Escape closes', () => {
    const onAllWorktrees = vi.fn();
    const { unmount } = render(<SidebarBody {...props()} />);
    fireEvent.click(pill());
    expect(within(popover()).queryByRole('button', { name: 'All worktrees' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Switch focus' })).toBeNull();
    unmount();
    render(<SidebarBody {...props({ onAllWorktrees })} />);
    fireEvent.click(pill());
    fireEvent.click(within(popover()).getByRole('button', { name: 'All worktrees' }));
    expect(onAllWorktrees).toHaveBeenCalled();
  });
});
