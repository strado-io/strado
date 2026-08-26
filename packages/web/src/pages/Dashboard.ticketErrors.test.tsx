import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { publishTickets } from '../hooks/tickets';

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: { id: 'default', name: 'Default', color: 'zinc', icon: 'DF', defaultEditor: 'vscode', defaultPortBase: 3000, logDir: null },
    allWorkspaces: [],
    switchTo: vi.fn(),
  }),
}));

const ticketsIssues = vi.fn();
vi.mock('../api', () => ({
  api: {
    repos: { list: vi.fn().mockResolvedValue([{ id: 'r1', name: 'Repo One' }]) },
    worktrees: { list: vi.fn().mockResolvedValue([
      { path: '/wt/ENG-45', repoId: 'r1', branch: 'eng-45', meta: { ticketId: 'ENG-45', ticketProvider: 'linear' },
        process: { status: 'idle' }, tracked: true },
    ]) },
    jira: { status: vi.fn().mockResolvedValue({ configured: false, baseUrl: null }) },
    tickets: {
      providers: vi.fn().mockResolvedValue([{ provider: 'linear', configured: true, label: 'Linear' }]),
      issues: (...a: unknown[]) => ticketsIssues(...a),
      linearConfig: vi.fn().mockResolvedValue({ connected: true, workspaceName: 'Acme' }),
    },
    org: { get: vi.fn().mockRejectedValue(new Error('no Strado account on this machine')) },
  },
}));
vi.mock('./TerminalView', () => ({
  TerminalView: () => <div data-testid="inline-hub" />,
}));

import { Dashboard } from './Dashboard';

const noop = vi.fn();
function renderDashboard() {
  return render(
    <Dashboard
      onNewWorktree={noop} onOpenWorkspaces={noop} onShowLogs={noop}
      onMenu={noop} onOpenNote={noop} onOpenDiff={noop}
      onCloseOverlays={noop} onDeleteWorktree={noop}
      update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }}
    />,
  );
}

describe('Dashboard ticket provider errors', () => {
  beforeEach(() => {
    localStorage.clear();
    ticketsIssues.mockReset();
  });

  it('renders a reconnect banner for a provider whose poll failed', async () => {
    ticketsIssues.mockResolvedValue({ issues: {}, missing: [], errors: { linear: 'Linear rejected the token' } });
    renderDashboard();
    await waitFor(() => expect(screen.getAllByText('Repo One').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('Tasks'));

    expect(await screen.findByText(/Linear connection failed/)).toBeInTheDocument();

    // clicking it opens the same settings modal other Dashboard affordances use
    fireEvent.click(screen.getByText(/Linear connection failed/));
    expect(await screen.findByText('Connections')).toBeInTheDocument();
  });

  it('clears the banner once a later poll comes back clean', async () => {
    ticketsIssues.mockResolvedValue({ issues: {}, missing: [], errors: { linear: 'Linear rejected the token' } });
    renderDashboard();
    await waitFor(() => expect(screen.getAllByText('Repo One').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('Tasks'));
    expect(await screen.findByText(/Linear connection failed/)).toBeInTheDocument();

    // the recovered poll's response replaces the stale error wholesale — this
    // is exactly what the Dashboard's own poll effect publishes once the
    // batch endpoint stops reporting the provider as failing.
    publishTickets({ issues: {}, missing: [], providerErrors: {} });
    await waitFor(() => expect(screen.queryByText(/Linear connection failed/)).not.toBeInTheDocument());
  });

  it('does not render a banner when the batch has no errors', async () => {
    ticketsIssues.mockResolvedValue({ issues: {}, missing: [], errors: {} });
    renderDashboard();
    await waitFor(() => expect(screen.getAllByText('Repo One').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('Tasks'));
    await waitFor(() => expect(ticketsIssues).toHaveBeenCalled());
    expect(screen.queryByText(/connection failed/)).not.toBeInTheDocument();
  });
});
