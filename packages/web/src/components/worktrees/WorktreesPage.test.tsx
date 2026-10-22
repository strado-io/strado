import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, Worktree } from '../../types';
import type { Focus, RemoteWorktree } from '../../api';
import { useMrSummaries } from '../../hooks/mrSummaries';
import { WorktreesPage, type WorktreesPageProps } from './WorktreesPage';

vi.mock('../../hooks/mrSummaries', () => ({ useMrSummaries: vi.fn(() => new Map()) }));
const focusMock = vi.hoisted(() => ({
  focuses: [] as { id: string; name: string; members: string[]; createdAt: string; lastActiveAt: string }[],
  activeId: null as string | null,
  setMembership: vi.fn(),
}));
vi.mock('../../hooks/useFocuses', () => ({
  useFocuses: () => ({
    focuses: focusMock.focuses, loaded: true, activeId: focusMock.activeId,
    active: focusMock.focuses.find((f) => f.id === focusMock.activeId) ?? null,
    activate: vi.fn(), create: vi.fn(), rename: vi.fn(), setMembership: focusMock.setMembership, remove: vi.fn(),
  }),
}));
const focus = (id: string, name: string, members: string[] = []): Focus => ({ id, name, members, createdAt: 't', lastActiveAt: 't' });

const r1 = { id: 'r1', name: 'api', path: '/code/api' } as RepoConfig;
const r2 = { id: 'r2', name: 'web', path: '/code/web' } as RepoConfig;
const wt = (path: string, repoId: string, branch = 'fx-412'): Worktree => ({
  path, repoId, branch, meta: null, diffStats: null,
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false },
} as Worktree);
const remote = {
  runnerId: 'rn1', runnerName: 'gpu-box', wsBase: 'wss://rn1', remoteWsId: 'default',
  path: '/srv/wt/FX-77', name: 'FX-77', branch: 'fx-77', head: 'h', remoteRepoId: null,
  isRepoRoot: false, cloneUrl: null, localRepoId: 'r1', remoteRepoName: null,
} as RemoteWorktree;

function props(over: Partial<WorktreesPageProps> = {}): WorktreesPageProps {
  return {
    wsId: 'w1', repos: [r1, r2], worktrees: [wt('/r1/a', 'r1', 'feat/a'), wt('/r1/b', 'r1', 'feat/b')],
    remoteWorktrees: [], runnerStatuses: [], activeWorktreePath: null,
    onAddRepo: vi.fn(), onNewWorktree: vi.fn(), onRemoveRepo: vi.fn(), onOpenWorktree: vi.fn(),
    onWorktreeSettings: vi.fn(), onDeleteWorktree: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  focusMock.focuses = [focus('f1', 'Billing', ['local:/r1/a']), focus('f2', 'Perf', ['local:/r1/a', 'local:/r1/b'])];
  focusMock.activeId = 'f1';
  focusMock.setMembership.mockReset().mockResolvedValue(undefined);
  vi.mocked(useMrSummaries).mockReturnValue(new Map());
});

