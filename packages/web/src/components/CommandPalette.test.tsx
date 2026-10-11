import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { api, type RemoteWorktree } from '../api';
import type { RepoConfig, Workspace, Worktree } from '../types';

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

describe('CommandPalette focus groups', () => {
  const groups = [
    { group: { id: 'g1', name: 'FX-412 checkout', members: ['local:/wt/FD-1'], createdAt: 't' }, detail: 'FD-1 · React App', done: false },
    { group: { id: 'g2', name: 'FX-300 old', members: [], createdAt: 't' }, detail: '', done: true },
  ];
  function setupGroups() {
    const onPickGroup = vi.fn();
    render(
      <CommandPalette
        repos={repos}
        worktrees={[wt('/wt/FD-1', 'FD-1', 'fix login')]}
        workspaces={workspaces}
        activeWorkspaceId="default"
        focusGroups={groups}
        onPickGroup={onPickGroup}
        onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={vi.fn()}
      />,
    );
    return onPickGroup;
  }

  it('lists matching groups first, open before done, and picks one', () => {
    const onPickGroup = setupGroups();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'fx-' } });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons[0]).toContain('FX-412 checkout');
    expect(buttons[1]).toContain('FX-300 old');
    expect(buttons[1]).toContain('done');
    fireEvent.click(screen.getByText('FX-412 checkout'));
    expect(onPickGroup).toHaveBeenCalledWith('g1');
  });

  it('tags member worktrees with their group name', () => {
    setupGroups();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'login' } });
    expect(screen.getByText(/FX-412 checkout/)).toBeInTheDocument();
  });

  it('leaves Done groups out of the empty-query list so recent worktrees stay visible', () => {
    setupGroups();
    expect(screen.getByText('FX-412 checkout')).toBeInTheDocument();
    expect(screen.queryByText('FX-300 old')).not.toBeInTheDocument();
    expect(screen.getByText('FD-1')).toBeInTheDocument();
  });

  it('tags parked groups, orders working before parked before done, and still picks them', () => {
    const onPickGroup = vi.fn();
    render(<CommandPalette repos={repos} worktrees={[]} workspaces={workspaces} activeWorkspaceId="default"
      onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={vi.fn()} onPickGroup={onPickGroup}
      focusGroups={[
        { group: { id: 'd', name: 'FX-1', members: [], createdAt: 't' }, detail: '', done: true },
        { group: { id: 'p', name: 'FX-2', members: [], createdAt: 't', state: 'parked' }, detail: '', done: false, parked: true },
        { group: { id: 'w', name: 'FX-3', members: [], createdAt: 't' }, detail: '', done: false },
      ]} />);
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FX' } });
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels.findIndex((t) => t?.startsWith('FX-3'))).toBeLessThan(labels.findIndex((t) => t?.startsWith('FX-2')));
    expect(labels.findIndex((t) => t?.startsWith('FX-2'))).toBeLessThan(labels.findIndex((t) => t?.startsWith('FX-1')));
    expect(screen.getByText('parked')).toBeInTheDocument();
    fireEvent.click(screen.getByText('FX-2'));
    expect(onPickGroup).toHaveBeenCalledWith('p');
  });

  it('filter=groups lists only groups until you type', () => {
    render(<CommandPalette repos={repos} worktrees={[wt('/wt/FD-1', 'FD-1', 'fix login')]} workspaces={workspaces} activeWorkspaceId="default"
      onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={vi.fn()} filter="groups"
      focusGroups={[{ group: { id: 'p', name: 'FX-2', members: [], createdAt: 't', state: 'parked' }, detail: '', done: false, parked: true }]} />);
    expect(screen.getByText('FX-2')).toBeInTheDocument();
    expect(screen.queryByText('FD-1')).toBeNull();
    expect(screen.queryByText('React App')).toBeNull();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD' } });
    expect(screen.getByText('FD-1')).toBeInTheDocument();
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
      remoteWorktrees={[runnerWt]} onOpenRemoteWorktree={onOpenRemoteWorktree}
      focusGroups={[{ group: { id: 'g', name: 'Cache work', members: ['remote:rn1:/srv/wt/FX-77'], createdAt: 't' }, detail: '', done: false }]} />);
    expect(screen.getByText('fx-77-cache')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'gpu' } });
    expect(screen.getByText('fx-77-cache')).toBeInTheDocument();
    expect(screen.getByText('React App · gpu-box · Cache work')).toBeInTheDocument();
    expect(screen.queryByText('FD-1')).toBeNull();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'fx-77' } });
    fireEvent.click(screen.getByText('fx-77-cache'));
    expect(onOpenRemoteWorktree).toHaveBeenCalledWith(runnerWt);
    expect(onOpenWorktree).not.toHaveBeenCalled();
  });
});
