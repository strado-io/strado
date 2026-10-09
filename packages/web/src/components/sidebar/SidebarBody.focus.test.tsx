import { fireEvent, render, screen, within } from '@testing-library/react';
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
const focus = { groups: [group], loaded: true, create: vi.fn(), rename: vi.fn(), setMembership: vi.fn(() => Promise.resolve()), remove: vi.fn() };

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
});

describe('SidebarBody focus section', () => {
  it('shows the active group members with repo chips, above the repo tree', () => {
    localStorage.setItem('strado:focus-group-active', JSON.stringify({ w1: 'g1' }));
    render(<SidebarBody {...props()} />);
    const section = screen.getByRole('region', { name: 'Focus group' });
    expect(within(section).getByText('api')).toBeInTheDocument();
    expect(within(section).getByText('web')).toBeInTheDocument();
  });

  it('ignores an active id for a group that no longer exists', () => {
    localStorage.setItem('strado:focus-group-active', JSON.stringify({ w1: 'deleted' }));
    render(<SidebarBody {...props()} />);
    expect(screen.queryByRole('region', { name: 'Focus group' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Focus: none/ })).toBeInTheDocument();
  });

  it('adds a worktree to a group from its row menu', () => {
    render(<SidebarBody {...props({ expandedRepos: new Set(['r2']) })} />);
    const menus = screen.getAllByRole('button', { name: 'fx-412 actions' });
    fireEvent.click(menus[menus.length - 1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Add to FX-412' }));
    expect(focus.setMembership).toHaveBeenCalledWith('g1', expect.stringMatching(/^local:\/r2\//), true);
  });
});
