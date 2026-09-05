import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

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
    worktrees: { list: vi.fn().mockResolvedValue([
      { path: '/wt/FD-9', repoId: 'r1', branch: 'fd-9', meta: { ticketId: 'FD-9' },
        process: { status: 'idle' }, tracked: true,
        hasClaudeSession: true, claudeSessions: ['1', '2'] },
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
  TerminalView: ({ worktree, onClose, modalOpen, mode, sessionId }: any) => (
    <div data-testid="inline-hub" data-modal-open={modalOpen ? 'true' : 'false'}
      data-mode={mode ?? ''} data-session={sessionId ?? ''}>
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

  it('tells the hub to detach native previews while the Add repo modal is open', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow());
    fireEvent.click(worktreeRow());
    const hub = await screen.findByTestId('inline-hub');
    expect(hub).toHaveAttribute('data-modal-open', 'false');

    fireEvent.click(screen.getByLabelText('Add repo'));
    await screen.findByRole('heading', { name: 'Add repo' });
    expect(hub).toHaveAttribute('data-modal-open', 'true');

    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(hub).toHaveAttribute('data-modal-open', 'false'));
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

  it('opens the workspace-level code reviews page from the sidebar', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    // Tasks has no empty toolbar when there are no running servers or sidebar
    // controls, so the table begins at the top of the content area.
    expect(document.querySelector('[data-filter-bar]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Code reviews'));
    expect(await screen.findByRole('searchbox', { name: 'Search code reviews' })).toBeInTheDocument();
    // The page has its own toolbar — the shared bar would just be a blank strip.
    expect(document.querySelector('[data-filter-bar]')).not.toBeInTheDocument();
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

describe('Dashboard sidebar hover card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the hub on the exact session picked in the card', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow());

    const row = worktreeRow().closest('.group')!;
    fireEvent.pointerEnter(row);
    act(() => { vi.advanceTimersByTime(250); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Claude 2/ }));

    const hub = await screen.findByTestId('inline-hub');
    expect(hub).toHaveTextContent('hub:/wt/FD-9');
    expect(hub).toHaveAttribute('data-mode', 'claude');
    expect(hub).toHaveAttribute('data-session', '2');
  });

  it('tells the hub to detach native previews while a card is showing', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow());
    fireEvent.click(worktreeRow());
    const hub = await screen.findByTestId('inline-hub');
    expect(hub).toHaveAttribute('data-modal-open', 'false');

    // The card floats beside the sidebar, over the hub — where a native
    // Browser view would paint straight over it.
    const row = worktreeRow().closest('.group')!;
    fireEvent.pointerEnter(row);
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(hub).toHaveAttribute('data-modal-open', 'true');

    fireEvent.pointerLeave(row);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hub).toHaveAttribute('data-modal-open', 'false');
  });

  it('opens diff & commit from the card', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(repoRow());

    fireEvent.pointerEnter(worktreeRow().closest('.group')!);
    act(() => { vi.advanceTimersByTime(250); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Changes' }));
    expect(noop).toHaveBeenCalledWith(expect.objectContaining({ path: '/wt/FD-9' }));
  });
});
