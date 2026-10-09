import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FocusGroup } from '../../api';
import type { RepoConfig, Worktree } from '../../types';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { useFocusGroups } from '../../hooks/useFocusGroups';
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
  create: vi.fn(), rename: vi.fn(() => Promise.resolve()), setMembership: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()),
};

function props(over: Partial<SidebarBodyProps> = {}): SidebarBodyProps {
  return {
    wsId: 'w1', repos: [r1, r2], worktrees: [wt('/r1/wt', 'r1'), wt('/r2/wt', 'r2'), wt('/r2/other', 'r2')],
    remoteWorktrees: [], runnerStatuses: [],
    onAddRepo: vi.fn(), onDeleteRepo: vi.fn(), expandedRepos: new Set(), onToggleRepo: vi.fn(),
    onOpenWorktree: vi.fn(), activeWorktreePath: null, onNewWorktreeForRepo: vi.fn(),
    onWorktreeSettings: vi.fn(), onDeleteWorktree: vi.fn(), pinnedWorktreeIds: [], onTogglePinnedWorktree: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(useMrSummaries).mockReturnValue(new Map());
  vi.mocked(useFocusGroups).mockReturnValue(focus);
  focus.setMembership.mockClear();
  focus.create.mockReset();
  focus.rename.mockClear();
});


describe('SidebarBody groups section', () => {
  it('lists each group with its members and repo chips, above the repo tree in one list', () => {
    render(<SidebarBody {...props()} />);
    const g = screen.getByRole('group', { name: 'FX-412' });
    expect(within(g).getByText('api')).toBeInTheDocument();
    expect(within(g).getByText('web')).toBeInTheDocument();
    const repos = screen.getByText('Repos', { selector: 'span' });
    expect(g.compareDocumentPosition(repos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
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

  it('creates a group from the Groups header', () => {
    focus.create.mockResolvedValue({ ...group, id: 'g2', name: 'FX-500' });
    render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const dialog = screen.getByRole('dialog', { name: 'New group' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'FX-500' } });
    // Any worktree, from any repo, can start the group.
    fireEvent.click(within(dialog).getAllByRole('checkbox', { name: 'web fx-412' })[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
    expect(focus.create).toHaveBeenCalledWith('FX-500', [expect.stringMatching(/^local:\/r2\//)]);
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

  it('moves a merged group out of Groups into Settled at the bottom', () => {
    const shipped: FocusGroup = { id: 'g2', name: 'FX-300', members: ['local:/r2/other'], createdAt: 't' };
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [group, shipped] });
    vi.mocked(useMrSummaries).mockReturnValue(new Map([['/r2/other', { state: 'merged', updatedAt: '2026-01-01' }]]) as ReturnType<typeof useMrSummaries>);
    render(<SidebarBody {...props()} />);
    const groups = screen.getByRole('region', { name: 'Focus groups' });
    const settled = screen.getByRole('region', { name: 'Settled' });
    expect(within(groups).getByRole('group', { name: 'FX-412' })).toBeInTheDocument();
    expect(within(groups).queryByRole('group', { name: 'FX-300' })).not.toBeInTheDocument();
    expect(within(settled).getByRole('group', { name: 'FX-300' })).toBeInTheDocument();
    fireEvent.click(within(settled).getByRole('button', { name: /^Settled \(/ }));
    expect(within(settled).queryByRole('group', { name: 'FX-300' })).not.toBeInTheDocument();
  });

  it('moves a worktree with a merged PR from its repo into Settled; a repo checkout never settles', () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    const root = { ...wt('/r1', 'r1'), branch: 'master' } as Worktree;
    const done = { ...wt('/r2/done', 'r2'), branch: 'fx-old' } as Worktree;
    vi.mocked(useMrSummaries).mockReturnValue(new Map([
      ['/r2/done', { state: 'merged', updatedAt: '2026-01-01' }],
      ['/r1', { state: 'merged', updatedAt: '2026-01-01' }],
    ]) as ReturnType<typeof useMrSummaries>);
    render(<SidebarBody {...props({ worktrees: [root, done], expandedRepos: new Set(['r1', 'r2']) })} />);
    const settled = screen.getByRole('region', { name: 'Settled' });
    expect(within(settled).getByText('fx-old')).toBeInTheDocument();
    expect(within(settled).queryByText('master')).not.toBeInTheDocument();
    expect(screen.getAllByText('fx-old')).toHaveLength(1);
  });

  it('shows no Settled section when nothing has settled', () => {
    render(<SidebarBody {...props()} />);
    expect(screen.queryByRole('region', { name: 'Settled' })).not.toBeInTheDocument();
  });

  it('puts Pinned above Groups', () => {
    render(<SidebarBody {...props({ pinnedWorktreeIds: ['local:/r1/wt'] })} />);
    const pinned = screen.getByRole('region', { name: 'Pinned worktrees' });
    const groups = screen.getByRole('region', { name: 'Focus groups' });
    expect(pinned.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no Groups section at all when there are no groups', () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    render(<SidebarBody {...props({ worktrees: [{ ...wt('/r1/m', 'r1'), branch: 'main' }] })} />);
    expect(screen.queryByRole('region', { name: 'Focus groups' })).not.toBeInTheDocument();
    expect(screen.queryByText('Groups')).not.toBeInTheDocument();
  });
  // One "Add to group…" item, however many groups exist — the picker holds the list.
  const openPicker = () => {
    render(<SidebarBody {...props({ expandedRepos: new Set(['r2']) })} />);
    const menus = screen.getAllByRole('button', { name: 'fx-412 actions' });
    fireEvent.click(menus[menus.length - 1]!);
    expect(screen.queryByRole('button', { name: 'Add to FX-412' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to group…' }));
    return screen.getByRole('dialog', { name: 'Add to group' });
  };

  it('adds a worktree to a group from the row menu picker', () => {
    const dialog = openPicker();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'FX-412' }));
    expect(focus.setMembership).toHaveBeenCalledWith('g1', expect.stringMatching(/^local:\/r2\//), true);
  });

  it('right-clicking a worktree opens its menu at the cursor, with Add to group', () => {
    render(<SidebarBody {...props({ expandedRepos: new Set(['r2']) })} />);
    const row = screen.getAllByText('fx-412').at(-1)!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 80 });
    const menu = screen.getByRole('menu');
    expect(menu).toHaveStyle({ left: '40px', top: '80px' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Add to group…' }));
    expect(screen.getByRole('dialog', { name: 'Add to group' })).toBeInTheDocument();
  });

  it('starts a new group from a worktree menu, with that worktree ticked', () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    focus.create.mockResolvedValue({ ...group, id: 'g9', name: 'Fresh' });
    render(<SidebarBody {...props({ expandedRepos: new Set(['r1']) })} />);
    fireEvent.contextMenu(screen.getAllByText('fx-412')[0]!, { clientX: 10, clientY: 10 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'New group…' }));
    const dialog = screen.getByRole('dialog', { name: 'New group' });
    expect(within(dialog).getByRole('checkbox', { name: 'api fx-412' })).toBeChecked();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Fresh' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
    expect(focus.create).toHaveBeenCalledWith('Fresh', ['local:/r1/wt']);
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
