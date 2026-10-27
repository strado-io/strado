import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, Worktree } from '../../types';
import type { Focus, RemoteWorktree } from '../../api';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { publishTickets } from '../../hooks/tickets';
import { SidebarBody, type SidebarBodyProps } from './SidebarBody';
import type { FocusJarvisHeader } from './FocusList';
import { resetEditorsCache } from '../../hooks/editors';

vi.mock('../../hooks/mrSummaries', () => ({ useMrSummaries: vi.fn(() => new Map()) }));
const editorsApi = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn() }));
vi.mock('../../api', () => ({ api: { tickets: { myIssues: vi.fn(async () => []) }, editors: editorsApi } }));

// The Focus list is a shared server-backed store; here it is a plain in-memory
// one so each test can say which Focuses exist and which is active.
const focusMock = vi.hoisted(() => ({
  focuses: [] as { id: string; name: string; members: string[]; createdAt: string; lastActiveAt: string; ticket?: { provider: 'jira' | 'linear'; key: string } }[],
  activeId: null as string | null,
  activate: vi.fn(), create: vi.fn(), rename: vi.fn(), setMembership: vi.fn(), addMembers: vi.fn(), remove: vi.fn(),
}));
vi.mock('../../hooks/useFocuses', () => ({
  useFocuses: () => ({
    focuses: focusMock.focuses, loaded: true, activeId: focusMock.activeId,
    active: focusMock.focuses.find((f) => f.id === focusMock.activeId) ?? null,
    activate: focusMock.activate, create: focusMock.create, rename: focusMock.rename,
    setMembership: focusMock.setMembership, addMembers: focusMock.addMembers, remove: focusMock.remove,
  }),
}));
const focus = (id: string, name: string, members: string[] = [], lastActiveAt = '2026-01-01', createdAt = '2026-01-01'): Focus =>
  ({ id, name, members, createdAt, lastActiveAt });
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
    onWorktreeSettings: vi.fn(), onDeleteWorktree: vi.fn(),
    ...over,
  };
}
const list = () => screen.getByRole('region', { name: 'Focuses' });
const openHeader = () => within(screen.getByTestId('focus-open')).getByRole('heading');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem('strado:focus-expanded', JSON.stringify(['f1'])); // these tests read the cards: expanded
  sessionStorage.setItem('strado:focus-expanded-for', 'f1'); // ...as left with f1 active
  focusMock.focuses = [];
  focusMock.activeId = null;
  for (const fn of [focusMock.activate, focusMock.create, focusMock.rename, focusMock.setMembership, focusMock.addMembers, focusMock.remove]) fn.mockReset();
  focusMock.addMembers.mockResolvedValue(undefined);
  focusMock.setMembership.mockResolvedValue(undefined);
  focusMock.create.mockResolvedValue(focus('new', 'New'));
  focusMock.rename.mockResolvedValue(undefined);
  focusMock.remove.mockResolvedValue(undefined);
  vi.mocked(useMrSummaries).mockReturnValue(new Map());
  resetEditorsCache();
  editorsApi.list.mockReset().mockRejectedValue(new Error('down'));
  editorsApi.open.mockReset();
});