describe('WorktreesPage', () => {
  it('lists every repo with its worktrees, the total, and an empty repo says so', () => {
    render(<WorktreesPage {...props()} />);
    expect(screen.getByRole('heading', { name: 'Worktrees' })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    const api = screen.getByRole('region', { name: 'api' });
    expect(within(api).getByText('/code/api')).toBeInTheDocument();
    expect(within(api).getByRole('button', { name: 'feat/a' })).toBeInTheDocument();
    expect(within(api).getByRole('button', { name: 'feat/b' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'web' })).getByText('No worktrees')).toBeInTheDocument();
  });

  it('tags each worktree with the Focuses holding it, active first, and toggles it in the active Focus without opening', () => {
    const onOpenWorktree = vi.fn();
    render(<WorktreesPage {...props({ onOpenWorktree })} />);
    const rowA = screen.getByRole('button', { name: 'feat/a' }).closest('.group') as HTMLElement;
    expect(within(rowA).getAllByTitle(/^In /).map((t) => t.textContent)).toEqual(['Billing', 'Perf']);
    fireEvent.click(within(rowA).getByRole('button', { name: 'Remove feat/a from Billing' }));
    expect(focusMock.setMembership).toHaveBeenCalledWith('f1', 'local:/r1/a', false);
    const rowB = screen.getByRole('button', { name: 'feat/b' }).closest('.group') as HTMLElement;
    fireEvent.click(within(rowB).getByRole('button', { name: 'Add feat/b to Billing' }));
    expect(focusMock.setMembership).toHaveBeenCalledWith('f1', 'local:/r1/b', true);
    expect(onOpenWorktree).not.toHaveBeenCalled();
  });

  it('opens a worktree from its row; its menu offers Settings and Delete', () => {
    const onOpenWorktree = vi.fn(); const onDeleteWorktree = vi.fn();
    render(<WorktreesPage {...props({ onOpenWorktree, onDeleteWorktree })} />);
    fireEvent.click(screen.getByRole('button', { name: 'feat/a' }));
    expect(onOpenWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: '/r1/a' }));
    fireEvent.click(screen.getByRole('button', { name: 'feat/a actions' }));
    expect(within(screen.getByRole('menu')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Settings', 'Delete worktree']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree' }));
    expect(onDeleteWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: '/r1/a' }));
  });

  it('header and repo rows add a repo, start a worktree (in a repo), and remove a repo', () => {
    const onAddRepo = vi.fn(); const onNewWorktree = vi.fn(); const onRemoveRepo = vi.fn();
    render(<WorktreesPage {...props({ onAddRepo, onNewWorktree, onRemoveRepo })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    expect(onAddRepo).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(onNewWorktree).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole('button', { name: 'New worktree in web' }));
    expect(onNewWorktree).toHaveBeenCalledWith('r2');
    fireEvent.click(screen.getByRole('button', { name: 'web actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove repo' }));
    expect(onRemoveRepo).toHaveBeenCalledWith(r2);
  });

  it('a repo row\'s menu edits its run commands', () => {
    const onRunCommands = vi.fn();
    render(<WorktreesPage {...props({ onRunCommands })} />);
    fireEvent.click(screen.getByRole('button', { name: 'web actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run commands…' }));
    expect(onRunCommands).toHaveBeenCalledWith(r2);
  });

  it('puts a runner worktree under its local repo, or under its remote repo name, marked offline when its runner is', () => {
    const orphan = { ...remote, path: '/srv/wt/ZZ-1', name: 'ZZ-1', branch: 'zz-1', localRepoId: null, remoteRepoName: 'far-repo' } as RemoteWorktree;
    const onOpenRemoteWorktree = vi.fn();
    render(<WorktreesPage {...props({
      remoteWorktrees: [remote, orphan], onOpenRemoteWorktree,
      runnerStatuses: [{ runnerId: 'rn1', name: 'gpu-box', online: false, error: null }] as never,
    })} />);
    const api = screen.getByRole('region', { name: 'api' });
    fireEvent.click(within(api).getByRole('button', { name: 'fx-77 on gpu-box' }));
    expect(onOpenRemoteWorktree).toHaveBeenCalledWith(remote);
    expect(within(api).getByText('gpu-box · offline')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'far-repo' })).getByRole('button', { name: 'zz-1 on gpu-box' })).toBeInTheDocument();
    fireEvent.click(within(api).getByRole('button', { name: 'Add fx-77 on gpu-box to Billing' }));
    expect(focusMock.setMembership).toHaveBeenCalledWith('f1', 'remote:rn1:/srv/wt/FX-77', true);
  });

  it('with no active Focus, shows the tags but no toggle; with no repos, says so', () => {
    focusMock.activeId = null;
    const { unmount } = render(<WorktreesPage {...props()} />);
    expect(screen.getAllByTitle(/^In /)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Add .* to / })).toBeNull();
    unmount();
    render(<WorktreesPage {...props({ repos: [], worktrees: [] })} />);
    expect(screen.getByText('No repos yet. Add one to start a worktree.')).toBeInTheDocument();
  });
});
