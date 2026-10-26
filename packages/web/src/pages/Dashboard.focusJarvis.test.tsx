import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { Profiler } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'ws-a', name: 'A', color: 'zinc', icon: 'A', defaultPortBase: 3000, logDir: null }, allWorkspaces: [], switchTo: vi.fn() }),
}));
const intercom = vi.hoisted(() => ({
  peer: { agentId: 'claude-1@a', alias: null, mode: 'claude', worktreePath: '/a/A-1', sessionId: '1', executionId: 'E', lifecycle: 'idle', live: true } as Record<string, unknown>,
  refresh: vi.fn(async () => {}),
}));
vi.mock('../contexts/IntercomContext', () => ({
  useIntercom: () => ({ peers: [intercom.peer], loaded: true, error: null, refresh: intercom.refresh }),
}));

const focusList = vi.hoisted(() => ({ members: [] as string[] }));
const wtList = vi.hoisted(() => ({ extra: [] as unknown[] }));
const card = { id: 'e2', at: 't', type: 'action', turnId: 't1', action: 'tab.open', summary: 'Opened Claude in A-1', ok: true, card: { kind: 'claude', worktree: 'A-1', tab: 'claude-1' } };
vi.mock('../api', () => ({
  api: {
    focusJarvis: {
      log: vi.fn(async () => ({ entries: [{ id: 'e1', at: 't', type: 'user', text: 'open claude', windowId: 'w' }, card], meta: { focusId: 'f-a', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 1, running: false } })),
      send: vi.fn(), stop: vi.fn(), approve: vi.fn(), setAgent: vi.fn(), streamUrl: () => '/api/w/ws-a/focuses/f-a/jarvis/events',
    },
    focuses: {
      list: async () => [{ id: 'f-a', name: 'Billing', members: focusList.members, createdAt: 't', lastActiveAt: 't' }],
      create: vi.fn(), update: vi.fn(async () => ({})), remove: vi.fn(),
    },
    repos: { list: vi.fn().mockResolvedValue([{ id: 'ra', name: 'Repo A' }]) },
    worktrees: { list: vi.fn(async () => [{ path: '/a/A-1', repoId: 'ra', branch: 'a-1', meta: { ticketId: 'A-1' }, process: { status: 'idle' }, tracked: true }, ...wtList.extra]) },
    jira: { status: vi.fn().mockResolvedValue({ configured: false, baseUrl: null }) },
    tickets: { providers: vi.fn().mockResolvedValue([]), issues: vi.fn().mockResolvedValue({ issues: {}, missing: [], errors: {} }) },
    reviews: { list: vi.fn().mockResolvedValue({ reviews: [], repositories: [], counts: { open: 0, merged: 0, closed: 0 }, page: 1, pageSize: 20, hasMore: false, pageLimit: null }) },
    org: { get: vi.fn().mockRejectedValue(new Error('no account')) },
    runners: { remoteWorktrees: vi.fn().mockImplementation(() => new Promise(() => {})) },
  },
}));
const hubProps = vi.hoisted(() => ({ last: null as null | { path: string; mode?: string; sessionId?: string } }));
vi.mock('./TerminalView', () => ({
  TerminalView: (p: { worktree: { path: string }; mode?: string; sessionId?: string }) => {
    hubProps.last = { path: p.worktree.path, mode: p.mode, sessionId: p.sessionId };
    return <div data-testid="inline-hub" />;
  },
}));

import { Dashboard } from './Dashboard';

// The chat's stream, driven by the test (other EventSources stay inert).
type Listener = (e: MessageEvent) => void;
const streams = vi.hoisted(() => ({ jarvis: null as null | { emit: (name: string, data: unknown) => void } }));
class FakeSource {
  listeners = new Map<string, Listener>();
  constructor(public url: string) { if (url.includes('/jarvis/')) streams.jarvis = this; }
  addEventListener(name: string, fn: Listener) { this.listeners.set(name, fn); }
  removeEventListener() {}
  close() {}
  emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent); }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeSource;
import { __resetFocuses } from '../hooks/useFocuses';
import { showSidebarOnHome } from './dashboardTestHome';

