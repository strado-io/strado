import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { api } from '../api';
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
