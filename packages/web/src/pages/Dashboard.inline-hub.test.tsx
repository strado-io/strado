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
    peers: [], loaded: true, error: null,
    refresh: vi.fn(),
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
    ]), start: vi.fn().mockResolvedValue({ status: 'starting' }), stop: vi.fn().mockResolvedValue({ status: 'stopping' }) },
    jira: { status: vi.fn().mockResolvedValue({ configured: false, baseUrl: null }) },
    intercom: {
      stations: vi.fn().mockResolvedValue({ stations: [
        { agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/wt/FD-9', worktreeName: 'FD-9', sessionId: '1',
          lifecycle: 'idle', live: true, needsYou: true, calls: [{ id: 'e1', title: 'Which database?', body: '', createdAt: 1 }], lastActivityAt: 1 },
      ], orphanCalls: [] }),
      escalations: { resolve: vi.fn().mockResolvedValue({}), dismiss: vi.fn().mockResolvedValue({}) },
    },
    tickets: {
      providers: vi.fn().mockResolvedValue([]),
      issues: vi.fn().mockResolvedValue({ issues: {}, missing: [], errors: {} }),
    },
    // The sidebar's org chip fetches on mount; reject like the local server
    // does when there's no signed-in account, so the chip renders nothing.
    org: { get: vi.fn().mockRejectedValue(new Error('no Strado account on this machine')) },
  },
}));
// Plain text goes to the model; here it reads "add repo …" as the Add repo dialog.
const askModel = vi.hoisted(() => vi.fn());
vi.mock('../lib/jarvis/modelClient', async () => ({
  ...(await vi.importActual<typeof import('../lib/jarvis/modelClient')>('../lib/jarvis/modelClient')),
  askModel: (...a: unknown[]) => askModel(...a),
}));
// The server side of a plan: spawning a tab answers with the new tab.
const spawn = vi.hoisted(() => vi.fn());
vi.mock('../lib/jarvis/serverPort', async () => {
  const actual = await vi.importActual<typeof import('../lib/jarvis/serverPort')>('../lib/jarvis/serverPort');
  return { ...actual, jarvisServerPort: (ws: string) => ({ ...actual.jarvisServerPort(ws), spawn: (...a: unknown[]) => spawn(...a) }) };
});
// The hub registers itself for the box, as the real one does once it is up.
const hubPlace = vi.hoisted(() => vi.fn());
function HubBridge({ path }: { path: string }) {
  useUiHubBridge({
    path, visible: () => [], layout: () => null, apply: async () => ({ applied: true }) as never,
    jarvis: {
      path, snapshot: () => null, restore: () => {}, place: (...a: unknown[]) => hubPlace(...a), focus: () => true,
      openBrowser: async () => null, closeLocal: () => {}, context: () => ({ tabs: [], focused: null }),
    },
  });
  return null;
}
// Stand in for the hub so the test asserts selection, not terminal internals.
vi.mock('./TerminalView', () => ({
  TerminalView: ({ worktree, onClose, modalOpen, mode, sessionId }: any) => (
    <div data-testid="inline-hub" data-modal-open={modalOpen ? 'true' : 'false'}
      data-mode={mode ?? ''} data-session={sessionId ?? ''}>
      hub:{worktree.path}
      <button onClick={onClose}>‹ Back</button>
      <HubBridge path={worktree.path} />
    </div>
  ),
}));

import { Dashboard } from './Dashboard';
import { useUiHubBridge } from '../contexts/UiControlContext';
import { __resetFocuses } from '../hooks/useFocuses';
import { releaseKeyboard } from '../components/CommandPalette';

afterEach(() => releaseKeyboard());

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

