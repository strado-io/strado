import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable so a test can switch workspaces mid-flight, the way a swipe does.
const current = {
  workspace: { id: 'ws-a', name: 'A', color: 'zinc', icon: 'A', defaultEditor: 'vscode', defaultPortBase: 3000, logDir: null },
};
const reviewList = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: current.workspace, allWorkspaces: [], switchTo: vi.fn() }),
}));
// Dashboard now reads intercom state for the escalation badge/notification;
// these tests don't exercise Intercom, so stub a quiet, "loaded" context.
vi.mock('../contexts/IntercomContext', () => ({
  useIntercom: () => ({
    escalations: [], tasks: [], peers: [], loaded: true, error: null,
    refresh: vi.fn(), resolve: vi.fn(), dismiss: vi.fn(), createTask: vi.fn(),
    assignTask: vi.fn(), releaseTask: vi.fn(), doneTask: vi.fn(), cancelTask: vi.fn(),
  }),
}));

// repos answer per workspace; a test can make the NEXT repos.list call hang
// and resolve it by hand, to model a poll tick caught mid-switch.
let hangNext = false;
let hungResolve: ((repos: unknown[]) => void) | null = null;
const repoLists: Record<string, unknown[]> = {
  'ws-a': [{ id: 'ra', name: 'Repo A' }],
  'ws-b': [{ id: 'rb', name: 'Repo B' }],
};
// One worktree per workspace; each sits in that workspace's active Focus, so the sidebar shows it.
const worktreeLists: Record<string, unknown[]> = {
  'ws-a': [{ path: '/a/A-1', repoId: 'ra', branch: 'a-1', meta: { ticketId: 'A-1' }, process: { status: 'idle' }, tracked: true }],
  'ws-b': [{ path: '/b/B-1', repoId: 'rb', branch: 'b-1', meta: { ticketId: 'B-1' }, process: { status: 'idle' }, tracked: true }],
};
vi.mock('../api', () => ({
  api: {
    focuses: {
      list: async (ws: string) => [{ id: `f-${ws}`, name: 'Working on', members: [ws === 'ws-a' ? 'local:/a/A-1' : 'local:/b/B-1'], createdAt: 't', lastActiveAt: 't' }],
      create: vi.fn(), update: vi.fn(async () => ({})), remove: vi.fn(),
    },
    repos: {
      list: vi.fn().mockImplementation((wsId: string) => {
        if (hangNext) {
          hangNext = false;
          return new Promise((resolve) => { hungResolve = resolve as (r: unknown[]) => void; });
        }
        return Promise.resolve(repoLists[wsId] ?? []);
      }),
    },
    worktrees: { list: vi.fn().mockImplementation((wsId: string) => Promise.resolve(worktreeLists[wsId] ?? [])) },
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
import { __resetFocuses } from '../hooks/useFocuses';
import { openSidebarIfHome, showSidebarOnHome } from './dashboardTestHome';

const noop = vi.fn();
function renderDashboard() {
  const view = render(
    <Dashboard
      onNewWorktree={noop} onShowLogs={noop}
      onMenu={noop} onOpenNote={noop} onOpenDiff={noop}
      onCloseOverlays={noop} onDeleteWorktree={noop}
      update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }}
    />,
  );
  showSidebarOnHome();
  return view;
}

const workingOn = () => screen.getByRole('region', { name: 'Focus' });

describe('Dashboard poll vs workspace switch', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('strado:sidebar-collapsed:v2', '0'); // drives the sidebar
    __resetFocuses();
    localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ 'ws-a': 'f-ws-a', 'ws-b': 'f-ws-b' }));
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
    expect(within(workingOn()).getByText('A-1')).toBeInTheDocument();

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
    openSidebarIfHome(); // home hides it again in the new workspace
    expect(within(workingOn()).getByText('B-1')).toBeInTheDocument();

    // Old workspace's poll finally answers — it must be dropped, not painted.
    expect(hungResolve).not.toBeNull();
    await act(async () => { hungResolve!(repoLists['ws-a']!); });
    expect(screen.queryByText('A-1')).toBeNull();
    expect(screen.queryByText('Repo A')).toBeNull();
    expect(within(workingOn()).getByText('B-1')).toBeInTheDocument();
  });

  it('never sends the previous workspace repository filter after switching', async () => {
    const view = renderDashboard();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Code reviews' }));
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
