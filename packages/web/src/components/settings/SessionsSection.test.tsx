import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const metrics = vi.hoisted(() => vi.fn());
const kill = vi.hoisted(() => vi.fn());
const worktreesList = vi.hoisted(() => vi.fn());
const reposList = vi.hoisted(() => vi.fn());
const stopVscode = vi.hoisted(() => vi.fn());
const vscodeClose = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({
  api: {
    sessions: { metrics, kill, stopVscode },
    vscode: { close: vscodeClose },
    worktrees: { list: worktreesList },
    repos: { list: reposList },
  },
}));

import { SessionsSection } from './SessionsSection';
import { WorkspaceContext } from '../../contexts/WorkspaceContext';
import type { Workspace } from '../../types';

const MB = 1024 * 1024;
const workspace: Workspace = {
  id: 'default', name: 'Default', color: '#333333', icon: 'D',
  defaultEditor: 'code', defaultPortBase: 8080, logDir: null,
};

const WT = '/Users/me/.strado/worktrees/fleetx-react-app/master';
const ORPHAN = '/Users/me/Desktop/strado/strado-oms-service';

const sample = () => ({
  sampledAt: 1000,
  app: {
    server: { pid: 10, cpu: 2.7, rssBytes: 119.7 * MB },
    daemon: { pid: 11, cpu: 0.4, rssBytes: 35 * MB },
    vscode: { pid: 12, cpu: 3.0, rssBytes: 410 * MB, processes: 5 },
  },
  vscodeWindows: [
    { path: WT, pid: 700, cpu: 2.0, rssBytes: 600 * MB, processes: 4 },
  ],
  sessions: [
    { key: WT, path: WT, mode: 'claude', id: '1', pid: 500, cpu: 1.0, rssBytes: 235 * MB, processes: 3 },
    { key: `${WT}\0shell`, path: WT, mode: 'shell', id: '1', pid: 501, cpu: 0.2, rssBytes: 12 * MB, processes: 1 },
    { key: `${ORPHAN}\0shell`, path: ORPHAN, mode: 'shell', id: '1', pid: 600, cpu: 0, rssBytes: 8 * MB, processes: 1 },
  ],
});

function renderSection() {
  return render(
    <WorkspaceContext.Provider value={{ workspace, setWorkspace: () => {} } as never}>
      <SessionsSection />
    </WorkspaceContext.Provider>,
  );
}

beforeEach(() => {
  metrics.mockReset().mockResolvedValue(sample());
  kill.mockReset().mockResolvedValue(undefined);
  stopVscode.mockReset().mockResolvedValue(undefined);
  vscodeClose.mockReset().mockResolvedValue({ ok: true });
  localStorage.clear();
  worktreesList.mockReset().mockResolvedValue([
    { path: WT, repoId: 'fleetx-react-app', branch: 'master', meta: { ticketId: null, title: null } },
  ]);
  reposList.mockReset().mockResolvedValue([{ id: 'fleetx-react-app', name: 'fleetx-react-app', path: '/repo' }]);
  (window as unknown as { strado?: unknown }).strado = {
    appMetrics: vi.fn().mockResolvedValue([
      { pid: 1, type: 'Browser', cpu: 1.2, memoryKb: 283.7 * 1024 },
      { pid: 2, type: 'Tab', cpu: 1.3, memoryKb: 375.5 * 1024 },
      { pid: 3, type: 'GPU', cpu: 0.5, memoryKb: 60 * 1024 },
      { pid: 4, type: 'Utility', cpu: 0.1, memoryKb: 20 * 1024 },
      // Browser preview WebContentsViews: renderer processes tagged with their preview key.
      { pid: 5, type: 'Tab', cpu: 0.7, memoryKb: 150 * 1024, preview: WT },
      { pid: 6, type: 'Tab', cpu: 0.2, memoryKb: 90 * 1024, preview: `${ORPHAN}\0browser:2` },
    ]),
    preview: vi.fn().mockResolvedValue(true),
  };
});