// The Worktrees page (the landing view) heads a section with the repo's
// name, so waiting on it means the tree has loaded.
// The Focus pill lives in the sidebar, which home hides: show it first.
const focusPill = (name: string) => {
  const open = screen.queryByLabelText('Open sidebar');
  if (open && screen.queryByRole('heading', { name: 'What do you want to do?' })) fireEvent.click(open);
  return screen.getByRole('button', { name: `Focus: ${name}` });
};
// Home hides the sidebar; these tests drive it, so show it (idempotent).
const repoRow = () => {
  const open = screen.queryByLabelText('Open sidebar');
  if (open && screen.queryByRole('heading', { name: 'What do you want to do?' })) fireEvent.click(open);
  return screen.getAllByText('Repo One')[0]!;
};
// Home with nothing open: the start screen's question means the tree has loaded.
const home = () => screen.findByRole('heading', { name: 'What do you want to do?' });
// The ticket id on the sidebar's Focus card (it lands once the Focus list has loaded).
// Home hides the sidebar, so open it (⌘B) when it is not there.
const sidebarRow = async () => {
  if (!screen.queryByRole('region', { name: 'Focus' })) fireEvent.keyDown(window, { key: 'b', metaKey: true });
  return within(await screen.findByRole('region', { name: 'Focus' })).findByText('FD-9');
};
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
    // These tests drive the sidebar; it starts hidden on a first run (the Dock is enough).
    localStorage.setItem('strado:sidebar-collapsed:v2', '0');
    __resetFocuses();
    seedFocus();
  });

  it('home: one question and the big command box, no Dock strip; Recent opens a worktree, and the box goes back to the Dock', async () => {
    localStorage.setItem('strado:worktree-lru', JSON.stringify({ '/wt/FD-9': Date.now() - 60_000 }));
    renderDashboard();
    expect(await screen.findByRole('heading', { name: 'What do you want to do?' })).toBeInTheDocument();
    const boxes = screen.getAllByLabelText('Global search');
    expect(boxes).toHaveLength(1); // no second box in the Dock
    expect(boxes[0]).toHaveAttribute('placeholder', 'Tell Strado…  e.g. open master and run dev   ⌘K');
    expect(screen.queryByTestId('dock')).not.toBeInTheDocument(); // one command area on home
    fireEvent.click(within(screen.getByRole('list', { name: 'Recent' })).getByRole('button', { name: /FD-9/ }));
    await screen.findByTestId('inline-hub');
    expect(screen.queryByRole('heading', { name: 'What do you want to do?' })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('dock')).getByLabelText('Global search')).toHaveAttribute('placeholder', 'Tell Strado what to do…  ⌘K');
  });

  it('home: "All worktrees →" shows the full list; "⚑ N waiting" selects the agent that needs you', async () => {
    renderDashboard();
    await screen.findByRole('heading', { name: 'What do you want to do?' });
    fireEvent.click(await screen.findByRole('button', { name: '⚑ 1 waiting' }));
    expect(await screen.findByTestId('agent-line')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All worktrees →' }));
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
  });

  it('home: typing "add repo <path>" in the big box asks the model, whose nav.addRepo opens the Add repo dialog on that path', async () => {
    askModel.mockResolvedValueOnce({ kind: 'plan', steps: [{ action: 'nav.addRepo', args: { path: '/code/x' } }], model: 'm', ms: 1 });
    renderDashboard();
    await screen.findByRole('heading', { name: 'What do you want to do?' });
    const box = screen.getByLabelText('Global search');
    fireEvent.change(box, { target: { value: 'add repo /code/x' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByLabelText('Repository path')).toHaveValue('/code/x');
    expect(askModel).toHaveBeenCalledWith('default', expect.objectContaining({ text: 'add repo /code/x' }), expect.anything());
  });

  it('home: a plan for a worktree opens it first, then its new tab appears there; the box moves to the Dock', async () => {
    spawn.mockResolvedValue({ tab: { worktreePath: '/wt/FD-9', mode: 'claude', sessionId: '3' } });
    hubPlace.mockResolvedValue({ ok: true });
    askModel.mockResolvedValueOnce({ kind: 'plan', steps: [{ action: 'tab.open', args: { mode: 'claude', worktree: 'FD-9', place: { split: 'right' } } }], model: 'm', ms: 1 });
    renderDashboard();
    await home();
    const box = screen.getByLabelText('Global search');
    fireEvent.change(box, { target: { value: 'open claude in FD-9' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
    await waitFor(() => expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ mode: 'claude', worktreePath: '/wt/FD-9' })));
    await waitFor(() => expect(hubPlace).toHaveBeenCalledWith({ worktreePath: '/wt/FD-9', mode: 'claude', sessionId: '3' }, expect.anything(), expect.any(Number)));
    expect(screen.queryByRole('heading', { name: 'What do you want to do?' })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('dock')).getByLabelText('Global search')).toBeInTheDocument();
  });

  it('home has no Dock location (Recent and "All worktrees →" list them); on the Worktrees page the Dock names none, as a label', async () => {
    renderDashboard();
    await home();
    expect(screen.queryByLabelText('No worktree open')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All worktrees →' }));
    const where = await within(await screen.findByTestId('dock')).findByLabelText('No worktree open');
    expect(where.tagName).toBe('SPAN');
  });

  it('home shows the sidebar as the user left it (stored open stays open); ⌘B toggles it there and remembers', async () => {
    renderDashboard(); // beforeEach stored the sidebar open
    await home();
    expect(await screen.findByRole('region', { name: 'Focus' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(screen.queryByRole('region', { name: 'Focus' })).not.toBeInTheDocument();
    expect(localStorage.getItem('strado:sidebar-collapsed:v2')).toBe('1');
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(await screen.findByRole('region', { name: 'Focus' })).toBeInTheDocument();
  });

  it('landing on home by a sidebar action (a Focus switch) keeps the sidebar; landing any other way (Back) hides it', async () => {
    fakeFocuses.reset([
      { id: 'f1', name: 'Working on', members: ['local:/wt/FD-9'], createdAt: 't', lastActiveAt: '2026-02-01' },
      { id: 'f2', name: 'Perf', members: [], createdAt: 't', lastActiveAt: '2026-01-01' },
    ]);
    renderDashboard();
    fireEvent.click(await sidebarRow());
    await screen.findByTestId('inline-hub');
    // From the sidebar's Focus pill: the hub closes and home shows, the sidebar stays under the hand.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Focus: Working on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Focus: Working on' }));
    const dialog = screen.getByRole('dialog', { name: 'Switch focus' });
    fireEvent.pointerDown(within(dialog).getByRole('button', { name: /Perf/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Perf/ }));
    await home();
    expect(screen.getByRole('region', { name: 'Focus' })).toBeInTheDocument();
  });

  it('Back from the hub lands on home with the sidebar as it was (open stays open)', async () => {
    renderDashboard();
    fireEvent.click(await sidebarRow());
    await screen.findByTestId('inline-hub');
    fireEvent.pointerDown(screen.getByRole('button', { name: '‹ Back' }));
    fireEvent.click(screen.getByRole('button', { name: '‹ Back' }));
    await home();
    expect(screen.getByRole('region', { name: 'Focus' })).toBeInTheDocument();
  });

  it('the sidebar starts hidden on the first run of this build, even with a stored "open" from before', async () => {
    localStorage.clear();
    localStorage.setItem('strado:sidebar-collapsed', '0');
    renderDashboard();
    await screen.findByRole('heading', { name: 'What do you want to do?' });
    expect(screen.queryByRole('region', { name: 'Focus' })).not.toBeInTheDocument();
  });

  it('first run: the sidebar starts hidden — the big box is all you need; ⌘B brings it back', async () => {
    localStorage.removeItem('strado:sidebar-collapsed:v2');
    renderDashboard();
    await home();
    expect(screen.queryByRole('region', { name: 'Focus' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Global search')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(await screen.findByRole('region', { name: 'Focus' })).toBeInTheDocument();
  });

  it('the Dock follows the open worktree: its location names it (with its project)', async () => {
    renderDashboard();
    await home();
    fireEvent.click(screen.getByRole('button', { name: 'All worktrees →' })); // the Dock (home has none)
    expect(await screen.findByLabelText('No worktree open')).toBeInTheDocument();
    fireEvent.click(await sidebarRow());
    await screen.findByTestId('inline-hub');
    expect(screen.getByLabelText('Worktree: Repo One / FD-9 · fd-9')).toBeInTheDocument();
  });

  it('shows the Worktrees page and no hub initially', async () => {
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

  it('Back returns to the Worktrees page', async () => {
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
    await home();
    fireEvent.click(screen.getByRole('button', { name: 'All worktrees →' }));
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    // No intercom drawer: Mission Control (the strip and the box) is where an agent asks for you.
    expect(screen.queryByRole('button', { name: /open intercom/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Code reviews' }));
    expect(await screen.findByRole('searchbox', { name: 'Search code reviews' })).toBeInTheDocument();
  });

  it('the command bar is always docked at the bottom; ⌘K puts the cursor in it (no modal)', async () => {
    renderDashboard();
    // Home: the box is the page, already focused.
    await home();
    expect(document.activeElement).toBe(screen.getByLabelText('Global search'));
    fireEvent.click(screen.getByRole('button', { name: 'All worktrees →' }));
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    const bar = within(screen.getByTestId('dock')).getByLabelText('Global search');
    expect(screen.getByTestId('command-bar')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(bar);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(bar);
    expect(screen.getByLabelText('Global search')).toBe(bar); // the same box, not a modal copy
  });

  it('picking a repo in the command palette starts a new worktree in it', async () => {
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(await sidebarRow());
    await screen.findByTestId('inline-hub');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    // An empty palette is the Focus list; repos show once the user types.
    fireEvent.change(await screen.findByLabelText('Global search'), { target: { value: 'repo' } });
    const repoEntries = await screen.findAllByText('Repo One');
    fireEvent.click(repoEntries.at(-1)!); // the palette's "Repos" result
    expect(noop).toHaveBeenCalledWith('r1');
  });

  it('with no Focus, opening a worktree asks for one first, then opens into the new Focus', async () => {
    fakeFocuses.reset([]);
    localStorage.removeItem('strado:active-focus-by-ws');
    renderDashboard();
    await home();
    await waitFor(() => expect(focusPill('none')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'FD-9' } });
    fireEvent.keyDown(screen.getByLabelText('Global search'), { key: 'Enter' });
    // No hub; the composer is up, seeded with the worktree being opened.
    const dialog = await screen.findByRole('dialog', { name: 'New focus' });
    expect(screen.queryByTestId('inline-hub')).toBeNull();
    expect(fakeFocuses.api.create).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('Focus name')).toHaveValue('FD-9');
    fireEvent.change(within(dialog).getByLabelText('Focus name'), { target: { value: 'Billing' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & switch' }));
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
    await waitFor(() => expect(fakeFocuses.api.create).toHaveBeenCalledWith('default', { name: 'Billing', members: ['local:/wt/FD-9'], ticket: { provider: 'jira', key: 'FD-9' } }));
    await waitFor(() => expect(focusPill('Billing')).toBeInTheDocument());
    expect(await sidebarRow()).toBeInTheDocument();
  });

  it('opening a worktree that is not in the active Focus adds it there', async () => {
    fakeFocuses.reset([{ id: 'f1', name: 'Billing', members: [], createdAt: 't', lastActiveAt: 't' }]);
    localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ default: 'f1' }));
    renderDashboard();
    await home();
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

  it('a stale persisted path (for this Focus) resolves to the Worktrees page', async () => {
    localStorage.setItem('strado:selected-by-focus', JSON.stringify({ f1: '/wt/GONE' }));
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    expect(screen.queryByTestId('inline-hub')).not.toBeInTheDocument();
  });

  it('a persisted worktree outside the active Focus is not restored, and the stored selection is kept', async () => {
    fakeFocuses.reset([{ id: 'f1', name: 'Billing', members: [], createdAt: 't', lastActiveAt: 't' }]);
    localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ default: 'f1' }));
    localStorage.setItem('strado:selected-by-focus', JSON.stringify({ f1: '/wt/FD-9' }));
    renderDashboard();
    await home();
    await waitFor(() => focusPill('Billing'));
    expect(screen.queryByTestId('inline-hub')).toBeNull();
    expect(JSON.parse(localStorage.getItem('strado:selected-by-focus')!)).toEqual({ f1: '/wt/FD-9' });
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
    expect(focusPill('Perf')).toBeInTheDocument();
  });

  it('switching back to a Focus reopens the worktree it had open', async () => {
    fakeFocuses.reset([
      { id: 'f1', name: 'Working on', members: ['local:/wt/FD-9'], createdAt: 't', lastActiveAt: '2026-02-01' },
      { id: 'f2', name: 'Perf', members: [], createdAt: 't', lastActiveAt: '2026-01-01' },
    ]);
    renderDashboard();
    await waitFor(() => expect(repoRow()).toBeInTheDocument());
    fireEvent.click(await sidebarRow());
    await screen.findByTestId('inline-hub');
    const switchTo = (from: string, to: RegExp) => {
      fireEvent.click(focusPill(from));
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Switch focus' })).getByRole('button', { name: to }));
    };
    switchTo('Working on', /Perf/);
    await waitFor(() => expect(screen.queryByTestId('inline-hub')).toBeNull());
    switchTo('Perf', /Working on/);
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
    expect(JSON.parse(localStorage.getItem('strado:selected-by-focus')!)).toEqual({ f1: '/wt/FD-9' });
  });
});

describe('Dashboard sidebar hover card', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('strado:sidebar-collapsed:v2', '0'); // drives the sidebar
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
