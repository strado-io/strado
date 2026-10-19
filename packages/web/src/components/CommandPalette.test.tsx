import { act, render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, releaseKeyboard } from './CommandPalette';
import { api, type RemoteWorktree } from '../api';
import type { RepoConfig, Workspace, Worktree } from '../types';

afterEach(() => releaseKeyboard());

/** The bar is inert until focused (click or ⌘K): every test starts with it focused. */
const render = (ui: Parameters<typeof rtlRender>[0]) => {
  const r = rtlRender(ui);
  act(() => { (screen.getByLabelText('Global search') as HTMLInputElement).focus(); });
  return r;
};


const repos = [{ id: 'r1', name: 'React App', path: '/repos/react-app' }] as RepoConfig[];
const workspaces = [
  { id: 'default', name: 'Personal' },
  { id: 'other', name: 'Client X' },
] as Workspace[];

function wt(path: string, ticket: string, title: string): Worktree {
  return {
    path, repoId: 'r1', branch: ticket, head: 'h', prunable: false, tracked: true,
    meta: { ticketId: ticket, title, repoId: 'r1', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  } as unknown as Worktree;
}

function setup() {
  const handlers = {
    onOpenWorktree: vi.fn(),
    onGoRepo: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <CommandPalette
      repos={repos}
      worktrees={[wt('/wt/FD-1', 'FD-1', 'fix login'), wt('/wt/FD-2', 'FD-2', 'reporting')]}
      workspaces={workspaces}
      activeWorkspaceId="default"
      {...handlers}
    />,
  );
  return handlers;
}

describe('CommandPalette', () => {
  it('filters across worktrees, repos, and other workspaces', () => {
    setup();
    const input = screen.getByLabelText('Global search');
    fireEvent.change(input, { target: { value: 'login' } });
    expect(screen.getByText('FD-1')).toBeInTheDocument();
    expect(screen.queryByText('FD-2')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'client' } });
    expect(screen.getByText('Client X')).toBeInTheDocument();
    // active workspace never appears
    fireEvent.change(input, { target: { value: 'personal' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('Enter picks the keyboard-selected result and closes', () => {
    const h = setup();
    const input = screen.getByLabelText('Global search');
    fireEvent.change(input, { target: { value: 'FD' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.onOpenWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: '/wt/FD-2' }), undefined);
    expect(h.onClose).toHaveBeenCalled();
  });

  it('worktrees from other workspaces are searchable and pass their wsId', async () => {
    vi.spyOn(api.worktrees, 'list').mockResolvedValue([wt('/other/FD-9', 'FD-9', 'ads work')]);
    const h = setup();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-9' } });
    await waitFor(() => expect(screen.getByText('FD-9')).toBeInTheDocument());
    expect(screen.getByText(/Client X · switch & open/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('FD-9'));
    expect(h.onOpenWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: '/other/FD-9' }), 'other');
    vi.restoreAllMocks();
  });

  it('clicking a repo result navigates to that repo view', () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'react' } });
    fireEvent.click(screen.getByText('React App'));
    expect(h.onGoRepo).toHaveBeenCalledWith('r1');
  });

  it('Escape closes', () => {
    const h = setup();
    fireEvent.keyDown(screen.getByLabelText('Global search'), { key: 'Escape' });
    expect(h.onClose).toHaveBeenCalled();
  });
});