describe('SidebarBody: the active Focus', () => {
  it('opens the active Focus under its name and shows its worktrees as cards, in member order, skipping ids that resolve to nothing', () => {
    withFocus('local:/r2/other', 'local:/gone', 'local:/r1/wt');
    render(<SidebarBody {...props()} />);
    expect(openHeader()).toHaveTextContent(/^Billing$/); // just the Focus's name
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

  it('agent state: tinted session faces on the card (said to assistive tech too), the PR with its number, and an amber edge while one waits', () => {
    withFocus('local:/r1/wt', 'local:/r2/wt');
    const working = { ...wt('/r1/wt', 'r1'), claudeStatus: 'working', hasClaudeSession: true, claudeSessions: ['1'] } as Worktree;
    const waiting = { ...wt('/r2/wt', 'r2'), claudeStatus: 'waiting', hasClaudeSession: true, claudeSessions: ['1'] } as Worktree;
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r1/wt', { state: 'open', updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    render(<SidebarBody {...props({ worktrees: [working, waiting] })} />);
    const cards = screen.getAllByRole('button', { name: 'fx-412' }).map((b) => b.closest('.group') as HTMLElement);
    expect(within(cards[0]!).getByRole('status', { name: 'agent working' })).toBeInTheDocument();
    expect(within(cards[0]!).getByTestId('pr-status-/r1/wt')).toBeInTheDocument();
    expect(within(cards[1]!).getByRole('status', { name: 'agent waiting' })).toBeInTheDocument();
    const faces = (card: HTMLElement) => card.querySelectorAll('[data-session-avatar]');
    expect(faces(cards[0]!)[0]).toHaveAttribute('data-state', 'working');
    expect(faces(cards[1]!)[0]).toHaveAttribute('data-state', 'waiting');
    expect(cards[1]!).toHaveAttribute('data-waiting', 'true');
    expect(cards[0]!).not.toHaveAttribute('data-waiting');
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
    expect(within(card).getAllByText('fx-412')).toHaveLength(1); // the branch line repeating the title is hidden
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

  it('Open in <editor>: in a local card\'s menu, opens the worktree; a failure reports fixed words', async () => {
    editorsApi.list.mockResolvedValue({ preferred: null, editors: [{ id: 'zed', label: 'Zed', available: true, lines: true }] });
    editorsApi.open.mockResolvedValue(undefined);
    withFocus('local:/r1/wt');
    const onError = vi.fn();
    render(<SidebarBody {...props({ onError })} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'fx-412 actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Zed' }));
    expect(editorsApi.open).toHaveBeenCalledWith('w1', { worktreePath: '/r1/wt', editor: 'zed' });
    editorsApi.open.mockRejectedValue(new Error('spawn zed ENOENT /secret'));
    fireEvent.click(screen.getByRole('button', { name: 'fx-412 actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Zed' }));
    await act(async () => {});
    expect(onError).toHaveBeenCalledWith("Couldn't open the editor");
  });

  it('a runner worktree\'s menu has no Open in <editor>', async () => {
    editorsApi.list.mockResolvedValue({ preferred: null, editors: [{ id: 'zed', label: 'Zed', available: true, lines: true }] });
    const remote = {
      runnerId: 'rn1', runnerName: 'gpu-box', wsBase: 'wss://rn1', remoteWsId: 'default',
      path: '/srv/wt/FX-77', name: 'FX-77', branch: 'fx-77', head: 'h', remoteRepoId: null,
      isRepoRoot: false, cloneUrl: null, localRepoId: 'r1', remoteRepoName: null,
    } as RemoteWorktree;
    withFocus('remote:rn1:/srv/wt/FX-77');
    render(<SidebarBody {...props({ remoteWorktrees: [remote], runnerStatuses: [{ runnerId: 'rn1', name: 'gpu-box', online: true, error: null }] as never })} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'fx-77 on gpu-box actions' }));
    expect(screen.queryByRole('button', { name: 'Open in Zed' })).toBeNull();
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

  it('with no Focus, nothing is open and New focus below the list opens the composer', () => {
    render(<SidebarBody {...props()} />);
    expect(screen.queryByTestId('focus-open')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New focus' }));
    expect(screen.getByRole('dialog', { name: 'New focus' })).toBeInTheDocument();
  });

  const header = (over: Partial<FocusJarvisHeader> = {}): FocusJarvisHeader => ({
    status: <span role="img" aria-label="working">✦</span>, latest: <div data-testid="latest">Here is what we did</div>, selected: false, onOpen: vi.fn(), ...over,
  });

  it('the open Focus\'s header is its Jarvis: status and latest reply; no Jarvis card in the panel, only worktree cards', () => {
    withFocus('local:/r1/wt');
    render(<SidebarBody {...props({ jarvis: header() })} />);
    const h = screen.getByTestId('focus-header');
    expect(within(h).getByRole('img', { name: 'working' })).toBeInTheDocument();
    expect(within(h).getByTestId('latest')).toHaveTextContent('Here is what we did');
    const group = screen.getByTestId('focus-group');
    expect(within(group).getByRole('button', { name: 'fx-412' })).toBeInTheDocument();
    expect(within(group).queryByTestId('latest')).toBeNull();
  });

  it('clicking the header opens the chat; the chevron only folds the cards; ⋯ only opens its menu', () => {
    withFocus('local:/r1/wt');
    const onOpen = vi.fn();
    render(<SidebarBody {...props({ jarvis: header({ onOpen }) })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fold Billing' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByTestId('focus-group')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show Billing' }));
    expect(screen.getByTestId('focus-group')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Billing actions' }));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Billing' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('latest'));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('the whole active row toggles once the chat shows; before that, its first click shows the chat and folds nothing; ⋯ never toggles', () => {
    withFocus('local:/r1/wt');
    const onOpen = vi.fn();
    const { rerender } = render(<SidebarBody {...props({ jarvis: header({ onOpen, selected: false }) })} />);
    const name = () => screen.getByRole('button', { name: 'Billing' });
    expect(name()).toHaveAttribute('aria-expanded', 'true');
    // A worktree is open: the click shows the chat, the panel stays.
    fireEvent.click(screen.getByTestId('latest'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('focus-group')).toBeInTheDocument();
    // The chat shows: a click anywhere on the row folds, and again expands.
    rerender(<SidebarBody {...props({ jarvis: header({ onOpen, selected: true }) })} />);
    fireEvent.click(screen.getByTestId('latest'));
    expect(screen.queryByTestId('focus-group')).toBeNull();
    expect(name()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByTestId('focus-header'));
    expect(screen.getByTestId('focus-group')).toBeInTheDocument();
    expect(name()).toHaveAttribute('aria-expanded', 'true');
    // Enter or Space on the name button is its click, so the row's.
    fireEvent.click(name());
    expect(name()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(name());
    expect(onOpen).toHaveBeenCalledTimes(1);
    // ⋯ opens its menu only.
    fireEvent.click(screen.getByRole('button', { name: 'Billing actions' }));
    expect(screen.getByTestId('focus-group')).toBeInTheDocument();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('an inactive row still activates and expands that Focus, alone', () => {
    focusMock.focuses = [focus('f1', 'Billing', ['local:/r1/wt']), focus('f2', 'Perf', [])];
    focusMock.activeId = 'f1';
    const { rerender } = render(<SidebarBody {...props({ jarvis: header() })} />);
    focusMock.activate.mockImplementation((id: string) => { focusMock.activeId = id; });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Perf' }));
    rerender(<SidebarBody {...props({ jarvis: header() })} />);
    expect(screen.getAllByTestId('focus-group')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Perf' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('while the chat shows, the header reads as selected', () => {
    withFocus('local:/r1/wt');
    const { rerender } = render(<SidebarBody {...props({ jarvis: header() })} />);
    expect(screen.getByTestId('focus-header')).not.toHaveAttribute('data-selected');
    rerender(<SidebarBody {...props({ jarvis: header({ selected: true }) })} />);
    expect(screen.getByTestId('focus-header')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('focus-header').className).toMatch(/bg-\[rgb\(var\(--pane-edge\)\/0\.08\)\]/);
  });

  it('a blank Focus: the header, and only the Add/New rows in its panel', () => {
    focusMock.focuses = [focus('f1', 'Billing')];
    focusMock.activeId = 'f1';
    render(<SidebarBody {...props({ jarvis: header() })} />);
    expect(screen.getByTestId('focus-header')).toBeInTheDocument();
    const group = screen.getByTestId('focus-group');
    expect(within(group).getByRole('button', { name: 'Add worktrees' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'New worktree here' })).toBeInTheDocument();
  });

  it('the empty Focus offers Add worktrees (a picker that adds the checked ones) and New worktree here (with its ticket)', () => {
    focusMock.focuses = [{ ...focus('f1', 'Billing'), ticket: { provider: 'jira', key: 'FD-9' } }];
    focusMock.activeId = 'f1';
    const onNewWorktree = vi.fn();
    render(<SidebarBody {...props({ onNewWorktree })} />);
    fireEvent.click(screen.getByRole('button', { name: 'New worktree here' }));
    expect(onNewWorktree).toHaveBeenCalledWith({ provider: 'jira', key: 'FD-9' });
    fireEvent.click(screen.getByRole('button', { name: 'Add worktrees' }));
    const dialog = screen.getByRole('dialog', { name: 'Add worktrees to Billing' });
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'api' })).getByRole('checkbox', { name: 'fx-412' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1' }));
    expect(focusMock.addMembers).toHaveBeenCalledWith('f1', ['local:/r1/wt']);
    expect(screen.queryByRole('dialog', { name: 'Add worktrees to Billing' })).toBeNull();
  });

  it('the open Focus\'s ⋯ menu: New worktree here (with its ticket) and Add worktrees; no Search or Add repo button', () => {
    focusMock.focuses = [{ ...focus('f1', 'Billing', ['local:/r1/wt']), ticket: { provider: 'jira', key: 'FD-9' } }];
    focusMock.activeId = 'f1';
    const onNewWorktree = vi.fn();
    render(<SidebarBody {...props({ onNewWorktree })} />);
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add repo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Billing actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'New worktree here…' }));
    expect(onNewWorktree).toHaveBeenCalledWith({ provider: 'jira', key: 'FD-9' });
    fireEvent.click(screen.getByRole('button', { name: 'Billing actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add worktrees…' }));
    expect(screen.getByRole('dialog', { name: 'Add worktrees to Billing' })).toBeInTheDocument();
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

  it('the new-focus event (⇧⌘N, the hub gate) opens the composer, seeded with the worktree being opened', () => {
    render(<SidebarBody {...props()} />);
    fireEvent(window, new CustomEvent('strado:new-focus', { detail: { seedPinId: 'local:/r2/other' } }));
    const dialog = screen.getByRole('dialog', { name: 'New focus' });
    expect(within(dialog).getByLabelText('Focus name')).toHaveValue('fx-412');
    expect(within(dialog).getByRole('checkbox', { name: 'fx-412', checked: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & switch' }));
    expect(focusMock.create).toHaveBeenCalledWith('fx-412', ['local:/r2/other'], undefined);
  });
});

describe('SidebarBody: the Focus accordion', () => {
  beforeEach(() => {
    focusMock.focuses = [
      // Created Billing, Onboarding, Perf; last used Onboarding, Billing, Perf.
      focus('f1', 'Billing', ['local:/r1/wt'], '2026-02-01', '2025-12-01'),
      focus('f2', 'Onboarding', [], '2026-03-01', '2025-12-02'),
      focus('f3', 'Perf', ['local:/r2/wt', 'local:/r2/other'], '2026-01-01', '2025-12-03'),
    ];
    focusMock.activeId = 'f1';
  });
  const rowNames = () => within(list()).getAllByRole('button', { name: /^Switch to / }).map((b) => b.getAttribute('aria-label')!.replace('Switch to ', ''));

  it('only the active Focus is open; every other one is a row, in creation order', () => {
    render(<SidebarBody {...props()} />);
    expect(screen.getAllByTestId('focus-open')).toHaveLength(1);
    expect(openHeader()).toHaveTextContent('Billing');
    expect(within(screen.getByTestId('focus-open')).getByRole('button', { name: 'fx-412' })).toBeInTheDocument();
    expect(rowNames()).toEqual(['Onboarding', 'Perf']);
  });

  it('clicking a row activates that Focus (the Dashboard hears it first, to open its Jarvis)', () => {
    const calls: string[] = [];
    focusMock.activate.mockImplementation((id: string) => calls.push(`activate ${id}`));
    render(<SidebarBody {...props({ onOpenFocus: (id) => calls.push(`open ${id}`) })} />);
    fireEvent.click(within(list()).getByRole('button', { name: 'Switch to Perf' }));
    expect(calls).toEqual(['open f3', 'activate f3']);
  });

  // Each Focus's own panel (its worktree cards), or null while it is folded.
  const panelOf = (name: string) => {
    const header = screen.queryByRole('button', { name: `Switch to ${name}` }) ?? screen.getByRole('heading', { name });
    return within(header.closest('[data-focus-item]') as HTMLElement).queryByTestId('focus-group');
  };

  it('switching is the accordion: the new active Focus alone is expanded', () => {
    const { rerender } = render(<SidebarBody {...props()} />);
    focusMock.activeId = 'f3';
    rerender(<SidebarBody {...props()} />);
    expect(openHeader()).toHaveTextContent('Perf');
    expect(rowNames()).toEqual(['Billing', 'Onboarding']);
    expect(panelOf('Perf')).not.toBeNull();
    expect(panelOf('Billing')).toBeNull();
    expect(screen.getAllByTestId('focus-group')).toHaveLength(1);
  });

  it('clicking B activates it, opens its chat, expands it and collapses A; the order stays', () => {
    const onOpenFocus = vi.fn();
    const { rerender } = render(<SidebarBody {...props({ onOpenFocus })} />);
    expect(panelOf('Billing')).not.toBeNull();
    focusMock.activate.mockImplementation((id: string) => { focusMock.activeId = id; });
    fireEvent.click(within(list()).getByRole('button', { name: 'Switch to Perf' }));
    expect(onOpenFocus).toHaveBeenCalledWith('f3');
    rerender(<SidebarBody {...props({ onOpenFocus })} />);
    expect(panelOf('Perf')).not.toBeNull();
    expect(panelOf('Billing')).toBeNull();
    fireEvent.click(within(list()).getByRole('button', { name: 'Switch to Billing' }));
    rerender(<SidebarBody {...props({ onOpenFocus })} />);
    expect(panelOf('Billing')).not.toBeNull();
    expect(panelOf('Perf')).toBeNull();
    expect(rowNames()).toEqual(['Onboarding', 'Perf']);
    expect(openHeader()).toHaveTextContent('Billing');
  });

  it('after peeking with chevrons, clicking the active header shows its chat and leaves the panels as they are', () => {
    const onOpen = vi.fn();
    render(<SidebarBody {...props({ jarvis: { status: null, latest: null, selected: false, onOpen } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Perf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show Onboarding' }));
    expect(screen.getAllByTestId('focus-group')).toHaveLength(3);
    fireEvent.click(screen.getByTestId('focus-header'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('focus-group')).toHaveLength(3);
    expect(panelOf('Billing')).not.toBeNull();
  });

  it('the chevron expands a Focus and does not activate it; several can be expanded at once', () => {
    const onOpenFocus = vi.fn();
    render(<SidebarBody {...props({ onOpenFocus })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Perf' }));
    expect(focusMock.activate).not.toHaveBeenCalled();
    expect(onOpenFocus).not.toHaveBeenCalled();
    expect(within(panelOf('Perf')!).getAllByRole('button', { name: 'fx-412' })).toHaveLength(2);
    expect(panelOf('Billing')).not.toBeNull();
    expect(screen.getAllByTestId('focus-group')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Fold Perf' }));
    expect(panelOf('Perf')).toBeNull();
    expect(focusMock.activate).not.toHaveBeenCalled();
  });

  it('what is expanded survives a reload, per window', () => {
    const { unmount } = render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Onboarding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fold Billing' }));
    unmount();
    render(<SidebarBody {...props()} />);
    expect(panelOf('Onboarding')).not.toBeNull();
    expect(panelOf('Billing')).toBeNull();
    expect(panelOf('Perf')).toBeNull();
  });

  it('a new window opens with the active Focus expanded, alone', () => {
    sessionStorage.removeItem('strado:focus-expanded');
    sessionStorage.removeItem('strado:focus-expanded-for');
    render(<SidebarBody {...props()} />);
    expect(screen.getAllByTestId('focus-group')).toHaveLength(1);
    expect(panelOf('Billing')).not.toBeNull();
  });

  it('a switch made while the sidebar was not mounted is applied when it comes back', () => {
    sessionStorage.setItem('strado:focus-expanded', JSON.stringify(['f1']));
    focusMock.activeId = 'f3'; // the state was left for f1
    render(<SidebarBody {...props()} />);
    expect(panelOf('Perf')).not.toBeNull();
    expect(panelOf('Billing')).toBeNull();
  });

  it('the active Focus folded is still clearly the current one: its two-line header, with status and latest reply', () => {
    sessionStorage.setItem('strado:focus-expanded', '[]');
    render(<SidebarBody {...props({ jarvis: { status: <span role="img" aria-label="needs approval">⚠</span>, latest: <div data-testid="latest">Approve the deploy?</div>, selected: true, onOpen: vi.fn() } })} />);
    const h = screen.getByTestId('focus-header');
    expect(h).toHaveAttribute('data-selected', 'true');
    expect(within(h).getByRole('img', { name: 'needs approval' })).toBeInTheDocument();
    expect(within(h).getByTestId('latest')).toHaveTextContent('Approve the deploy?');
    expect(panelOf('Billing')).toBeNull();
  });

  it('a card in an expanded Focus that is not the active one activates that Focus, then opens', async () => {
    const calls: string[] = [];
    focusMock.activate.mockImplementation((id: string) => calls.push(`activate ${id}`));
    const onOpenWorktree = vi.fn((w: Worktree) => calls.push(`open ${w.path}`));
    render(<SidebarBody {...props({ onOpenWorktree })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Perf' }));
    fireEvent.click(within(panelOf('Perf')!).getAllByRole('button', { name: 'fx-412' })[0]!);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toEqual(['activate f3', 'open /r2/wt']);
    // In the active Focus, a card just opens.
    fireEvent.click(within(panelOf('Billing')!).getByRole('button', { name: 'fx-412' }));
    expect(calls).toEqual(['activate f3', 'open /r2/wt', 'open /r1/wt']);
  });

  it('badges: approvals waiting, an unread reply; agent faces stay on the worktree cards, not the Focus', () => {
    const working = { ...wt('/r2/wt', 'r2'), claudeStatus: 'working', hasClaudeSession: true, claudeSessions: ['1'] } as Worktree;
    render(<SidebarBody {...props({
      worktrees: [wt('/r1/wt', 'r1'), working, wt('/r2/other', 'r2')],
      jarvisBadges: new Map([['f2', { pendingApprovals: 2, unread: true }], ['f3', { pendingApprovals: 0, unread: false }]]),
    })} />);
    const perf = within(list()).getByRole('button', { name: 'Switch to Perf' });
    expect(within(perf).queryByTestId('focus-agents-f3')).toBeNull();
    expect(within(perf).queryByRole('img', { name: /waiting for approval/ })).toBeNull();
    const onboarding = within(list()).getByRole('button', { name: 'Switch to Onboarding' });
    expect(within(onboarding).getByRole('img', { name: '2 waiting for approval' })).toBeInTheDocument();
    expect(within(onboarding).getByRole('img', { name: 'new reply from Jarvis' })).toBeInTheDocument();
    expect(within(onboarding).queryByTestId('focus-agents-f2')).toBeNull();
  });

  it('clicking a Focus does not move it: activating touches its last-active time, never its place', () => {
    const order = () => within(list()).getAllByRole('heading').concat(within(list()).getAllByRole('button', { name: /^Switch to / }))
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((el) => el.getAttribute('aria-label')?.replace('Switch to ', '') ?? el.textContent);
    const { rerender } = render(<SidebarBody {...props()} />);
    expect(order()).toEqual(['Billing', 'Onboarding', 'Perf']);
    fireEvent.click(within(list()).getByRole('button', { name: 'Switch to Perf' }));
    // As useFocuses does: Perf becomes active and the server stamps it as just used.
    focusMock.focuses = focusMock.focuses.map((f) => (f.id === 'f3' ? { ...f, lastActiveAt: '2026-09-01' } : f));
    focusMock.activeId = 'f3';
    rerender(<SidebarBody {...props()} />);
    expect(order()).toEqual(['Billing', 'Onboarding', 'Perf']);
  });

  it('a new Focus is appended at the bottom', () => {
    const { rerender } = render(<SidebarBody {...props()} />);
    focusMock.focuses = [...focusMock.focuses, focus('f0', 'Alpha', [], '2026-09-01', '2026-09-01')];
    rerender(<SidebarBody {...props()} />);
    expect(rowNames()).toEqual(['Onboarding', 'Perf', 'Alpha']);
  });

  it('the first six in creation order, then Show all (N); the active one always shows, however far down', () => {
    // Created g0…g8 in order; last used the other way round.
    focusMock.focuses = Array.from({ length: 9 }, (_, i) => focus(`g${i}`, `F${i}`, [], `2026-0${9 - i}-01`, `2025-0${i + 1}-01`));
    focusMock.activeId = 'g8'; // the newest, beyond the six
    render(<SidebarBody {...props()} />);
    expect(rowNames()).toEqual(['F0', 'F1', 'F2', 'F3', 'F4', 'F5']);
    expect(openHeader()).toHaveTextContent('F8');
    fireEvent.click(screen.getByRole('button', { name: 'Show all (9)' }));
    expect(rowNames()).toEqual(['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(rowNames()).toHaveLength(6);
  });

  it('the list has no header of its own (New focus is the workspace row\'s +)', () => {
    render(<SidebarBody {...props()} />);
    expect(within(list()).queryByRole('button', { name: 'New focus' })).toBeNull();
    expect(within(list()).queryByText(/^Focuses$/i)).toBeNull();
  });

  it('the open Focus renames inline and deletes from its ⋯ menu, confirming when it has members', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Billing actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('Rename Billing');
    fireEvent.change(field, { target: { value: 'Payments' } });
    fireEvent.submit(field.closest('form')!);
    expect(focusMock.rename).toHaveBeenCalledWith('f1', 'Payments');
    fireEvent.click(screen.getByRole('button', { name: 'Billing actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete focus' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('1 worktree stay'));
    expect(focusMock.remove).toHaveBeenCalledWith('f1');
    confirmSpy.mockRestore();
  });

  it('the ⇧⌘N event opens the composer', () => {
    render(<SidebarBody {...props()} />);
    act(() => { window.dispatchEvent(new Event('strado:new-focus')); });
    expect(screen.getByRole('dialog', { name: 'New focus' })).toBeInTheDocument();
  });
});
