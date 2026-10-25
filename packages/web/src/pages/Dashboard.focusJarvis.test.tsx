import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'ws-a', name: 'A', color: 'zinc', icon: 'A', defaultPortBase: 3000, logDir: null }, allWorkspaces: [], switchTo: vi.fn() }),
}));
vi.mock('../contexts/IntercomContext', () => ({
  useIntercom: () => ({
    peers: [{ agentId: 'claude-1@a', alias: null, mode: 'claude', worktreePath: '/a/A-1', sessionId: '1', executionId: 'E', lifecycle: 'idle', live: true }],
    loaded: true, error: null, refresh: vi.fn(),
  }),
}));

const focusList = vi.hoisted(() => ({ members: [] as string[] }));
const card = { id: 'e2', at: 't', type: 'action', turnId: 't1', action: 'tab.open', summary: 'Opened Claude in A-1', ok: true, card: { kind: 'claude', worktree: 'A-1', tab: 'claude-1' } };
vi.mock('../api', () => ({
  api: {
    focusJarvis: {
      log: vi.fn(async () => ({ entries: [{ id: 'e1', at: 't', type: 'user', text: 'open claude', windowId: 'w' }, card], meta: { focusId: 'f-a', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 1, running: false } })),
      send: vi.fn(), stop: vi.fn(), approve: vi.fn(), setAgent: vi.fn(), streamUrl: () => '/jarvis/events',
    },
    focuses: {
      list: async () => [{ id: 'f-a', name: 'Billing', members: focusList.members, createdAt: 't', lastActiveAt: 't' }],
      create: vi.fn(), update: vi.fn(async () => ({})), remove: vi.fn(),
    },
    repos: { list: vi.fn().mockResolvedValue([{ id: 'ra', name: 'Repo A' }]) },
    worktrees: { list: vi.fn().mockResolvedValue([{ path: '/a/A-1', repoId: 'ra', branch: 'a-1', meta: { ticketId: 'A-1' }, process: { status: 'idle' }, tracked: true }]) },
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
import { __resetFocuses } from '../hooks/useFocuses';
import { showSidebarOnHome } from './dashboardTestHome';

const noop = vi.fn();
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
    localStorage.setItem('strado:sidebar-collapsed:v2', '0');
    localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ 'ws-a': 'f-a' }));
    __resetFocuses();
    hubProps.last = null;
  });

  it('a blank Focus opens on its Jarvis', async () => {
    focusList.members = [];
    renderDashboard();
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Jarvis' })).toBeInTheDocument();
    expect(screen.getByTestId('jarvis-card')).toHaveAttribute('data-active', 'true');
  });

  it('the card shows needs approval and opens the chat; Open on a tab card selects its worktree and tab', async () => {
    focusList.members = ['local:/a/A-1'];
    renderDashboard();
    await act(async () => {});
    const section = screen.getByRole('region', { name: 'Focus' });
    const jarvisCard = within(section).getByTestId('jarvis-card');
    expect(jarvisCard).toHaveTextContent('needs approval');
    expect(screen.queryByRole('region', { name: 'Jarvis' })).toBeNull();
    fireEvent.click(jarvisCard);
    const chat = screen.getByRole('region', { name: 'Jarvis' });
    expect(within(chat).getByTestId('jarvis-user')).toHaveTextContent('open claude');
    fireEvent.click(within(chat).getByRole('button', { name: /^Open / }));
    expect(screen.queryByRole('region', { name: 'Jarvis' })).toBeNull();
    expect(hubProps.last).toEqual({ path: '/a/A-1', mode: 'claude', sessionId: '1' });
  });
});
