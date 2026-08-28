import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable so a test can switch workspaces mid-flight, the way a swipe does.
const current = {
  workspace: { id: 'ws-a', name: 'A', color: 'zinc', icon: 'A', defaultEditor: 'vscode', defaultPortBase: 3000, logDir: null },
};
const reviewList = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: current.workspace, allWorkspaces: [], switchTo: vi.fn() }),
}));

// repos answer per workspace; a test can make the NEXT repos.list call hang
// and resolve it by hand, to model a poll tick caught mid-switch.
let hangNext = false;
let hungResolve: ((repos: unknown[]) => void) | null = null;
const repoLists: Record<string, unknown[]> = {
  'ws-a': [{ id: 'ra', name: 'Repo A' }],
  'ws-b': [{ id: 'rb', name: 'Repo B' }],
};
vi.mock('../api', () => ({
  api: {
    repos: {
      list: vi.fn().mockImplementation((wsId: string) => {
        if (hangNext) {
          hangNext = false;
          return new Promise((resolve) => { hungResolve = resolve as (r: unknown[]) => void; });
        }
        return Promise.resolve(repoLists[wsId] ?? []);
      }),
    },
    worktrees: { list: vi.fn().mockResolvedValue([]) },
    jira: { status: vi.fn().mockResolvedValue({ configured: false, baseUrl: null }) },
    tickets: {
      providers: vi.fn().mockResolvedValue([]),
      issues: vi.fn().mockResolvedValue({ issues: {}, missing: [], errors: {} }),
    },
    reviews: {
      list: reviewList.mockImplementation((wsId: string) => Promise.resolve({
        reviews: [],
        repositories: [{
          repoId: wsId === 'ws-a' ? 'ra' : 'rb',
          repoName: wsId === 'ws-a' ? 'Repo A' : 'Repo B',
          provider: 'github', status: 'ok', counts: { open: 0, merged: 0, closed: 0 },
        }],
        counts: { open: 0, merged: 0, closed: 0 },
        page: 1, pageSize: 20, hasMore: false, pageLimit: null,
      })),
    },
    org: { get: vi.fn().mockRejectedValue(new Error('no account')) },
    runners: { remoteWorktrees: vi.fn().mockImplementation(() => new Promise(() => {})) },
  },
}));
vi.mock('./TerminalView', () => ({ TerminalView: () => <div data-testid="inline-hub" /> }));

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

describe('Dashboard poll vs workspace switch', () => {
  beforeEach(() => {
    localStorage.clear();
    current.workspace = { ...current.workspace, id: 'ws-a', name: 'A' };
    reviewList.mockClear();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    hangNext = false;
    hungResolve = null;
  });

  it('drops a poll tick that resolves after the workspace has switched', async () => {
    const view = renderDashboard();
    await act(async () => {}); // first load for ws-a lands
    expect(screen.getAllByText('Repo A').length).toBeGreaterThan(0);

    // The 15s re-sync fires while still on ws-a, but its reply hangs…
    hangNext = true;
    await act(async () => { vi.advanceTimersByTime(15_000); });

    // …and the user swipes to ws-b before it comes back.
    current.workspace = { ...current.workspace, id: 'ws-b', name: 'B' };
    view.rerender(
      <Dashboard
        onNewWorktree={noop} onShowLogs={noop}
        onMenu={noop} onOpenNote={noop} onOpenDiff={noop}
        onCloseOverlays={noop} onDeleteWorktree={noop}
        update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }}
      />,
    );
    await act(async () => {}); // ws-b's own load lands
    expect(screen.getAllByText('Repo B').length).toBeGreaterThan(0);

    // Old workspace's poll finally answers — it must be dropped, not painted.
    expect(hungResolve).not.toBeNull();
    await act(async () => { hungResolve!(repoLists['ws-a']!); });
    expect(screen.queryByText('Repo A')).toBeNull();
    expect(screen.getAllByText('Repo B').length).toBeGreaterThan(0);
  });

  it('never sends the previous workspace repository filter after switching', async () => {
    const view = renderDashboard();
    await act(async () => {});
    fireEvent.click(screen.getByText('Code reviews'));
    await waitFor(() => expect(screen.getByLabelText('Filter by repository')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Filter by repository'), { target: { value: 'ra' } });
    await waitFor(() => expect(reviewList).toHaveBeenCalledWith('ws-a', 'open', 1, '', 'ra'));

    current.workspace = { ...current.workspace, id: 'ws-b', name: 'B' };
    view.rerender(
      <Dashboard
        onNewWorktree={noop} onShowLogs={noop}
        onMenu={noop} onOpenNote={noop} onOpenDiff={noop}
        onCloseOverlays={noop} onDeleteWorktree={noop}
        update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }}
      />,
    );

    await waitFor(() => expect(reviewList).toHaveBeenCalledWith('ws-b', 'open', 1, '', 'all'));
    expect(reviewList.mock.calls.some((call) => call[0] === 'ws-b' && call[4] === 'ra')).toBe(false);
    expect(screen.getByLabelText('Filter by repository')).toHaveValue('all');
  });
});
