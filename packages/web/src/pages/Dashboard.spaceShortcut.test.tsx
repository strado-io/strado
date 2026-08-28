import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Workspace } from '../types';

const space = (id: string): Workspace => ({
  id, name: id.toUpperCase(), color: '#334455', icon: id[0]!,
  defaultEditor: 'code', defaultPortBase: 3000, logDir: null,
});
const switchTo = vi.fn(async () => {});

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: space('a'),
    allWorkspaces: [space('a'), space('b')],
    refresh: vi.fn(),
    switchTo,
  }),
}));

vi.mock('../api', () => ({
  api: {
    repos: { list: vi.fn().mockResolvedValue([{ id: 'r1', name: 'Repo One' }]) },
    worktrees: { list: vi.fn().mockResolvedValue([]) },
    jira: { status: vi.fn().mockResolvedValue({ configured: false, baseUrl: null }) },
    tickets: {
      providers: vi.fn().mockResolvedValue([]),
      issues: vi.fn().mockResolvedValue({ issues: {}, missing: [], errors: {} }),
    },
    runners: { remoteWorktrees: vi.fn().mockResolvedValue({ runners: [], worktrees: [] }) },
    org: { get: vi.fn().mockRejectedValue(new Error('no Strado account on this machine')) },
    license: { get: vi.fn().mockResolvedValue({ license: { name: 'Test User', email: 'test@example.com' } }) },
    profile: { get: vi.fn().mockResolvedValue({ fullName: 'Test User', callMe: 'Test', telemetryOptOut: false }) },
    modelCredential: { get: vi.fn().mockResolvedValue({ present: false, last4: null }) },
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

describe('Dashboard space shortcut', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('strado:onboarding-welcomed', '1');
    localStorage.setItem('strado:onboarding-dismissed', '1');
    switchTo.mockClear();
  });

  it('switches space with the sidebar collapsed', async () => {
    // Collapsing unmounts the sidebar, and with it the chord's own listener —
    // while the shell keeps intercepting Cmd+Shift+Arrow inside embeds and
    // forwarding it, so the chord became a swallowed no-op.
    localStorage.setItem('strado:sidebar-collapsed', '1');
    renderDashboard();
    await waitFor(() => expect(screen.getByLabelText('Open sidebar')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, shiftKey: true });
    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('b'));
  });

  it('responds to the forwarded embed hotkey with the sidebar collapsed', async () => {
    localStorage.setItem('strado:sidebar-collapsed', '1');
    const handlers: ((combo: string) => void)[] = [];
    (window as unknown as { strado: unknown }).strado = {
      onHotkey: (cb: (combo: string) => void) => { handlers.push(cb); return () => {}; },
    };
    try {
      renderDashboard();
      await waitFor(() => expect(screen.getByLabelText('Open sidebar')).toBeInTheDocument());
      handlers.forEach((h) => h('space-next'));
      await waitFor(() => expect(switchTo).toHaveBeenCalledWith('b'));
    } finally {
      delete (window as unknown as { strado?: unknown }).strado;
    }
  });

  it('stays at the last space rather than wrapping', async () => {
    localStorage.setItem('strado:sidebar-collapsed', '1');
    renderDashboard();
    await waitFor(() => expect(screen.getByLabelText('Open sidebar')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true, shiftKey: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(switchTo).not.toHaveBeenCalled();
  });

  it('leaves the chord to the sidebar when the sidebar is open', async () => {
    // The sidebar animates its carousel and commits on landing; two listeners
    // acting on one chord would switch twice.
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('space-carousel')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, shiftKey: true });
    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('b'), { timeout: 2000 });
    expect(switchTo).toHaveBeenCalledTimes(1);
  });
});

describe('removed Dashboard sessions shortcut', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('strado:onboarding-welcomed', '1');
    localStorage.setItem('strado:onboarding-dismissed', '1');
  });

  it('leaves ⌘L and Ctrl+L available to the active surface', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('space-carousel')).toBeInTheDocument());
    const commandL = new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true });
    const controlL = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(commandL);
    window.dispatchEvent(controlL);
    expect(commandL.defaultPrevented).toBe(false);
    expect(controlL.defaultPrevented).toBe(false);
    expect(screen.queryByRole('button', { name: 'Toggle sessions' })).toBeNull();
    expect(screen.queryByText('No open sessions')).toBeNull();
  });
});

describe('Dashboard settings shortcut (⌘,)', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('strado:onboarding-welcomed', '1');
    localStorage.setItem('strado:onboarding-dismissed', '1');
  });

  it('opens profile settings', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('space-carousel')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    expect(await screen.findByTestId('settings-pane')).toHaveAttribute('data-section', 'profile');
  });

  it('opens profile settings with Ctrl+Comma on Linux and Windows', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('space-carousel')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(await screen.findByTestId('settings-pane')).toHaveAttribute('data-section', 'profile');
  });

  it('responds when the desktop shell forwards the shortcut from an embed', async () => {
    const handlers: ((combo: string) => void)[] = [];
    (window as unknown as { strado: unknown }).strado = {
      onHotkey: (cb: (combo: string) => void) => { handlers.push(cb); return () => {}; },
    };
    try {
      renderDashboard();
      await waitFor(() => expect(screen.getByTestId('space-carousel')).toBeInTheDocument());
      act(() => handlers.forEach((handler) => handler('settings')));
      expect(await screen.findByTestId('settings-pane')).toHaveAttribute('data-section', 'profile');
    } finally {
      delete (window as unknown as { strado?: unknown }).strado;
    }
  });
});
