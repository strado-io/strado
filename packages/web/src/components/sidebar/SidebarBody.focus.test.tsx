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
    remoteWorktrees: [], runnerStatuses: [], selected: { kind: 'tasks' }, onSelect: vi.fn(), taskCount: 0,
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

const showGroups = () => localStorage.setItem('strado:sidebar-view', JSON.stringify({ w1: 'groups' }));

describe('SidebarBody groups view', () => {
  it('starts on Repos, with no group rows mixed into the repo list', () => {
    render(<SidebarBody {...props()} />);
    expect(screen.getByRole('tab', { name: 'Repos' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: 'Focus groups' })).not.toBeInTheDocument();
    expect(screen.getByText('Repos', { selector: 'span' })).toBeInTheDocument();
  });

  it('lists each group with its members and repo chips in the Groups view', () => {
    render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Groups' }));
    const g = screen.getByRole('group', { name: 'FX-412' });
    expect(within(g).getByText('api')).toBeInTheDocument();
    expect(within(g).getByText('web')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add repo' })).not.toBeInTheDocument();
  });

  it('folds a group from its header', () => {
    showGroups();
    render(<SidebarBody {...props()} />);
    const g = screen.getByRole('group', { name: 'FX-412' });
    fireEvent.click(within(g).getByRole('button', { name: /FX-412/, expanded: true }));
    expect(within(g).queryByText('api')).not.toBeInTheDocument();
  });

  it('opening a member makes its group the active one', () => {
    showGroups();
    const onOpenWorktree = vi.fn();
    render(<SidebarBody {...props({ onOpenWorktree })} />);
    const g = screen.getByRole('group', { name: 'FX-412' });
    fireEvent.click(within(g).getAllByText('fx-412')[0]!);
    expect(onOpenWorktree).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('strado:focus-group-active')!)).toEqual({ w1: 'g1' });
  });

  it('creates a group from the Groups header', () => {
    focus.create.mockResolvedValue({ ...group, id: 'g2', name: 'FX-500' });
    showGroups();
    render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const input = screen.getByRole('textbox', { name: 'New group name' });
    fireEvent.change(input, { target: { value: 'FX-500' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(focus.create).toHaveBeenCalledWith('FX-500');
  });

  it('renames a group from its menu', () => {
    showGroups();
    render(<SidebarBody {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'FX-412 group actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    const input = screen.getByRole('textbox', { name: 'Group name' });
    fireEvent.change(input, { target: { value: 'FX-413' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(focus.rename).toHaveBeenCalledWith('g1', 'FX-413');
  });

  it('explains how to start when there are no groups', () => {
    vi.mocked(useFocusGroups).mockReturnValue({ ...focus, groups: [] });
    showGroups();
    render(<SidebarBody {...props()} />);
    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
  });
  it('adds a worktree to a group from its row menu', () => {
    render(<SidebarBody {...props({ expandedRepos: new Set(['r2']) })} />);
    const menus = screen.getAllByRole('button', { name: 'fx-412 actions' });
    fireEvent.click(menus[menus.length - 1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Add to FX-412' }));
    expect(focus.setMembership).toHaveBeenCalledWith('g1', expect.stringMatching(/^local:\/r2\//), true);
  });

  // Electron has no window.prompt — the name must come from an in-app input.
  it('names a new group in an in-app dialog from the row menu', async () => {
    focus.create.mockResolvedValue({ ...group, id: 'g2', name: 'FX-500' });
    render(<SidebarBody {...props({ expandedRepos: new Set(['r2']) })} />);
    const menus = screen.getAllByRole('button', { name: 'fx-412 actions' });
    fireEvent.click(menus[menus.length - 1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Add to new group…' }));
    const input = screen.getByRole('textbox', { name: 'New group name' });
    fireEvent.change(input, { target: { value: ' FX-500 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(focus.create).toHaveBeenCalledWith('FX-500', [expect.stringMatching(/^local:\/r2\//)]);
    expect(screen.queryByRole('textbox', { name: 'New group name' })).not.toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:sidebar-view')!)).toEqual({ w1: 'groups' }));
  });
});
