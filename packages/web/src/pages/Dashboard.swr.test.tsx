import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: { id: 'default', name: 'Default', color: 'zinc', icon: 'DF', defaultEditor: 'vscode', defaultPortBase: 3000, logDir: null },
    allWorkspaces: [],
    switchTo: vi.fn(),
  }),
}));
vi.mock('../api', () => ({
  api: {
    repos: { list: vi.fn().mockImplementation(() => new Promise(() => {})) },
    worktrees: { list: vi.fn().mockImplementation(() => new Promise(() => {})) },
    jira: { status: vi.fn().mockResolvedValue({ configured: false, baseUrl: null }) },
    tickets: {
      providers: vi.fn().mockResolvedValue([]),
      issues: vi.fn().mockResolvedValue({ issues: {}, missing: [], errors: {} }),
    },
    org: { get: vi.fn().mockRejectedValue(new Error('no Strado account on this machine')) },
    runners: { remoteWorktrees: vi.fn().mockImplementation(() => new Promise(() => {})) },
  },
}));
vi.mock('./TerminalView', () => ({
  TerminalView: ({ worktree, onClose }: any) => (
    <div data-testid="inline-hub">hub:{worktree.path}<button onClick={onClose}>‹ Back</button></div>
  ),
}));

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

describe('Dashboard SWR seed', () => {
  beforeEach(() => localStorage.clear());

  it('paints the cached tree from localStorage before any fetch resolves', () => {
    localStorage.setItem('strado:tree-by-ws', JSON.stringify({
      default: {
        repos: [{ id: 'r1', name: 'Cached Repo' }],
        worktrees: [{
          path: '/wt/FD-1', repoId: 'r1', branch: 'fd-1', meta: { ticketId: 'FD-1' },
          process: { status: 'idle' }, tracked: true,
        }],
      },
    }));
    renderDashboard();
    // Synchronously present — the mocked fetches never resolve, so this row can
    // only have come from the localStorage seed painting before revalidation.
    // Twice over: the sidebar repo row and the task board's repo chip.
    expect(screen.getAllByText('Cached Repo').length).toBeGreaterThan(0);
  });
});
