import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

// The workspace a test sees.
const wsMock = vi.hoisted(() => ({
  id: 'default',
  all: [] as { id: string; name: string }[],
  switchTo: (() => {}) as (id: string) => void,
}));
vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: { id: wsMock.id, name: wsMock.id === 'default' ? 'Default' : 'Other', color: 'zinc', icon: 'DF', defaultEditor: 'vscode', defaultPortBase: 3000, logDir: null },
    allWorkspaces: wsMock.all,
    switchTo: (id: string) => wsMock.switchTo(id),
  }),
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
// An in-memory Focus store standing in for the server's, so opens can be
// seen landing in the active Focus.
const fakeFocuses = vi.hoisted(() => {
  type F = { id: string; name: string; members: string[]; createdAt: string; lastActiveAt: string };
  const state = { focuses: [] as F[] };
  return {
    state,
    reset(focuses: F[] = []) { state.focuses = focuses; for (const fn of Object.values(this.api)) fn.mockClear(); },
    api: {
      list: vi.fn(async () => state.focuses),
      create: vi.fn(async (_ws: string, body: { name: string; members?: string[] }) => {
        const f: F = { id: `f${state.focuses.length + 1}`, name: body.name, members: [...new Set(body.members ?? [])], createdAt: 't', lastActiveAt: 't' };
        state.focuses = [...state.focuses, f];
        return f;
      }),
      update: vi.fn(async (_ws: string, id: string, patch: { name?: string; addMembers?: string[]; removeMembers?: string[]; touch?: boolean }) => {
        const f = state.focuses.find((x) => x.id === id);
        if (!f) throw new Error(`focus ${id} not found`);
        const drop = new Set(patch.removeMembers ?? []);
        const next = { ...f, name: patch.name ?? f.name, members: [...new Set([...f.members, ...(patch.addMembers ?? [])])].filter((m) => !drop.has(m)) };
        state.focuses = state.focuses.map((x) => (x.id === id ? next : x));
        return next;
      }),
      remove: vi.fn(async (_ws: string, id: string) => { state.focuses = state.focuses.filter((x) => x.id !== id); }),
    },
  };
});
vi.mock('../api', () => ({
  api: {
    focuses: fakeFocuses.api,
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
import { __resetFocuses } from '../hooks/useFocuses';

const noop = vi.fn();
const dashboard = () => (
  <Dashboard
    onNewWorktree={noop} onShowLogs={noop}
    onMenu={noop} onOpenNote={noop} onOpenDiff={noop}
    onCloseOverlays={noop} onDeleteWorktree={noop}
    update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }}
  />
);
function renderDashboard() {
  return render(dashboard());
}

// The sidebar no longer lists repos; the task board's per-repo chip still
// shows the name, so waiting on it means the tree has loaded.
const repoRow = () => screen.getAllByText('Repo One')[0]!;
// The ticket id on the sidebar's Focus card (it lands once the Focus list has loaded).
const sidebarRow = () => within(screen.getByRole('region', { name: 'Focus' })).findByText('FD-9');
// A Focus holding the one worktree, active on this device.
function seedFocus() {
  fakeFocuses.reset([{ id: 'f1', name: 'Working on', members: ['local:/wt/FD-9'], createdAt: 't', lastActiveAt: 't' }]);
  localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ default: 'f1' }));
}

