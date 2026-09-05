import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable so a test can switch workspaces mid-flight, the way a swipe does.
const current = {
  workspace: { id: 'ws-a', name: 'A', color: 'zinc', icon: 'A', defaultEditor: 'vscode', defaultPortBase: 3000, logDir: null },
};
vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: current.workspace, allWorkspaces: [], switchTo: vi.fn() }),
}));

// The remote-worktrees call resolves only by hand, so a test can hold the
// sidebar in its "first runner fetch still in flight" state.
let resolveRemote: ((v: { runners: unknown[]; worktrees: unknown[] }) => void) | null = null;
vi.mock('../api', () => ({
  api: {
    repos: { list: vi.fn().mockResolvedValue([{ id: 'ra', name: 'Repo A' }]) },
    worktrees: { list: vi.fn().mockResolvedValue([]) },
    jira: { status: vi.fn().mockResolvedValue({ configured: false, baseUrl: null }) },
    tickets: {
      providers: vi.fn().mockResolvedValue([]),
      issues: vi.fn().mockResolvedValue({ issues: {}, missing: [], errors: {} }),
    },
    org: { get: vi.fn().mockRejectedValue(new Error('no account')) },
    runners: {
      remoteWorktrees: vi.fn().mockImplementation(
        () => new Promise((resolve) => { resolveRemote = resolve as typeof resolveRemote; }),
      ),
    },
  },
}));
vi.mock('./TerminalView', () => ({ TerminalView: () => <div data-testid="inline-hub" /> }));

import { api } from '../api';
import { Dashboard } from './Dashboard';

const noop = vi.fn();
function dashboard(remoteRefreshKey = 0) {
  return (
    <Dashboard
      remoteRefreshKey={remoteRefreshKey}
      onNewWorktree={noop} onShowLogs={noop}
      onMenu={noop} onOpenNote={noop} onOpenDiff={noop}
      onCloseOverlays={noop} onDeleteWorktree={noop}
      update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }}
    />
  );
}
function renderDashboard(remoteRefreshKey = 0) {
  return render(
    dashboard(remoteRefreshKey),
  );
}

describe('Dashboard runner loading state', () => {
  beforeEach(() => {
    localStorage.clear();
    current.workspace = { ...current.workspace, id: 'ws-a', name: 'A' };
    resolveRemote = null;
    vi.mocked(api.runners.remoteWorktrees).mockClear();
  });
  afterEach(() => { resolveRemote = null; });

  it('shows the runner loading hint until the first fetch settles, then drops it', async () => {
    renderDashboard();
    await act(async () => {}); // local load lands; the remote fetch starts and hangs

    expect(screen.getByText('Checking runners…')).toBeInTheDocument();

    await act(async () => { resolveRemote!({ runners: [], worktrees: [] }); });
    expect(screen.queryByText('Checking runners…')).toBeNull();
  });

  it('starts loading again on a workspace switch instead of showing stale rows', async () => {
    const view = renderDashboard();
    await act(async () => {});
    await act(async () => { resolveRemote!({ runners: [], worktrees: [] }); });
    expect(screen.queryByText('Checking runners…')).toBeNull();

    current.workspace = { ...current.workspace, id: 'ws-b', name: 'B' };
    view.rerender(
      <Dashboard
        onNewWorktree={noop} onShowLogs={noop}
        onMenu={noop} onOpenNote={noop} onOpenDiff={noop}
        onCloseOverlays={noop} onDeleteWorktree={noop}
        update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }}
      />,
    );
    await act(async () => {}); // ws-b local load lands; its remote fetch hangs

    expect(screen.getByText('Checking runners…')).toBeInTheDocument();
  });

  it('revalidates remote rows immediately when the refresh key changes', async () => {
    const view = renderDashboard(0);
    await act(async () => {});
    await act(async () => { resolveRemote!({ runners: [], worktrees: [] }); });
    expect(api.runners.remoteWorktrees).toHaveBeenCalledTimes(1);

    view.rerender(dashboard(1));
    await act(async () => {});

    expect(api.runners.remoteWorktrees).toHaveBeenCalledTimes(2);
  });
});
