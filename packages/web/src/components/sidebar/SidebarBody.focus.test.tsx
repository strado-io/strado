import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FocusGroup } from '../../api';
import type { RepoConfig, Worktree } from '../../types';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { useFocusGroups } from '../../hooks/useFocusGroups';
import { publishTickets } from '../../hooks/tickets';
import { SidebarBody, type SidebarBodyProps } from './SidebarBody';

vi.mock('../../hooks/mrSummaries', () => ({ useMrSummaries: vi.fn(() => new Map()) }));
vi.mock('../../hooks/useFocusGroups', () => ({ useFocusGroups: vi.fn() }));

const r1 = { id: 'r1', name: 'api', path: '/r1' } as RepoConfig;
const r2 = { id: 'r2', name: 'web', path: '/r2' } as RepoConfig;
const wt = (path: string, repoId: string): Worktree => ({
  path, repoId, branch: 'fx-412', meta: null, diffStats: null,
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false },
} as Worktree);
const group: FocusGroup = { id: 'g1', name: 'FX-412', members: ['local:/r1/wt', 'local:/r2/wt'], createdAt: 't' };
const focus = {
  groups: [group], loaded: true,
  create: vi.fn(), rename: vi.fn(() => Promise.resolve()), setMembership: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()), setState: vi.fn(() => Promise.resolve()),
};

function props(over: Partial<SidebarBodyProps> = {}): SidebarBodyProps {
  return {
    wsId: 'w1', repos: [r1, r2], worktrees: [wt('/r1/wt', 'r1'), wt('/r2/wt', 'r2'), wt('/r2/other', 'r2')],
    remoteWorktrees: [], runnerStatuses: [],
    onAddRepo: vi.fn(), onOpenWorktree: vi.fn(), activeWorktreePath: null, onNewWorktree: vi.fn(),
    onWorktreeSettings: vi.fn(), onDeleteWorktree: vi.fn(), onSearch: vi.fn(), onShowParked: vi.fn(),
    ...over,
  };
}
// Loose rows come from storage, the way the Dashboard adds them.
const loose = (...ids: string[]) => localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ w1: ids }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(useMrSummaries).mockReturnValue(new Map());
  vi.mocked(useFocusGroups).mockReturnValue(focus);
  focus.setMembership.mockClear();
  focus.create.mockReset();
  focus.rename.mockClear();
  focus.setState.mockClear();
});


