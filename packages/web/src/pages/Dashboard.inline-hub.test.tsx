import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: { id: 'default', name: 'Default', color: 'zinc', icon: 'DF', defaultEditor: 'vscode', defaultPortBase: 3000, logDir: null },
    allWorkspaces: [],
    switchTo: vi.fn(),
  }),
}));
vi.mock('../api', () => ({
  api: {
    repos: { list: vi.fn().mockResolvedValue([{ id: 'r1', name: 'Repo One' }]) },
    worktrees: { unmanaged: vi.fn().mockResolvedValue({ worktrees: [] }), list: vi.fn().mockResolvedValue([
      { path: '/wt/FD-9', repoId: 'r1', branch: 'fd-9', meta: { ticketId: 'FD-9' },
        process: { status: 'idle' }, tracked: true },
    ]) },
    jira: { status: vi.fn().mockResolvedValue({ configured: false, baseUrl: null }) },
    tickets: {
      providers: vi.fn().mockResolvedValue([]),
      issues: vi.fn().mockResolvedValue({ issues: {}, missing: [], errors: {} }),
    },
    // The sidebar's org chip fetches on mount; reject like the local server
    // does when there's no signed-in account, so the chip renders nothing.
    org: { get: vi.fn().mockRejectedValue(new Error('no Strado account on this machine')) },
  },
}));
// Stand in for the hub so the test asserts selection, not terminal internals.
vi.mock('./TerminalView', () => ({
  TerminalView: ({ worktree, onClose }: any) => (
    <div data-testid="inline-hub">
      hub:{worktree.path}
      <button onClick={onClose}>‹ Back</button>
    </div>
  ),
}));

import { Dashboard } from './Dashboard';

const noop = vi.fn();
function renderDashboard() {
  return render(
    <Dashboard
      onNewWorktree={noop} onShowLogs={noop}
      onMenu={noop} onOpenNote={noop} onOpenDiff={noop}
      onCloseOverlays={noop} onDeleteWorktree={noop}
      update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }}
    />,
  );
}

// The repo name now appears twice: the sidebar row, and the task board's
// per-repo chip. Every click here means the sidebar row, which comes first.
const repoRow = () => screen.getAllByText('Repo One')[0]!;
// Same for the ticket id: sidebar row first, task board row second.
const worktreeRow = () => screen.getAllByText('FD-9')[0]!;

describe('Dashboard inline hub', () => {
  beforeEach(() => localStorage.clear());

  it('shows the board and no hub initially', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument();
  });

  it('opens the inline hub when a worktree is selected in the tree', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow()); // expand repo
    fireEvent.click(worktreeRow());      // open worktree
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
  });

  it('Back returns to the board', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow());
    fireEvent.click(worktreeRow());
    fireEvent.click(await screen.findByText('‹ Back'));
    await waitFor(() => expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument());
  });

  it('selecting Tasks clears the hub', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow());
    fireEvent.click(worktreeRow());
    await screen.findByTestId('inline-hub');
    fireEvent.click(screen.getByText('Tasks'));
    await waitFor(() => expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument());
  });

  it('jumping to a repo via the command palette clears the hub', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow());
    fireEvent.click(worktreeRow());
    await screen.findByTestId('inline-hub');
    fireEvent.keyDown(window, { key: 'k', metaKey: true }); // ⌘K opens the palette
    const repoEntries = await screen.findAllByText('Repo One');
    fireEvent.click(repoEntries.at(-1)!); // the palette's "Repos" result
    await waitFor(() => expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument());
  });

  it('persists selection and restores it on remount', async () => {
    const { unmount } = renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow());
    fireEvent.click(worktreeRow());
    await screen.findByTestId('inline-hub');
    unmount();
    renderDashboard();
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
  });

  it('a stale persisted path (for this workspace) resolves to the board', async () => {
    localStorage.setItem('strado:selected-by-ws', JSON.stringify({ default: '/wt/GONE' }));
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument();
  });
});
