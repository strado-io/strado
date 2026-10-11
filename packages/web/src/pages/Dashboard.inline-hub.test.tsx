import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

// The workspace a test sees; one test switches it to drive a cross-workspace ⌘K open.
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
// Groups fail to load by default (no groups, and each mount retries, as
// before); a test can resolve them to seed a parked group.
const groupsList = vi.hoisted(() => vi.fn());
const groupsUpdate = vi.hoisted(() => vi.fn());
// Pass-through CommandPalette that records the props it was last given, so a
// test can see the filter the Dashboard handed it.
const paletteProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('../components/CommandPalette', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../components/CommandPalette')>();
  return {
    ...mod,
    CommandPalette: (props: Parameters<typeof mod.CommandPalette>[0]) => {
      paletteProps.last = props as unknown as Record<string, unknown>;
      return <mod.CommandPalette {...props} />;
    },
  };
});
vi.mock('../api', () => ({
  api: {
    groups: { list: groupsList, update: groupsUpdate },
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
import { __resetFocusGroups } from '../hooks/useFocusGroups';

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
// The ticket id: the sidebar's Working on row first, task board row second.
const worktreeRow = () => screen.getAllByText('FD-9')[0]!;

describe('Dashboard inline hub', () => {
  beforeEach(() => {
    __resetFocusGroups();
    groupsList.mockReset().mockRejectedValue(new Error('no groups'));
    groupsUpdate.mockReset();
    wsMock.id = 'default';
    wsMock.all = [];
    wsMock.switchTo = () => {};
    paletteProps.last = null;
    localStorage.clear();
    localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ default: ['local:/wt/FD-9'] }));
  });

  it('shows the board and no hub initially', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument();
  });

  it('opens the inline hub when a worktree is selected in the tree', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(worktreeRow());      // open worktree
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
  });

  it('Back returns to the board', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(worktreeRow());
    fireEvent.click(await screen.findByText('‹ Back'));
    await waitFor(() => expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument());
  });

  it('tells the hub to detach native previews while the Add repo modal is open', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(worktreeRow());
    const hub = await screen.findByTestId('inline-hub');
    expect(hub).toHaveAttribute('data-modal-open', 'false');

    fireEvent.click(screen.getByLabelText('Add repo'));
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
    fireEvent.click(worktreeRow());
    await screen.findByTestId('inline-hub');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const repoEntries = await screen.findAllByText('Repo One');
    fireEvent.click(repoEntries.at(-1)!); // the palette's "Repos" result
    expect(noop).toHaveBeenCalledWith('r1');
  });

  it('opening a worktree from search puts it in Working on', async () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', '{}');
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    expect(screen.queryByText('FD-9', { selector: '.font-mono' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-9' } });
    fireEvent.keyDown(screen.getByLabelText('Global search'), { key: 'Enter' });
    await screen.findByTestId('inline-hub');
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({ default: ['local:/wt/FD-9'] });
    expect(within(screen.getByRole('region', { name: 'Working on' })).getByText('FD-9')).toBeInTheDocument();
  });

  it('⌘K after the parked-groups link reopens the full palette, not the group filter', async () => {
    groupsList.mockResolvedValue([
      { id: 'g1', name: 'FX-900', members: ['local:/wt/OTHER'], createdAt: 't', state: 'parked' },
    ]);
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: '1 more' }));
    await screen.findByLabelText('Global search');
    expect(paletteProps.last?.filter).toBe('groups');
    fireEvent.keyDown(window, { key: 'k', metaKey: true }); // ⌘K closes it
    expect(screen.queryByLabelText('Global search')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', metaKey: true }); // ⌘K opens it again
    await screen.findByLabelText('Global search');
    expect(paletteProps.last?.filter).toBeNull();
  });

  it('opening a parked group\'s member from ⌘K brings the group back to Working on', async () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', '{}');
    let state = 'parked';
    groupsList.mockImplementation(async () => [
      { id: 'g1', name: 'FX-900', members: ['local:/wt/FD-9'], createdAt: 't', state },
    ]);
    groupsUpdate.mockImplementation(async (_ws: string, id: string, patch: { state: string }) => {
      state = patch.state;
      return { id, name: 'FX-900', members: ['local:/wt/FD-9'], createdAt: 't', state };
    });
    renderDashboard();
    await screen.findByRole('button', { name: '1 more' });
    expect(within(screen.getByRole('region', { name: 'Working on' })).queryByText('FX-900')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-9' } });
    fireEvent.keyDown(screen.getByLabelText('Global search'), { key: 'Enter' });
    await screen.findByTestId('inline-hub');
    await waitFor(() => expect(groupsUpdate).toHaveBeenCalledWith('default', 'g1', { state: 'working' }));
    const workingOn = screen.getByRole('region', { name: 'Working on' });
    await waitFor(() => expect(within(workingOn).getByText('FX-900')).toBeInTheDocument());
    expect(within(workingOn).getByText('FD-9')).toBeInTheDocument();
    // In a group now, so it gets no loose row of its own.
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({});
  });

  it('promoting a parked group keeps the active group when a working group holds the worktree', async () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', '{}');
    localStorage.setItem('strado:focus-group-active', JSON.stringify({ default: 'gA' }));
    groupsList.mockResolvedValue([
      { id: 'gA', name: 'FX-1 working', members: ['local:/wt/FD-9'], createdAt: 't', state: 'working' },
      { id: 'gB', name: 'FX-2 parked', members: ['local:/wt/FD-9'], createdAt: 't', state: 'parked' },
    ]);
    groupsUpdate.mockImplementation(async (_ws: string, id: string) =>
      ({ id, name: 'FX-2 parked', members: ['local:/wt/FD-9'], createdAt: 't', state: 'working' }));
    renderDashboard();
    await screen.findByRole('button', { name: '1 more' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-9' } });
    fireEvent.keyDown(screen.getByLabelText('Global search'), { key: 'Enter' });
    await screen.findByTestId('inline-hub');
    await waitFor(() => expect(groupsUpdate).toHaveBeenCalledWith('default', 'gB', { state: 'working' }));
    expect(JSON.parse(localStorage.getItem('strado:focus-group-active')!)).toEqual({ default: 'gA' });
  });

  it('a ⌘K open in another workspace waits for that workspace\'s groups before promoting', async () => {
    localStorage.setItem('strado:pinned-worktrees-by-ws', '{}');
    wsMock.all = [{ id: 'default', name: 'Default' }, { id: 'other', name: 'Other' }];
    let resolveOther: (gs: unknown[]) => void = () => {};
    groupsList.mockImplementation((wsId: string) => wsId === 'other'
      ? new Promise((r) => { resolveOther = r; })
      : Promise.reject(new Error('no groups')));
    const parked = { id: 'g9', name: 'FX-9 other', members: ['local:/wt/FD-9'], createdAt: 't', state: 'parked' };
    groupsUpdate.mockImplementation(async () => ({ ...parked, state: 'working' }));
    const switched = vi.fn();
    wsMock.switchTo = switched;
    const { rerender } = renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-9' } });
    fireEvent.click(await screen.findByText(/Other · switch & open/));
    expect(switched).toHaveBeenCalledWith('other');
    wsMock.id = 'other';
    rerender(dashboard());
    // Other's groups have not loaded: the open must not run yet, or it would
    // see no groups and give the worktree a loose row instead.
    await act(async () => {});
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({});
    await act(async () => { resolveOther([parked]); });
    await screen.findByTestId('inline-hub');
    await waitFor(() => expect(groupsUpdate).toHaveBeenCalledWith('other', 'g9', { state: 'working' }));
    expect(JSON.parse(localStorage.getItem('strado:pinned-worktrees-by-ws')!)).toEqual({});
  });

  it('persists selection and restores it on remount', async () => {
    const { unmount } = renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
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
    __resetFocusGroups();
    groupsList.mockReset().mockRejectedValue(new Error('no groups'));
    localStorage.clear();
    localStorage.setItem('strado:pinned-worktrees-by-ws', JSON.stringify({ default: ['local:/wt/FD-9'] }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the hub on the exact session picked in the card', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());

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

    fireEvent.pointerEnter(worktreeRow().closest('.group')!);
    act(() => { vi.advanceTimersByTime(250); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Changes' }));
    expect(noop).toHaveBeenCalledWith(expect.objectContaining({ path: '/wt/FD-9' }));
  });
});