describe('SidebarBody: Working on and Settled only', () => {
  it('shows groups with their members under Working on, and no Repos or Pinned sections', () => {
    render(<SidebarBody {...props()} />);
    const working = screen.getByRole('region', { name: 'Working on' });
    const g = within(working).getByRole('group', { name: 'FX-412' });
    expect(within(g).getByText('api')).toBeInTheDocument();
    expect(within(g).getByText('web')).toBeInTheDocument();
    expect(screen.queryByText('Repos')).not.toBeInTheDocument();
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pin / })).not.toBeInTheDocument();
  });

  it('puts loose worktrees above the groups and ignores a loose id that no longer exists', () => {
    loose('local:/r2/other', 'local:/gone');
    render(<SidebarBody {...props()} />);
    const working = screen.getByRole('region', { name: 'Working on' });
    const row = within(working).getAllByText('fx-412')[0]!; // /r2/other's branch label
    const g = within(working).getByRole('group', { name: 'FX-412' });
    expect(row.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(working).getAllByRole('button', { name: 'fx-412' })).toHaveLength(3); // 1 loose + 2 members
  });

  it('removes a loose row from its menu, leaving the worktree alone', () => {
    loose('local:/r2/other');
    const onDeleteWorktree = vi.fn();
    render(<SidebarBody {...props({ onDeleteWorktree })} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'fx-412 actions' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Working on' }));
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: [] });
    expect(onDeleteWorktree).not.toHaveBeenCalled();
  });

  it('parks a group from its menu and counts it in the header', () => {
    const parked: FocusGroup = { id: 'g2', name: 'FX-900', members: ['local:/r2/other'], createdAt: 't', state: 'parked' };
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [group, parked] });
    const onShowParked = vi.fn();
    render(<SidebarBody {...props({ onShowParked })} />);
    expect(screen.queryByRole('group', { name: 'FX-900' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 more' }));
    expect(onShowParked).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'FX-412 group actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Park' }));
    expect(focus.setState).toHaveBeenCalledWith('g1', 'parked');
  });

  it('does not count a parked group that has settled as "more"', () => {
    const parked: FocusGroup = { id: 'g2', name: 'FX-900', members: ['local:/r2/other'], createdAt: 't', state: 'parked' };
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [group, parked] });
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r2/other', { state: 'merged', updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    render(<SidebarBody {...props()} />);
    expect(screen.queryByRole('button', { name: /more$/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Settled' })).getByRole('group', { name: 'FX-900' })).toBeInTheDocument();
  });

  it('removes a member from its group via the row menu', async () => {
    render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'fx-412 actions' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from group' }));
    expect(focus.setMembership).toHaveBeenCalledWith('g1', 'local:/r1/wt', false);
    // It was in no other group, so it lands in the loose rows (covered below).
    await waitFor(() => expect(localStorage.getItem('strado:pinned-worktrees-by-ws')).not.toBeNull());
  });

  it('removing a member that no other group holds keeps it in Working on as a loose row', async () => {
    const { rerender } = render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'fx-412 actions' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from group' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: ['local:/r1/wt'] }));
    // The server's answer: the group no longer holds it.
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [{ ...group, members: ['local:/r2/wt'] }] });
    rerender(<SidebarBody {...props()} />);
    const working = screen.getByRole('region', { name: 'Working on' });
    const g = within(working).getByRole('group', { name: 'FX-412' });
    expect(within(g).queryByText('api')).toBeNull();
    expect(within(working).getByText('api')).toBeInTheDocument();
  });

  it('removing a member that another open group holds adds no loose row', async () => {
    const other: FocusGroup = { id: 'g2', name: 'FX-500', members: ['local:/r1/wt'], createdAt: 't' };
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [group, other] });
    render(<SidebarBody {...props()} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'FX-412' })).getAllByRole('button', { name: 'fx-412 actions' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from group' }));
    await waitFor(() => expect(focus.setMembership).toHaveBeenCalledWith('g1', 'local:/r1/wt', false));
    await new Promise((r) => setTimeout(r, 0)); // let the removal settle
    expect(localStorage.getItem('strado:pinned-worktrees-by-ws')).toBeNull();
  });

  it('dates a card by when it was last opened here, and a settled card by its PR', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    localStorage.setItem('strado:worktree-lru', JSON.stringify({ '/r2/other': twoHoursAgo }));
    loose('local:/r2/other');
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r1/wt', { state: 'merged', mergedAt: new Date(Date.now() - 3 * 86400000).toISOString(), updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    render(<SidebarBody {...props()} />);
    const working = screen.getByRole('region', { name: 'Working on' });
    const looseCard = within(working).getAllByText('fx-412')[0]!.closest('.group') as HTMLElement;
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
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    render(<SidebarBody {...props({ worktrees: [ticketed, pr] })} />);
    expect(screen.getByRole('button', { name: 'FD-9' })).toHaveTextContent('Fix login redirect');
    expect(screen.getByRole('button', { name: 'feat/x' })).toHaveTextContent('Add rate limiting');
  });

  it('shows the empty state when nothing is being worked on', () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    render(<SidebarBody {...props()} />);
    expect(screen.getByText('Nothing yet. Search to open a worktree, or ✎ to start one.')).toBeInTheDocument();
  });

  it('toolbar: Search opens the palette and New group opens the dialog', () => {
    const onSearch = vi.fn();
    render(<SidebarBody {...props({ onSearch })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    expect(screen.getByRole('dialog', { name: 'New group' })).toBeInTheDocument();
  });

  it('adding a worktree to a parked group brings the group back', async () => {
    const parked: FocusGroup = { id: 'g2', name: 'FX-900', members: [], createdAt: 't', state: 'parked' };
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [group, parked] });
    render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'fx-412 actions' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Add to group…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add to group' })).getByRole('checkbox', { name: 'FX-900' }));
    expect(focus.setMembership).toHaveBeenCalledWith('g2', 'local:/r1/wt', true);
    await waitFor(() => expect(focus.setState).toHaveBeenCalledWith('g2', 'working'));
  });

  it('does not promote a parked group when adding to it fails', async () => {
    const parked: FocusGroup = { id: 'g2', name: 'FX-900', members: [], createdAt: 't', state: 'parked' };
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [group, parked] });
    focus.setMembership.mockRejectedValueOnce(new Error('offline'));
    const onError = vi.fn();
    render(<SidebarBody {...props({ onError })} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'fx-412 actions' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Add to group…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add to group' })).getByRole('checkbox', { name: 'FX-900' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('offline'));
    expect(focus.setState).not.toHaveBeenCalled();
  });

  it('shows a loose id that an open group already holds only as a member', () => {
    loose('local:/r1/wt');
    render(<SidebarBody {...props()} />);
    const working = screen.getByRole('region', { name: 'Working on' });
    expect(within(working).getAllByRole('button', { name: 'fx-412' })).toHaveLength(2);
    const g = within(working).getByRole('group', { name: 'FX-412' });
    expect(within(g).getAllByRole('button', { name: 'fx-412' })).toHaveLength(2);
  });

  // Opens the picker on a loose worktree that no group holds, and creates a group from it by name.
  const createFromLoosePicker = (over: Partial<SidebarBodyProps> = {}) => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    loose('local:/r1/wt');
    render(<SidebarBody {...props(over)} />);
    fireEvent.click(screen.getByRole('button', { name: 'fx-412 actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to group…' }));
    const input = within(screen.getByRole('dialog', { name: 'Add to group' })).getByRole('textbox', { name: 'Find or create a group' });
    fireEvent.change(input, { target: { value: 'Fresh' } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  it('creating a group from the picker takes the worktree out of the loose rows once it exists', async () => {
    let resolveCreate!: (g: FocusGroup) => void;
    focus.create.mockReturnValue(new Promise<FocusGroup>((r) => { resolveCreate = r; }));
    createFromLoosePicker();
    expect(focus.create).toHaveBeenCalledWith('Fresh', ['local:/r1/wt']);
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: ['local:/r1/wt'] });
    resolveCreate({ ...group, id: 'g9', name: 'Fresh' });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: [] }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:focus-group-active')!)).toEqual({ w1: 'g9' }));
  });

  it('keeps the loose row when creating a group from the picker fails', async () => {
    focus.create.mockRejectedValue(new Error('disk full'));
    const onError = vi.fn();
    createFromLoosePicker({ onError });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('disk full'));
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: ['local:/r1/wt'] });
  });

  it('folds a group from its header', () => {
    render(<SidebarBody {...props()} />);
    const g = screen.getByRole('group', { name: 'FX-412' });
    fireEvent.click(within(g).getByRole('button', { name: /FX-412/, expanded: true }));
    expect(within(g).queryByText('api')).not.toBeInTheDocument();
  });

  it('opening a member makes its group the active one', () => {
    const onOpenWorktree = vi.fn();
    render(<SidebarBody {...props({ onOpenWorktree })} />);
    const g = screen.getByRole('group', { name: 'FX-412' });
    fireEvent.click(within(g).getAllByText('fx-412')[0]!);
    expect(onOpenWorktree).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('strado:focus-group-active')!)).toEqual({ w1: 'g1' });
  });

  it('renames a group from its menu', () => {
    render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'FX-412 group actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    const input = screen.getByRole('textbox', { name: 'Group name' });
    fireEvent.change(input, { target: { value: 'FX-413' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(focus.rename).toHaveBeenCalledWith('g1', 'FX-413');
  });

  it('moves a merged group out of Working on into Settled at the bottom', () => {
    const shipped: FocusGroup = { id: 'g2', name: 'FX-300', members: ['local:/r2/other'], createdAt: 't' };
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [group, shipped] });
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r2/other', { state: 'merged', updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    render(<SidebarBody {...props()} />);
    const groups = screen.getByRole('region', { name: 'Working on' });
    const settled = screen.getByRole('region', { name: 'Settled' });
    expect(within(groups).getByRole('group', { name: 'FX-412' })).toBeInTheDocument();
    expect(within(groups).queryByRole('group', { name: 'FX-300' })).not.toBeInTheDocument();
    expect(within(settled).getByRole('group', { name: 'FX-300' })).toBeInTheDocument();
    fireEvent.click(within(settled).getByRole('button', { name: /^Settled \(/ }));
    expect(within(settled).queryByRole('group', { name: 'FX-300' })).not.toBeInTheDocument();
  });

  it('moves a worktree with a merged PR into Settled; a repo checkout never settles', () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    const root = { ...wt('/r1', 'r1'), branch: 'master' } as Worktree;
    const done = { ...wt('/r2/done', 'r2'), branch: 'fx-old' } as Worktree;
    vi.mocked(useMrSummaries).mockReturnValue(new Map([
      ['/r2/done', { state: 'merged', updatedAt: '2026-01-01' }],
      ['/r1', { state: 'merged', updatedAt: '2026-01-01' }],
    ]) as ReturnType<typeof useMrSummaries>);
    loose('local:/r1'); // master would show here if it settled like a worktree
    render(<SidebarBody {...props({ worktrees: [root, done] })} />);
    const settled = screen.getByRole('region', { name: 'Settled' });
    expect(within(settled).getByRole('button', { name: 'fx-old' })).toBeInTheDocument();
    expect(within(settled).queryByText('master')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'fx-old' })).toHaveLength(1);
  });

  it('shows no Settled section when nothing has settled', () => {
    render(<SidebarBody {...props()} />);
    expect(screen.queryByRole('region', { name: 'Settled' })).not.toBeInTheDocument();
  });

  // One "Add to group…" item, however many groups exist — the picker holds the list.
  const openPicker = () => {
    render(<SidebarBody {...props()} />);
    const menus = screen.getAllByRole('button', { name: 'fx-412 actions' });
    fireEvent.click(menus[menus.length - 1]!);
    expect(screen.queryByRole('button', { name: 'Add to FX-412' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to group…' }));
    return screen.getByRole('dialog', { name: 'Add to group' });
  };

  it('adds a worktree to a group from the row menu picker', () => {
    // The picker's row is a member of FX-412 already, so add it to a second group.
    const other: FocusGroup = { id: 'g2', name: 'FX-500', members: [], createdAt: 't' };
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [group, other] });
    const dialog = openPicker();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'FX-500' }));
    expect(focus.setMembership).toHaveBeenCalledWith('g2', expect.stringMatching(/^local:\/r2\//), true);
  });

  it('right-clicking a worktree opens its menu at the cursor, with Add to group', () => {
    render(<SidebarBody {...props()} />);
    const row = screen.getAllByText('fx-412').at(-1)!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 80 });
    const menu = screen.getByRole('menu');
    expect(menu).toHaveStyle({ left: '40px', top: '80px' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Add to group…' }));
    expect(screen.getByRole('dialog', { name: 'Add to group' })).toBeInTheDocument();
  });

  it('starts a new group from a worktree menu, with that worktree ticked', async () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    let resolveCreate!: (g: FocusGroup) => void;
    focus.create.mockReturnValue(new Promise<FocusGroup>((r) => { resolveCreate = r; }));
    loose('local:/r1/wt');
    render(<SidebarBody {...props()} />);
    fireEvent.contextMenu(screen.getAllByText('fx-412')[0]!, { clientX: 10, clientY: 10 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'New group…' }));
    const dialog = screen.getByRole('dialog', { name: 'New group' });
    expect(within(dialog).getByRole('checkbox', { name: 'api fx-412' })).toBeChecked();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Fresh' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
    expect(focus.create).toHaveBeenCalledWith('Fresh', ['local:/r1/wt']);
    // Still loose until the group exists: a failed create must not lose the row.
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: ['local:/r1/wt'] });
    resolveCreate({ ...group, id: 'g9', name: 'Fresh' });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: [] }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:focus-group-active')!)).toEqual({ w1: 'g9' }));
  });

  it('keeps the loose row when creating its group fails', async () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    focus.create.mockRejectedValue(new Error('disk full'));
    const onError = vi.fn();
    loose('local:/r1/wt');
    render(<SidebarBody {...props({ onError })} />);
    fireEvent.contextMenu(screen.getAllByText('fx-412')[0]!, { clientX: 10, clientY: 10 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'New group…' }));
    const dialog = screen.getByRole('dialog', { name: 'New group' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Fresh' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('disk full'));
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ w1: ['local:/r1/wt'] });
  });

  it('right-clicking blank sidebar space offers New group and Add repo', () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    const onAddRepo = vi.fn();
    const { container } = render(<SidebarBody {...props({ onAddRepo })} />);
    fireEvent.contextMenu(container.querySelector('.overflow-y-auto')!, { clientX: 20, clientY: 300 });
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('button', { name: 'Delete worktree' })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('button', { name: 'New group…' }));
    expect(screen.getByRole('dialog', { name: 'New group' })).toBeInTheDocument();
  });

  it('blank-space menu starts a new worktree and collapses every group', () => {
    const onNewWorktree = vi.fn();
    const { container } = render(<SidebarBody {...props({ onNewWorktree })} />);
    const blank = container.querySelector('.overflow-y-auto')!;
    fireEvent.contextMenu(blank, { clientX: 20, clientY: 300 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'New worktree…' }));
    expect(onNewWorktree).toHaveBeenCalled();
    fireEvent.contextMenu(blank, { clientX: 20, clientY: 300 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Collapse all' }));
    expect(JSON.parse(localStorage.getItem('strado:focus-groups-collapsed')!)).toEqual({ w1: ['g1'] });
  });

  it('a worktree row keeps its own menu on right-click', () => {
    loose('local:/r1/wt');
    render(<SidebarBody {...props()} />);
    fireEvent.contextMenu(screen.getAllByText('fx-412')[0]!, { clientX: 10, clientY: 10 });
    expect(within(screen.getByRole('menu')).getByRole('button', { name: 'Delete worktree' })).toBeInTheDocument();
  });

  it('filters groups as you type', () => {
    const dialog = openPicker();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Find or create a group' }), { target: { value: 'zzz' } });
    expect(within(dialog).queryByRole('checkbox', { name: 'FX-412' })).not.toBeInTheDocument();
  });

  // Electron has no window.prompt — the name comes from the picker's own input.
  it('creates a new group from the picker with Enter', async () => {
    focus.create.mockResolvedValue({ ...group, id: 'g2', name: 'FX-500' });
    const dialog = openPicker();
    const input = within(dialog).getByRole('textbox', { name: 'Find or create a group' });
    fireEvent.change(input, { target: { value: ' FX-500 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(focus.create).toHaveBeenCalledWith('FX-500', [expect.stringMatching(/^local:\/r2\//)]);
    expect(screen.queryByRole('dialog', { name: 'Add to group' })).not.toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:focus-group-active')!)).toEqual({ w1: 'g2' }));
  });
});