describe('Dashboard inline hub', () => {
  beforeEach(() => {
    wsMock.id = 'default';
    wsMock.all = [];
    wsMock.switchTo = () => {};
    localStorage.clear();
    __resetFocuses();
    seedFocus();
  });

  it('shows the board and no hub initially', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument();
  });

  it('opens the inline hub when a worktree is selected in the tree', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(await sidebarRow());      // open worktree
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
  });

  it('Back returns to the board', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(await sidebarRow());
    fireEvent.click(await screen.findByText('‹ Back'));
    await waitFor(() => expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument());
  });

  it('tells the hub to detach native previews while the Add repo modal is open', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(await sidebarRow());
    const hub = await screen.findByTestId('inline-hub');
    expect(hub).toHaveAttribute('data-modal-open', 'false');

    // Add repo lives in the sidebar's blank-space menu now.
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Focus' }).parentElement!, { clientX: 5, clientY: 50 });
    fireEvent.click(screen.getByRole('button', { name: 'Add repo…' }));
    await screen.findByRole('heading', { name: 'Add repo' });
    expect(hub).toHaveAttribute('data-modal-open', 'true');

    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(hub).toHaveAttribute('data-modal-open', 'false'));
  });

  it('opens the workspace-level code reviews page from the sidebar', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    // Intercom is a workspace action in Tasks, even with no running servers.
    expect(screen.getByRole('button', { name: 'Open intercom' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Code reviews' }));
    expect(await screen.findByRole('searchbox', { name: 'Search code reviews' })).toBeInTheDocument();
    // The page has its own toolbar — the shared bar would just be a blank strip.
    expect(document.querySelector('[data-filter-bar]')).not.toBeInTheDocument();
  });

  it('picking a repo in the command palette starts a new worktree in it', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(await sidebarRow());
    await screen.findByTestId('inline-hub');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const repoEntries = await screen.findAllByText('Repo One');
    fireEvent.click(repoEntries.at(-1)!); // the palette's "Repos" result
    expect(noop).toHaveBeenCalledWith('r1');
  });

  it('with no Focus, opening a worktree asks for one first, then opens into the new Focus', async () => {
    fakeFocuses.reset([]);
    localStorage.removeItem('strado:active-focus-by-ws');
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Focus: none' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-9' } });
    fireEvent.keyDown(screen.getByLabelText('Global search'), { key: 'Enter' });
    // No hub; the Focus switcher is up, ready for a name.
    const field = await screen.findByLabelText('New focus name');
    expect(screen.queryByTestId('inline-hub')).toBeNull();
    expect(fakeFocuses.api.create).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'Billing' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
    await waitFor(() => expect(fakeFocuses.api.update).toHaveBeenCalledWith('default', 'f1', { addMembers: ['local:/wt/FD-9'] }));
    expect(await screen.findByRole('button', { name: 'Focus: Billing' })).toBeInTheDocument();
    expect(await sidebarRow()).toBeInTheDocument();
  });

  it('opening a worktree that is not in the active Focus adds it there', async () => {
    fakeFocuses.reset([{ id: 'f1', name: 'Billing', members: [], createdAt: 't', lastActiveAt: 't' }]);
    localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ default: 'f1' }));
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-9' } });
    fireEvent.keyDown(screen.getByLabelText('Global search'), { key: 'Enter' });
    await screen.findByTestId('inline-hub');
    await waitFor(() => expect(fakeFocuses.api.update).toHaveBeenCalledWith('default', 'f1', { addMembers: ['local:/wt/FD-9'] }));
    expect(await sidebarRow()).toBeInTheDocument();
    expect(fakeFocuses.api.create).not.toHaveBeenCalled();
  });

  it('opening a worktree leaves the Usage page, so its icon is no longer marked current', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    const usage = () => screen.getByRole('button', { name: 'Usage' });
    fireEvent.click(usage());
    expect(usage()).toHaveAttribute('aria-current', 'page');
    fireEvent.click(await sidebarRow());
    await screen.findByTestId('inline-hub');
    expect(usage()).not.toHaveAttribute('aria-current');
  });

  it('persists selection and restores it on remount', async () => {
    const { unmount } = renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(await sidebarRow());
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

  it('a persisted worktree outside the active Focus is not restored, and the stored selection is kept', async () => {
    fakeFocuses.reset([{ id: 'f1', name: 'Billing', members: [], createdAt: 't', lastActiveAt: 't' }]);
    localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ default: 'f1' }));
    localStorage.setItem('strado:selected-by-ws', JSON.stringify({ default: '/wt/FD-9' }));
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    await screen.findByRole('button', { name: 'Focus: Billing' });
    expect(screen.queryByTestId('inline-hub')).toBeNull();
    expect(JSON.parse(localStorage.getItem('strado:selected-by-ws')!)).toEqual({ default: '/wt/FD-9' });
  });

  it('switching to a Focus that does not hold the open worktree closes the hub', async () => {
    fakeFocuses.reset([
      { id: 'f1', name: 'Working on', members: ['local:/wt/FD-9'], createdAt: 't', lastActiveAt: '2026-02-01' },
      { id: 'f2', name: 'Perf', members: [], createdAt: 't', lastActiveAt: '2026-01-01' },
    ]);
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(await sidebarRow());
    await screen.findByTestId('inline-hub');
    fireEvent.click(screen.getByRole('button', { name: 'Focus: Working on' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Switch focus' })).getByRole('button', { name: /Perf/ }));
    await waitFor(() => expect(screen.queryByTestId('inline-hub')).toBeNull());
    expect(screen.getByRole('button', { name: 'Focus: Perf' })).toBeInTheDocument();
  });
});

describe('Dashboard sidebar hover card', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetFocuses();
    seedFocus();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the hub on the exact session picked in the card', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());

    const row = (await sidebarRow()).closest('.group')!;
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
    fireEvent.click(await sidebarRow());
    const hub = await screen.findByTestId('inline-hub');
    expect(hub).toHaveAttribute('data-modal-open', 'false');

    // The card floats beside the sidebar, over the hub — where a native
    // Browser view would paint straight over it.
    const row = (await sidebarRow()).closest('.group')!;
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

    fireEvent.pointerEnter((await sidebarRow()).closest('.group')!);
    act(() => { vi.advanceTimersByTime(250); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Changes' }));
    expect(noop).toHaveBeenCalledWith(expect.objectContaining({ path: '/wt/FD-9' }));
  });
});
