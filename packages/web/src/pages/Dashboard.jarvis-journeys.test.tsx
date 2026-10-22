import * as React from 'react';
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
const intercomPeers = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../contexts/IntercomContext', () => ({
  useIntercom: () => ({
    peers: intercomPeers.list, loaded: true, error: null,
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
      { path: '/wt/master', repoId: 'r1', branch: 'master', meta: {}, process: { status: 'idle' }, tracked: true },
      { path: '/wt/main', repoId: 'r1', branch: 'main', meta: {}, process: { status: 'idle' }, tracked: true },
    ]), start: vi.fn().mockResolvedValue({ status: 'starting' }), stop: vi.fn().mockResolvedValue({ status: 'stopping' }),
    sessionBusy: vi.fn().mockResolvedValue({ busy: false }) },
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
    profile: { get: vi.fn().mockResolvedValue({ fullName: 'Kam', callMe: '', telemetryOptOut: false, jarvisLocalOnly: false }), save: vi.fn(async (p: object) => p) },
    modelCredential: { get: vi.fn().mockResolvedValue({ present: true, last4: 'abcd' }) },
  },
}));
// Settings stands in as a counter: the box changing a setting must refresh the open page.
const settingsMounts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../components/settings/SettingsPage', async () => {
  const React = await import('react');
  return {
    SettingsPage: ({ section }: { section: string }) => {
      React.useEffect(() => { settingsMounts.n += 1; }, []);
      return <div data-testid="settings-page">settings:{section}</div>;
    },
  };
});
// Plain text goes to the model; here it reads "add repo …" as the Add repo dialog.
const askModel = vi.hoisted(() => vi.fn());
vi.mock('../lib/jarvis/modelClient', async () => ({
  ...(await vi.importActual<typeof import('../lib/jarvis/modelClient')>('../lib/jarvis/modelClient')),
  askModel: (...a: unknown[]) => askModel(...a),
}));
// The server side of a plan: spawning a tab answers with the new tab.
const spawn = vi.hoisted(() => vi.fn());
const message = vi.hoisted(() => vi.fn());
const closeTab = vi.hoisted(() => vi.fn());
vi.mock('../lib/jarvis/serverPort', async () => {
  const actual = await vi.importActual<typeof import('../lib/jarvis/serverPort')>('../lib/jarvis/serverPort');
  return { ...actual, jarvisServerPort: (ws: string) => ({ ...actual.jarvisServerPort(ws), spawn: (...a: unknown[]) => spawn(...a), message: (...a: unknown[]) => message(...a), close: (...a: unknown[]) => closeTab(...a) }) };
});
// The hub registers itself for the box, as the real one does once it is up.
const hubPlace = vi.hoisted(() => vi.fn());
const hubFocus = vi.hoisted(() => vi.fn());
// The hub: a Shell (focused) and a Claude tab, each a real pane the keyboard can land in.
function HubBridge({ path }: { path: string }) {
  const focused = React.useRef({ worktreePath: path, mode: 'shell' as const, sessionId: '1' } as { worktreePath: string; mode: 'shell' | 'claude'; sessionId: string });
  useUiHubBridge({
    path, visible: () => [], layout: () => null, apply: async () => ({ applied: true }) as never,
    jarvis: {
      path, snapshot: () => null, restore: () => {}, place: (...a: unknown[]) => hubPlace(...a),
      focus: (ref: { worktreePath: string; mode: 'shell' | 'claude'; sessionId: string }) => { hubFocus(ref); focused.current = ref; return true; },
      openBrowser: async () => null, closeLocal: () => {},
      context: () => ({
        tabs: [
          { worktreePath: path, mode: 'shell', sessionId: '1', label: 'Shell', busy: false },
          { worktreePath: path, mode: 'claude', sessionId: '1', label: 'Claude', busy: false },
        ],
        focused: focused.current,
      }),
    },
  });
  return (
    <>
      <div data-pane-key="shell:1"><textarea aria-label="shell 1 terminal" /></div>
      <div data-pane-key="claude:1"><textarea aria-label="claude 1 terminal" /></div>
    </>
  );
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

// The Usage page fetches a lot; for these journeys it only has to show up.
vi.mock('../components/usage/UsagePage', () => ({ UsagePage: () => <div data-testid="usage-page">usage</div> }));

/** The one visible command box (home's big box, the Dock's, or Settings' strip). */
const box = () => screen.getByLabelText('Global search') as HTMLInputElement;
/** Type a request and press ⏎; a confirm row (if any) gets a second ⏎. */
async function say(text: string) {
  act(() => box().focus());
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  if (screen.queryByText(/wants to:|Confirm:/)) fireEvent.keyDown(box(), { key: 'Enter' });
}
const plan = (...steps: { action: string; args: Record<string, unknown> }[]) => ({ kind: 'plan' as const, steps, model: 'typesafe/jev-1.14', ms: 300 });
async function openFd9FromHome() {
  await home();
  fireEvent.click(within(screen.getByRole('list', { name: 'Recent' })).getByRole('button', { name: /FD-9/ }));
  await screen.findByTestId('inline-hub');
}

describe('Jarvis journeys (the box, end to end against fake ports)', () => {
  beforeEach(() => {
    wsMock.id = 'default';
    wsMock.all = [];
    wsMock.switchTo = () => {};
    localStorage.clear();
    localStorage.setItem('strado:worktree-lru', JSON.stringify({ '/wt/FD-9': Date.now() - 60_000 }));
    __resetFocuses();
    seedFocus();
    askModel.mockReset();
    spawn.mockReset().mockResolvedValue({ tab: { worktreePath: '/wt/FD-9', mode: 'shell', sessionId: '2' } });
    hubPlace.mockReset().mockResolvedValue({ ok: true });
    hubFocus.mockReset();
    settingsMounts.n = 0;
  });

  it('home → "open FD-9 and run dev": the worktree opens, its dev server starts, the keyboard stays in the box (now in the Dock)', async () => {
    const { api } = await import('../api');
    askModel.mockResolvedValueOnce(plan({ action: 'nav.worktree', args: { name: 'FD-9' } }, { action: 'server.start', args: {} }));
    renderDashboard();
    await home();
    await say('open FD-9 and run dev');
    expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
    await waitFor(() => expect(api.worktrees.start).toHaveBeenCalledWith('default', '/wt/FD-9'));
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByTestId('dock')).getByLabelText('Global search')));
    // The Dock's box took the keyboard by itself: quiet, so no popover covers a Browser preview.
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
  });

  it('"open a shell in a new tab": spawned in this worktree and placed as a tab', async () => {
    askModel.mockResolvedValueOnce(plan({ action: 'tab.open', args: { mode: 'shell', split: 'tab' } }));
    renderDashboard();
    await openFd9FromHome();
    await say('open a shell in a new tab');
    await waitFor(() => expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ mode: 'shell', worktreePath: '/wt/FD-9' })));
    await waitFor(() => expect(hubPlace).toHaveBeenCalledWith({ worktreePath: '/wt/FD-9', mode: 'shell', sessionId: '2' }, expect.objectContaining({ split: 'tab' }), expect.any(Number)));
  });

  it('"focus claude": the Claude tab is focused and the keyboard moves into it', async () => {
    askModel.mockResolvedValueOnce(plan({ action: 'tab.focus', args: { tab: 'Claude' } }));
    renderDashboard();
    await openFd9FromHome();
    await say('focus claude');
    await waitFor(() => expect(hubFocus).toHaveBeenCalledWith(expect.objectContaining({ mode: 'claude', sessionId: '1' })));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('claude 1 terminal')));
  });

  it('"open usage": the Usage page shows and the keyboard stays in the box', async () => {
    askModel.mockResolvedValueOnce(plan({ action: 'nav.page', args: { page: 'usage' } }));
    renderDashboard();
    await home();
    await say('open usage');
    expect(await screen.findByTestId('usage-page')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(box()).toHaveValue('');
  });

  it('Settings open → "change my name to Ada": saved, and the open page refreshes to show it', async () => {
    const { api } = await import('../api');
    askModel
      .mockResolvedValueOnce(plan({ action: 'settings.open', args: { section: 'profile' } }))
      .mockResolvedValueOnce(plan({ action: 'settings.set', args: { setting: 'profile.name', value: 'Ada' } }));
    renderDashboard();
    await home();
    await say('open my profile settings');
    expect(await screen.findByTestId('settings-page')).toHaveTextContent('settings:profile');
    const mountsBefore = settingsMounts.n;
    await say('change my name to Ada');
    await waitFor(() => expect(api.profile.save).toHaveBeenCalledWith({ fullName: 'Ada' }));
    await waitFor(() => expect(settingsMounts.n).toBeGreaterThan(mountsBefore));
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });

  it('voice: hold ⌥Space on home, speak, release → the words wait in the box; ⏎ runs them as if typed', async () => {
    let listener: ((e: StradoVoiceEvent) => void) | null = null;
    const voice = {
      available: true, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(),
      onEvent: (cb: (e: StradoVoiceEvent) => void) => { listener = cb; return () => { listener = null; }; },
    };
    (window as unknown as { strado?: unknown }).strado = { voice };
    try {
      askModel.mockResolvedValueOnce(plan({ action: 'nav.worktree', args: { name: 'FD-9' } }));
      renderDashboard();
      await home();
      fireEvent.keyDown(document.body, { key: ' ', code: 'Space', altKey: true });
      expect(voice.start).toHaveBeenCalledWith(expect.arrayContaining(['FD-9']));
      expect(screen.getByText('Listening…')).toBeInTheDocument();
      act(() => { listener?.({ type: 'partial', text: 'open' }); });
      act(() => { listener?.({ type: 'partial', text: 'open FD-9' }); });
      expect(box()).toHaveValue('open FD-9');
      fireEvent.keyUp(window, { key: ' ', code: 'Space' });
      expect(voice.stop).toHaveBeenCalled();
      act(() => { listener?.({ type: 'final', text: 'open FD-9' }); });
      expect(box()).toHaveValue('open FD-9');
      // The model may be asked ahead (so ⏎ is quick), but nothing runs until ⏎.
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      expect(screen.queryByTestId('inline-hub')).toBeNull();
      fireEvent.keyDown(box(), { key: 'Enter' });
      expect(await screen.findByTestId('inline-hub')).toHaveTextContent('hub:/wt/FD-9');
      expect(askModel).toHaveBeenCalledTimes(1); // ⏎ reused the early answer
      expect(askModel).toHaveBeenCalledWith('default', expect.objectContaining({ text: 'open FD-9' }), expect.anything());
    } finally {
      delete (window as unknown as { strado?: unknown }).strado;
    }
  });

  it('Focus editing: create "release" with master, add main to it, delete it (confirmed); the sidebar follows each step', async () => {
    askModel
      .mockResolvedValueOnce(plan({ action: 'focus.edit', args: { op: 'create', focus: null, name: 'release', worktrees: ['master'] } }))
      .mockResolvedValueOnce(plan({ action: 'focus.edit', args: { op: 'add', focus: 'release', name: null, worktrees: ['main'] } }))
      .mockResolvedValueOnce(plan({ action: 'focus.edit', args: { op: 'delete', focus: 'release', name: null, worktrees: null } }));
    renderDashboard();
    await home();
    const focusSection = () => within(screen.getByRole('region', { name: 'Focus' }));

    await say('create a focus called release with master');
    await waitFor(() => expect(fakeFocuses.api.create).toHaveBeenCalledWith('default', expect.objectContaining({ name: 'release', members: ['local:/wt/master'] })));
    // Created and switched to, as the sidebar's own "New focus" does.
    await waitFor(() => expect(focusPill('release')).toBeInTheDocument());
    expect(await focusSection().findAllByText('master')).not.toHaveLength(0);
    expect(focusSection().queryAllByText('FD-9')).toHaveLength(0);

    await say('add main to release');
    await waitFor(() => expect(fakeFocuses.api.update).toHaveBeenCalledWith('default', 'f2', { addMembers: ['local:/wt/main'] }));
    expect(await focusSection().findAllByText('main')).not.toHaveLength(0);

    await say('delete release');
    // Deleting always asks first; nothing is removed until ⏎ confirms.
    expect(await screen.findByText(/wants to: Delete Focus release/)).toBeInTheDocument();
    expect(fakeFocuses.api.remove).not.toHaveBeenCalled();
    // An ⏎ within half a second of the plan landing is a bounce, not a yes.
    await act(async () => { await new Promise((r) => setTimeout(r, 550)); });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(fakeFocuses.api.remove).toHaveBeenCalledWith('default', 'f2'));
    // The active Focus is gone: none is active, as after the sidebar's Delete.
    await waitFor(() => expect(focusPill('none')).toBeInTheDocument());
    expect(fakeFocuses.state.focuses.map((f) => f.name)).toEqual(['Working on']);
  });

  it('Focus editing: rename the active Focus and remove a worktree from it; the sidebar follows', async () => {
    fakeFocuses.reset([{ id: 'f1', name: 'release', members: ['local:/wt/master', 'local:/wt/main'], createdAt: 't', lastActiveAt: 't' }]);
    askModel
      .mockResolvedValueOnce(plan({ action: 'focus.edit', args: { op: 'rename', focus: 'release', name: 'qa', worktrees: null } }))
      .mockResolvedValueOnce(plan({ action: 'focus.edit', args: { op: 'remove', focus: 'qa', name: null, worktrees: ['main'] } }));
    renderDashboard();
    await home();
    await waitFor(() => expect(focusPill('release')).toBeInTheDocument());
    const focusSection = () => within(screen.getByRole('region', { name: 'Focus' }));

    await say('rename release to qa');
    await waitFor(() => expect(fakeFocuses.api.update).toHaveBeenCalledWith('default', 'f1', { name: 'qa' }));
    await waitFor(() => expect(focusPill('qa')).toBeInTheDocument());

    await say('remove main from qa');
    await waitFor(() => expect(fakeFocuses.api.update).toHaveBeenCalledWith('default', 'f1', { removeMembers: ['local:/wt/main'] }));
    await waitFor(() => expect(focusSection().queryAllByText('main')).toHaveLength(0));
    expect(focusSection().getAllByText('master')).not.toHaveLength(0);
  });

  it('home, nothing open: "close the shell in master" closes that worktree\'s shell (off screen, from the registry): verified, then the server closes that exact tab', async () => {
    intercomPeers.list = [{ agentId: 'shell-1@app', alias: null, mode: 'shell', worktreePath: '/wt/master', sessionId: '1', executionId: 'X1', lifecycle: 'idle', live: true }];
    closeTab.mockReset().mockResolvedValue({ ok: true });
    askModel.mockResolvedValueOnce(plan({ action: 'tab.close', args: { tab: 'master/shell-1' } }));
    try {
      renderDashboard();
      await home();
      await say('close the shell in master');
      await waitFor(() => expect(closeTab).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: '/wt/master', mode: 'shell', sessionId: '1' })));
      expect(screen.queryByRole('alert')).toBeNull(); // no "that tab moved" verify failure
      expect(screen.queryByTestId('inline-hub')).toBeNull(); // nothing had to open
    } finally {
      intercomPeers.list = [];
    }
  });

  describe('the sidebar stays as the user left it', () => {
    const sidebar = () => screen.queryByRole('region', { name: 'Focus' });

    it('open in a worktree whose last session goes away (the hub closes itself): still open on home', async () => {
      localStorage.setItem('strado:sidebar-collapsed:v2', '0');
      renderDashboard();
      await openFd9FromHome();
      await waitFor(() => expect(sidebar()).not.toBeNull());
      // TerminalView calls onClose when no session remains (an empty worktree).
      fireEvent.click(screen.getByRole('button', { name: '‹ Back' }));
      await home();
      expect(sidebar()).not.toBeNull();
    });

    it('hidden stays hidden too; only the user\'s toggle (⌘B) changes it, and it is remembered', async () => {
      localStorage.setItem('strado:sidebar-collapsed:v2', '1');
      renderDashboard();
      await openFd9FromHome();
      expect(sidebar()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '‹ Back' }));
      await home();
      expect(sidebar()).toBeNull();
      fireEvent.keyDown(window, { key: 'b', metaKey: true });
      expect(await screen.findByRole('region', { name: 'Focus' })).toBeInTheDocument();
      expect(localStorage.getItem('strado:sidebar-collapsed:v2')).toBe('0');
    });
  });

  describe('home has one command area (no Dock strip)', () => {
    it('home: no Dock; opening a worktree brings the Dock and its bar back; going home hides it again', async () => {
      renderDashboard();
      await home();
      expect(screen.queryByTestId('dock')).toBeNull();
      expect(screen.getAllByLabelText('Global search')).toHaveLength(1);
      await openFd9FromHome();
      expect(within(screen.getByTestId('dock')).getByLabelText('Global search')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '‹ Back' }));
      await home();
      expect(screen.queryByTestId('dock')).toBeNull();
    });

    it('home: "⚑ 1 waiting" selects the agent that needs you (no Dock strip comes with it)', async () => {
      renderDashboard();
      await home();
      fireEvent.click(await screen.findByRole('button', { name: '⚑ 1 waiting' }));
      expect(await screen.findByTestId('agent-line')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /No worktree open/ })).toBeNull();
    });
  });

  it('home "⚑ 1 waiting" selects the agent that needs you; typing answers its call (no drawer)', async () => {
    const { api } = await import('../api');
    renderDashboard();
    await home();
    fireEvent.click(await screen.findByRole('button', { name: '⚑ 1 waiting' }));
    expect(await screen.findByTestId('agent-line-note')).toHaveTextContent('asks: Which database? — type to reply');
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(box().value).toMatch(/^@\S*claude-1 /);
    fireEvent.change(box(), { target: { value: `${box().value.trimEnd()} postgres` } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(api.intercom.escalations.resolve).toHaveBeenCalledWith('default', 'e1', 'postgres'));
    expect(screen.queryByRole('dialog', { name: /intercom/i })).not.toBeInTheDocument();
  });

  it('the Dock has no station lights: just the worktree chip and the box', async () => {
    renderDashboard();
    await openFd9FromHome();
    expect(within(screen.getByTestId('dock')).queryByRole('button', { name: /^claude-1 — / })).not.toBeInTheDocument();
  });

  describe('home vs the Worktrees list', () => {
    const hero = () => screen.queryByRole('heading', { name: 'What do you want to do?' });
    const list = () => screen.queryByRole('button', { name: 'New worktree in Repo One' }) ?? screen.queryAllByText('Repo One')[0] ?? null;
    const sidebarWorktrees = () => {
      if (!screen.queryByRole('navigation', { name: 'Pages' })) fireEvent.keyDown(window, { key: 'b', metaKey: true });
      return within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('button', { name: 'Worktrees' });
    };

    const worktreesNav = () => within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('button', { name: 'Worktrees' });
    it('the highlight and the page agree: home highlights no page; the Worktrees list highlights Worktrees', async () => {
      localStorage.setItem('strado:sidebar-collapsed:v2', '0');
      renderDashboard();
      await home();
      expect(worktreesNav()).not.toHaveAttribute('aria-current');
      fireEvent.click(worktreesNav());
      await waitFor(() => expect(hero()).toBeNull());
      expect(worktreesNav()).toHaveAttribute('aria-current', 'page');
    });

    it('a worktree whose last tab closes lands where you came from, with the highlight to match', async () => {
      localStorage.setItem('strado:sidebar-collapsed:v2', '0');
      renderDashboard();
      // From home: back on home, nothing highlighted.
      await openFd9FromHome();
      fireEvent.click(screen.getByRole('button', { name: '‹ Back' })); // TerminalView's onClose (no session left)
      await home();
      expect(worktreesNav()).not.toHaveAttribute('aria-current');
      // From the Worktrees list: back on the list, Worktrees highlighted.
      fireEvent.click(worktreesNav());
      await waitFor(() => expect(hero()).toBeNull());
      fireEvent.click(within(screen.getByRole('main')).getAllByText('FD-9')[0]!);
      await screen.findByTestId('inline-hub');
      fireEvent.click(screen.getByRole('button', { name: '‹ Back' }));
      await waitFor(() => expect(screen.queryByTestId('inline-hub')).toBeNull());
      expect(hero()).toBeNull();
      expect(worktreesNav()).toHaveAttribute('aria-current', 'page');
    });

    it('app start with nothing open: home', async () => {
      renderDashboard();
      expect(await screen.findByRole('heading', { name: 'What do you want to do?' })).toBeInTheDocument();
    });

    it('the sidebar\'s Worktrees shows the list, not home; "go home" shows home', async () => {
      askModel.mockResolvedValueOnce(plan({ action: 'nav.page', args: { page: 'home' } }));
      renderDashboard();
      await home();
      fireEvent.click(sidebarWorktrees());
      await waitFor(() => expect(hero()).toBeNull());
      expect(list()).not.toBeNull();
      await say('go home');
      await home();
    });

    it('with a hub open, the sidebar\'s Worktrees shows the list (no bounce to home)', async () => {
      renderDashboard();
      await openFd9FromHome();
      fireEvent.click(sidebarWorktrees());
      await waitFor(() => expect(screen.queryByTestId('inline-hub')).toBeNull());
      expect(hero()).toBeNull();
      expect(list()).not.toBeNull();
    });

    it('Back from a hub goes where you came from: home → home', async () => {
      renderDashboard();
      await openFd9FromHome();
      fireEvent.click(screen.getByRole('button', { name: '‹ Back' }));
      await home();
    });

    it('Back from a hub goes where you came from: the list → the list', async () => {
      renderDashboard();
      await home();
      fireEvent.click(screen.getByRole('button', { name: 'All worktrees →' }));
      await waitFor(() => expect(hero()).toBeNull());
      fireEvent.click(screen.getAllByText('FD-9')[0]!);
      await screen.findByTestId('inline-hub');
      fireEvent.click(screen.getByRole('button', { name: '‹ Back' }));
      await waitFor(() => expect(screen.queryByTestId('inline-hub')).toBeNull());
      expect(hero()).toBeNull();
      expect(list()).not.toBeNull();
    });
  });

  describe('the sidebar from the box (as ⌘B does)', () => {
    const sidebar = () => screen.queryByRole('region', { name: 'Focus' });
    const show = (v: boolean | null) => plan({ action: 'ui.sidebar', args: { show: v } });

    it('on home: "open the sidebar" shows it, "hide the sidebar" hides it', async () => {
      askModel.mockResolvedValueOnce(show(true)).mockResolvedValueOnce(show(false));
      renderDashboard();
      await home();
      expect(sidebar()).toBeNull();
      await say('open the sidebar');
      await waitFor(() => expect(sidebar()).not.toBeNull());
      await say('hide the sidebar');
      await waitFor(() => expect(sidebar()).toBeNull());
    });

    it('in a worktree (collapsed by default): "open the sidebar", "hide the sidebar", a toggle flips it; it is remembered like ⌘B', async () => {
      askModel.mockResolvedValueOnce(show(true)).mockResolvedValueOnce(show(false)).mockResolvedValueOnce(show(null));
      renderDashboard();
      await openFd9FromHome();
      expect(sidebar()).toBeNull();
      await say('open the sidebar');
      await waitFor(() => expect(sidebar()).not.toBeNull());
      expect(localStorage.getItem('strado:sidebar-collapsed:v2')).toBe('0');
      await say('hide the sidebar');
      await waitFor(() => expect(sidebar()).toBeNull());
      await say('toggle the sidebar');
      await waitFor(() => expect(sidebar()).not.toBeNull());
    });
  });

  describe('home: a request with no plan still gets an answer on screen', () => {
    it('an answer from the model shows below the big box', async () => {
      askModel.mockResolvedValueOnce({ kind: 'answer', text: 'The sidebar is the list on the left.', model: 'm', ms: 300 });
      renderDashboard();
      await home();
      await say('can you open the sidebar');
      expect(await screen.findByText('The sidebar is the list on the left.')).toBeInTheDocument();
    });

    it('a plan the box cannot run (an action it does not know) says so', async () => {
      askModel.mockResolvedValueOnce(plan({ action: 'ui.nonsense', args: {} }));
      renderDashboard();
      await home();
      await say('can you open the sidebar');
      await waitFor(() => expect(screen.getByTestId('command-bar-popover')).toBeInTheDocument());
      expect(screen.getByTestId('command-bar-popover').textContent).not.toBe('');
    });

    it('spoken (hold ⌥Space): the answer shows below the big box', async () => {
      let listener: ((e: StradoVoiceEvent) => void) | null = null;
      const voice = {
        available: true, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(),
        onEvent: (cb: (e: StradoVoiceEvent) => void) => { listener = cb; return () => { listener = null; }; },
      };
      (window as unknown as { strado?: unknown }).strado = { voice };
      try {
        askModel.mockResolvedValueOnce({ kind: 'answer', text: 'The sidebar is the list on the left.', model: 'm', ms: 300 });
        renderDashboard();
        await home();
        fireEvent.keyDown(document.body, { key: ' ', code: 'Space', altKey: true });
        act(() => { listener?.({ type: 'partial', text: 'Can you open the sidebar' }); });
        fireEvent.keyUp(window, { key: ' ', code: 'Space' });
        act(() => { listener?.({ type: 'final', text: 'Can you open the sidebar' }); });
        fireEvent.keyDown(box(), { key: 'Enter' });
        expect(await screen.findByText('The sidebar is the list on the left.')).toBeInTheDocument();
      } finally {
        delete (window as unknown as { strado?: unknown }).strado;
      }
    });

    it('a model error shows on home too', async () => {
      askModel.mockResolvedValueOnce({ kind: 'error', reason: 'timeout' });
      renderDashboard();
      await home();
      await say('can you open the sidebar');
      await waitFor(() => expect(screen.getByTestId('command-bar-popover')).toBeInTheDocument());
    });
  });
});