describe('CommandPalette runner worktrees', () => {
  const runnerWt = {
    runnerId: 'rn1', runnerName: 'gpu-box', wsBase: 'wss://rn1.relay', remoteWsId: 'default',
    path: '/srv/wt/FX-77', name: 'FX-77', branch: 'fx-77-cache', head: 'h', remoteRepoId: null,
    isRepoRoot: false, cloneUrl: null, localRepoId: 'r1', remoteRepoName: null,
  } as RemoteWorktree;

  it('lists a runner worktree with its runner name, finds it by query, and opens it', () => {
    const onOpenRemoteWorktree = vi.fn();
    const onOpenWorktree = vi.fn();
    render(<CommandPalette repos={repos} worktrees={[wt('/wt/FD-1', 'FD-1', 'fix login')]} workspaces={workspaces} activeWorkspaceId="default"
      onOpenWorktree={onOpenWorktree} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={vi.fn()}
      remoteWorktrees={[runnerWt]} onOpenRemoteWorktree={onOpenRemoteWorktree} />);
    expect(screen.getByText('fx-77-cache')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'gpu' } });
    expect(screen.getByText('fx-77-cache')).toBeInTheDocument();
    expect(screen.getByText('React App · gpu-box')).toBeInTheDocument();
    expect(screen.queryByText('FD-1')).toBeNull();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'fx-77' } });
    fireEvent.click(screen.getByText('fx-77-cache'));
    expect(onOpenRemoteWorktree).toHaveBeenCalledWith(runnerWt);
    expect(onOpenWorktree).not.toHaveBeenCalled();
  });

  it('tags worktrees that are already in the active Focus', () => {
    render(<CommandPalette repos={repos} worktrees={[wt('/wt/FD-1', 'FD-1', 'fix login')]} workspaces={workspaces} activeWorkspaceId="default"
      onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={vi.fn()}
      remoteWorktrees={[runnerWt]} focusName="Billing" focusMemberIds={new Set(['remote:rn1:/srv/wt/FX-77'])} />);
    expect(screen.getByTitle('In Billing')).toHaveTextContent('Billing');
    expect(screen.getAllByTitle('In Billing')).toHaveLength(1);
  });

  it('lists every Focus as a row, the current one marked, and switches on pick', () => {
    const onSwitchFocus = vi.fn();
    const focuses = [
      { id: 'f1', name: 'Billing', members: ['local:/a'], createdAt: 't', lastActiveAt: 't' },
      { id: 'f2', name: 'Perf', members: [], createdAt: 't', lastActiveAt: 't' },
    ];
    render(<CommandPalette repos={repos} worktrees={[]} workspaces={workspaces} activeWorkspaceId="default"
      onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={vi.fn()}
      focuses={focuses} activeFocusId="f1" onSwitchFocus={onSwitchFocus} />);
    expect(screen.getByText('Focuses')).toBeInTheDocument();
    expect(screen.getByText('current · 1 worktree')).toBeInTheDocument();
    expect(screen.getByText('0 worktrees')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Billing'));
    expect(onSwitchFocus).not.toHaveBeenCalled(); // already there
    act(() => { (screen.getByLabelText('Global search') as HTMLInputElement).focus(); }); // the pick handed focus back
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'per' } });
    fireEvent.click(screen.getByText('Perf'));
    expect(onSwitchFocus).toHaveBeenCalledWith('f2');
  });

  it('shows only the Focuses until the user types, then searches everything', () => {
    const many = Array.from({ length: 20 }, (_, i) => wt(`/wt/${i}`, `FD-${i}`, `task ${i}`));
    const focuses = [
      { id: 'f1', name: 'Old', members: [], createdAt: 't', lastActiveAt: '2026-01-01T00:00:00Z' },
      { id: 'f2', name: 'Fresh', members: [], createdAt: 't', lastActiveAt: '2026-02-01T00:00:00Z' },
    ];
    render(<CommandPalette repos={repos} worktrees={many} workspaces={workspaces} activeWorkspaceId="default"
      onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={vi.fn()}
      focuses={focuses} activeFocusId={null} onSwitchFocus={vi.fn()} />);
    const rows = screen.getAllByText(/worktrees$/).map((el) => el.parentElement?.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Fresh');
    expect(rows[1]).toContain('Old');
    expect(screen.queryByText('Worktrees')).toBeNull();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-1' } });
    expect(screen.getByText('Worktrees')).toBeInTheDocument();
    expect(screen.getByText('FD-1')).toBeInTheDocument();
  });
});