describe('SessionsSection', () => {
  it('groups daemon sessions by repo → worktree → session with CPU and memory', async () => {
    renderSection();
    // Repo group, worktree row, session row.
    const repo = await screen.findByTestId('sessions-group-fleetx-react-app');
    expect(within(repo).getByText('fleetx-react-app')).toBeInTheDocument();
    const wt = screen.getByTestId(`sessions-worktree-${WT}`);
    expect(within(wt).getByText('master')).toBeInTheDocument();
    // worktree totals = its pty sessions (1.0 + 0.2, 235 + 12) plus its Browser preview (0.7, 150)
    // pty (1.0 + 0.2, 235 + 12) + Browser preview (0.7, 150) + VS Code window (2.0, 600)
    expect(within(wt).getByText('3.9%')).toBeInTheDocument();
    expect(within(wt).getByText('997.0 MB')).toBeInTheDocument();
    const claude = screen.getByTestId(`sessions-row-${WT}`);
    expect(within(claude).getByText('Claude')).toBeInTheDocument();
    expect(within(claude).getByText('1.0%')).toBeInTheDocument();
    expect(within(claude).getByText('235.0 MB')).toBeInTheDocument();
    expect(within(claude).getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows the Strado app processes on top: Main, Renderer, GPU, Other, Server, Daemon', async () => {
    renderSection();
    const app = await screen.findByTestId('sessions-group-strado');
    for (const label of ['Main', 'Renderer', 'GPU', 'Other', 'Server', 'Daemon']) {
      expect(within(app).getByText(label)).toBeInTheDocument();
    }
    expect(within(app).getByText('283.7 MB')).toBeInTheDocument(); // Main
    expect(within(app).getByText('119.7 MB')).toBeInTheDocument(); // Server
  });

  it('puts sessions whose path is not a worktree of this workspace under Other', async () => {
    renderSection();
    const other = await screen.findByTestId('sessions-group-other');
    expect(within(other).getByText('strado-oms-service')).toBeInTheDocument();
    expect(within(other).getByTitle(ORPHAN)).toBeInTheDocument();
    expect(within(other).getByText('Shell')).toBeInTheDocument();
  });

  it('Kill ends the session by key and refreshes', async () => {
    renderSection();
    const row = await screen.findByTestId(`sessions-row-${ORPHAN}\0shell`);
    metrics.mockResolvedValue({ ...sample(), sessions: sample().sessions.slice(0, 2) });
    fireEvent.click(within(row).getByRole('button', { name: /kill/i }));
    await waitFor(() => expect(kill).toHaveBeenCalledWith(`${ORPHAN}\0shell`));
    await waitFor(() => expect(screen.queryByTestId(`sessions-row-${ORPHAN}\0shell`)).not.toBeInTheDocument());
  });

  it('collapses a repo group', async () => {
    renderSection();
    const repo = await screen.findByTestId('sessions-group-fleetx-react-app');
    fireEvent.click(within(repo).getByRole('button', { name: /collapse fleetx-react-app/i }));
    expect(screen.queryByTestId(`sessions-worktree-${WT}`)).not.toBeInTheDocument();
  });

  it('says so when the daemon holds no sessions', async () => {
    metrics.mockResolvedValue({ ...sample(), sessions: [], vscodeWindows: [] });
    (window as unknown as { strado: { appMetrics: ReturnType<typeof vi.fn> } }).strado.appMetrics.mockResolvedValue([]);
    renderSection();
    expect(await screen.findByText(/no terminal sessions/i)).toBeInTheDocument();
  });

  it('shows the shared VS Code workbench under Strado, with a Stop action', async () => {
    renderSection();
    const app = await screen.findByTestId('sessions-group-strado');
    const row = within(app).getByTestId('sessions-row-vscode');
    // what is left of the serve-web tree after the per-window rows below
    expect(within(row).getByText('VS Code (shared)')).toBeInTheDocument();
    expect(within(row).getByText('410.0 MB')).toBeInTheDocument();
    localStorage.setItem('strado:vscode-tabs', JSON.stringify([WT, ORPHAN]));
    fireEvent.click(within(row).getByRole('button', { name: /stop vs code/i }));
    await waitFor(() => expect(stopVscode).toHaveBeenCalled());
    // Every VS Code tab pointed at the stopped workbench: close them all.
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:vscode-tabs') ?? '[]')).toEqual([]));
  });

  it('lists Browser previews under their worktree and keeps them out of the Renderer row', async () => {
    renderSection();
    const wt = await screen.findByTestId(`sessions-worktree-${WT}`);
    const browser = screen.getByTestId(`sessions-row-browser:${WT}`);
    expect(within(browser).getByText('Browser')).toBeInTheDocument();
    expect(within(browser).getByText('150.0 MB')).toBeInTheDocument();
    // worktree total includes the preview and the VS Code window
    expect(within(wt).getByText('997.0 MB')).toBeInTheDocument();
    // Renderer row is the dashboard only.
    const app = screen.getByTestId('sessions-group-strado');
    expect(within(app).getByText('375.5 MB')).toBeInTheDocument();
    // An orphan preview lands under Other, numbered like its tab.
    const other = screen.getByTestId('sessions-group-other');
    expect(within(other).getByText('Browser 2')).toBeInTheDocument();
  });

  it('closing a Browser preview tears down the view and forgets the tab', async () => {
    localStorage.setItem('strado:browser-tabs', JSON.stringify([WT]));
    renderSection();
    const browser = await screen.findByTestId(`sessions-row-browser:${WT}`);
    fireEvent.click(within(browser).getByRole('button', { name: /close browser/i }));
    const strado = (window as unknown as { strado: { preview: ReturnType<typeof vi.fn> } }).strado;
    await waitFor(() => expect(strado.preview).toHaveBeenCalledWith('close', WT));
    expect(JSON.parse(localStorage.getItem('strado:browser-tabs') ?? '[]')).toEqual([]);
  });

  it('shows each VS Code window under its worktree, and Close forgets that VS Code tab', async () => {
    localStorage.setItem('strado:vscode-tabs', JSON.stringify([WT, ORPHAN]));
    renderSection();
    const row = await screen.findByTestId(`sessions-row-vscode:${WT}`);
    expect(within(row).getByText('VS Code')).toBeInTheDocument();
    expect(within(row).getByText('600.0 MB')).toBeInTheDocument();
    expect(within(row).getByText('2.0%')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /close vs code in master/i }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('strado:vscode-tabs') ?? '[]')).toEqual([ORPHAN]));
    // and the server ends that window's extension host (the hub may not be mounted)
    expect(vscodeClose).toHaveBeenCalledWith(WT);
  });
});