const noop = vi.fn();
/** The Focus was left on this worktree (stored per Focus, across launches). */
const leftOn = (path: string) => localStorage.setItem('strado:selected-by-focus', JSON.stringify({ 'f-a': path }));
function renderDashboard() {
  render(
    <Dashboard onNewWorktree={noop} onShowLogs={noop} onMenu={noop} onOpenNote={noop} onOpenDiff={noop} onCloseOverlays={noop} onDeleteWorktree={noop}
      update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }} />,
  );
  showSidebarOnHome();
}

describe('Dashboard: Focus Jarvis', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('strado:focus-expanded', JSON.stringify(['f-a'])); // these tests read the cards: expanded
    localStorage.setItem('strado:sidebar-collapsed:v2', '0');
    localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ 'ws-a': 'f-a' }));
    __resetFocuses();
    hubProps.last = null;
    intercom.peer = { ...intercom.peer, lifecycle: 'idle' };
    delete intercom.peer.attention;
    intercom.refresh.mockClear();
  });

  it('app open with a Focus active and no saved view: its Jarvis chat, never the global home', async () => {
    focusList.members = ['local:/a/A-1'];
    renderDashboard();
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Jarvis' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What do you want to do?' })).toBeNull();
    expect(screen.getByTestId('focus-header')).toHaveAttribute('data-selected', 'true');
    expect(hubProps.last).toBeNull();
  });

  it('in the chat, ⌘⇧F / Ctrl+Shift+F does nothing: no worktree opens and the composer keeps its text', async () => {
    focusList.members = ['local:/a/A-1'];
    renderDashboard();
    await act(async () => {});
    const box = screen.getByRole('textbox', { name: /message jarvis/i });
    fireEvent.change(box, { target: { value: 'find' } });
    const e = new KeyboardEvent('keydown', { key: 'F', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
    box.dispatchEvent(e);
    fireEvent.keyDown(box, { key: 'F', ctrlKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(hubProps.last).toBeNull();
    expect(screen.getByRole('region', { name: 'Jarvis' })).toBeInTheDocument();
    expect(box).toHaveValue('find');
  });

  it('a fresh load with storage from older builds settles: no update loop', async () => {
    focusList.members = [];
    // Expanded sets naming Focuses that are gone, made for another Focus; chat and seen flags.
    sessionStorage.setItem('strado:focus-expanded', JSON.stringify(['gone', 'f-a', 'other']));
    sessionStorage.setItem('strado:focus-expanded-for', 'gone');
    sessionStorage.setItem('strado:jarvis-by-focus', JSON.stringify(['f-a', 'gone']));
    localStorage.setItem('strado:selected-by-focus', JSON.stringify({ 'f-a': '/gone', gone: '/a/A-1' }));
    let commits = 0;
    render(
      <Profiler id="dash" onRender={() => { commits += 1; }}>
        <Dashboard onNewWorktree={noop} onShowLogs={noop} onMenu={noop} onOpenNote={noop} onOpenDiff={noop} onCloseOverlays={noop} onDeleteWorktree={noop}
          update={{ phase: 'idle', info: null, progress: 0, error: null, mode: 'swap' as const, onUpdate: noop, onInstall: noop, onDismiss: noop }} />
      </Profiler>,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByRole('region', { name: 'Jarvis' })).toBeInTheDocument();
    const settled = commits;
    expect(settled).toBeLessThan(40);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(commits).toBe(settled);
    expect(JSON.parse(sessionStorage.getItem('strado:focus-expanded')!)).toEqual(['f-a']);
  });

  it('app open restores the worktree the Focus had open', async () => {
    focusList.members = ['local:/a/A-1'];
    leftOn('/a/A-1');
    renderDashboard();
    await act(async () => {});
    expect(hubProps.last).toEqual(expect.objectContaining({ path: '/a/A-1' }));
    expect(screen.queryByRole('region', { name: 'Jarvis' })).toBeNull();
    expect(screen.getByTestId('focus-header')).not.toHaveAttribute('data-selected');
  });

  it('app open restores the chat when this window left the Focus on it, over a saved worktree', async () => {
    focusList.members = ['local:/a/A-1'];
    leftOn('/a/A-1');
    sessionStorage.setItem('strado:jarvis-by-focus', JSON.stringify(['f-a']));
    renderDashboard();
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Jarvis' })).toBeInTheDocument();
    expect(hubProps.last).toBeNull();
  });

  it('no Focus active: the global home, no Jarvis', async () => {
    focusList.members = ['local:/a/A-1'];
    localStorage.removeItem('strado:active-focus-by-ws');
    renderDashboard();
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'What do you want to do?' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Jarvis' })).toBeNull();
  });

  it('the empty chat lists this Focus\'s recent worktrees; one opens on click', async () => {
    const { api } = await import('../api');
    focusList.members = ['local:/a/A-1'];
    vi.mocked(api.focusJarvis.log).mockResolvedValueOnce({ entries: [], meta: { focusId: 'f-a', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 0, running: false } } as never);
    localStorage.setItem('strado:worktree-lru', JSON.stringify({ '/a/A-1': Date.now() - 120_000 }));
    renderDashboard();
    await act(async () => {});
    const recent = within(screen.getByRole('region', { name: 'Jarvis' })).getByRole('list', { name: 'Recent in this Focus' });
    expect(recent).toHaveTextContent('A-1· Repo A2m');
    fireEvent.click(within(recent).getByRole('button', { name: /A-1/ }));
    expect(hubProps.last).toEqual(expect.objectContaining({ path: '/a/A-1' }));
    expect(screen.queryByRole('region', { name: 'Jarvis' })).toBeNull();
  });

  it('a blank Focus\'s empty chat offers Add worktrees (the picker) and New worktree here', async () => {
    const { api } = await import('../api');
    focusList.members = [];
    vi.mocked(api.focusJarvis.log).mockResolvedValueOnce({ entries: [], meta: { focusId: 'f-a', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 0, running: false } } as never);
    noop.mockClear();
    renderDashboard();
    await act(async () => {});
    const chat = within(screen.getByRole('region', { name: 'Jarvis' }));
    expect(chat.queryByRole('list', { name: 'Recent in this Focus' })).toBeNull();
    fireEvent.click(chat.getByRole('button', { name: 'New worktree here' }));
    expect(noop).toHaveBeenCalledWith(undefined, undefined);
    fireEvent.click(chat.getByRole('button', { name: 'Add worktrees' }));
    expect(screen.getByRole('dialog', { name: /add worktrees/i })).toBeInTheDocument();
  });

  it('a blank Focus opens on its Jarvis', async () => {
    focusList.members = [];
    renderDashboard();
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Jarvis' })).toBeInTheDocument();
    // The Focus's header is its Jarvis; it reads as selected while the chat shows. A blank Focus says "Ask Jarvis…".
    expect(screen.getByTestId('focus-header')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('focus-latest')).toHaveTextContent('Ask Jarvis…');
    expect(screen.queryByTestId('jarvis-card')).toBeNull();
  });

  it('the header shows needs approval and opens the chat; Open on a tab card selects its worktree and tab', async () => {
    focusList.members = ['local:/a/A-1'];
    leftOn('/a/A-1');
    renderDashboard();
    await act(async () => {});
    const jarvisCard = screen.getByTestId('focus-header');
    expect(within(jarvisCard).getByRole('img', { name: 'needs approval' })).toBeInTheDocument();
    expect(jarvisCard).not.toHaveAttribute('data-selected');
    expect(screen.queryByRole('region', { name: 'Jarvis' })).toBeNull();
    fireEvent.click(jarvisCard);
    expect(screen.getByTestId('focus-header')).toHaveAttribute('data-selected', 'true');
    const chat = screen.getByRole('region', { name: 'Jarvis' });
    expect(within(chat).getByTestId('jarvis-user')).toHaveTextContent('open claude');
    fireEvent.click(within(chat).getByRole('button', { name: /^Open / }));
    expect(screen.queryByRole('region', { name: 'Jarvis' })).toBeNull();
    expect(hubProps.last).toEqual({ path: '/a/A-1', mode: 'claude', sessionId: '1' });
  });

  it('a worktree Jarvis creates shows in the Focus at once (focuses and worktrees refetch)', async () => {
    focusList.members = ['local:/a/A-1'];
    wtList.extra = [];
    renderDashboard();
    await act(async () => {});
    const section = screen.getByRole('region', { name: 'Focus' });
    expect(within(section).queryByText('B-2')).toBeNull();
    // The server made the worktree and added it to the Focus; nothing pushed that.
    focusList.members = ['local:/a/A-1', 'local:/a/B-2'];
    wtList.extra = [{ path: '/a/B-2', repoId: 'ra', branch: 'b-2', meta: { ticketId: 'B-2' }, process: { status: 'idle' }, tracked: true }];
    await act(async () => {
      streams.jarvis!.emit('entry', { id: 'e9', at: 't', type: 'action', turnId: 't2', action: 'worktree.create', summary: 'Created B-2', ok: true });
    });
    await act(async () => {});
    expect(within(screen.getByRole('region', { name: 'Focus' })).getByText('B-2')).toBeInTheDocument();
  });

  it('while a card\'s tab is starting, peers are polled; a folder-trust question reads "needs you"', async () => {
    focusList.members = ['local:/a/A-1'];
    intercom.peer = { ...intercom.peer, lifecycle: 'starting' };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      renderDashboard();
      await act(async () => {});
      fireEvent.click(screen.getByTestId('focus-header'));
      expect(screen.getByTestId('tab-card')).toHaveTextContent('A-1 · starting');
      await act(async () => { vi.advanceTimersByTime(2_000); });
      expect(intercom.refresh).toHaveBeenCalled();
      // W5: about two minutes per card, then it stops (the clock jumps; one tick sees it).
      vi.setSystemTime(Date.now() + 121_000);
      await act(async () => { vi.advanceTimersByTime(2_000); });
      const after = intercom.refresh.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(intercom.refresh.mock.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('W2/W4: a failed send or approval shows fixed words, never the server\'s; a refused approval reloads the chat', async () => {
    const { api } = await import('../api');
    focusList.members = ['local:/a/A-1'];
    renderDashboard();
    await act(async () => {});
    fireEvent.click(screen.getByTestId('focus-header'));
    vi.mocked(api.focusJarvis.send).mockRejectedValueOnce(new Error('ENOENT /Users/secret/.strado/jarvis'));
    const box = screen.getByRole('textbox', { name: /message jarvis/i });
    fireEvent.change(box, { target: { value: 'hello' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't send that. Your message is still in the box.");
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(box).toHaveValue('hello');
  });

  it('W4: an approval refused by the server (409) reloads the chat and says so in fixed words', async () => {
    const { api } = await import('../api');
    focusList.members = ['local:/a/A-1'];
    const pending = { id: 'ap1', at: 't', type: 'approval', turnId: 't1', action: 'server.stop', args: {}, summary: 'Stop dev in A-1', state: 'pending' };
    const metaNow = { focusId: 'f-a', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 1, running: false };
    vi.mocked(api.focusJarvis.log).mockResolvedValueOnce({ entries: [pending], meta: metaNow } as never);
    renderDashboard();
    await act(async () => {});
    fireEvent.click(screen.getByTestId('focus-header'));
    const calls = vi.mocked(api.focusJarvis.log).mock.calls.length;
    vi.mocked(api.focusJarvis.approve).mockRejectedValueOnce(Object.assign(new Error('approval ap1 is not pending (superseded by x)'), { code: 'CONFLICT' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't record your answer. The card shows where it stands now.");
    expect(screen.queryByText(/superseded by/)).toBeNull();
    expect(vi.mocked(api.focusJarvis.log).mock.calls.length).toBeGreaterThan(calls);
  });

  it('W5: with the chat closed, a starting card is not polled for', async () => {
    focusList.members = ['local:/a/A-1'];
    leftOn('/a/A-1');
    intercom.peer = { ...intercom.peer, lifecycle: 'starting' };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      renderDashboard();
      await act(async () => {});
      expect(screen.queryByRole('region', { name: 'Jarvis' })).toBeNull();
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(intercom.refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the chat on screen marks its replies seen (the sidebar\'s unread ✦)', async () => {
    const { api } = await import('../api');
    focusList.members = ['local:/a/A-1'];
    const metaNow = { focusId: 'f-a', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 0, running: false };
    vi.mocked(api.focusJarvis.log).mockResolvedValueOnce({ entries: [{ id: 'r7', at: 't', type: 'jarvis', turnId: 't1', text: 'Done.', done: true }], meta: metaNow } as never);
    leftOn('/a/A-1');
    renderDashboard();
    await act(async () => {});
    expect(JSON.parse(sessionStorage.getItem('strado:jarvis-seen') ?? '{}')['f-a']).toBeUndefined();
    fireEvent.click(screen.getByTestId('focus-header'));
    expect(JSON.parse(sessionStorage.getItem('strado:jarvis-seen') ?? '{}')['f-a']).toBe('r7');
  });
});
