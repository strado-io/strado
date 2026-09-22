import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const metrics = vi.hoisted(() => vi.fn());
const kill = vi.hoisted(() => vi.fn());
const worktreesList = vi.hoisted(() => vi.fn());
const reposList = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({
  api: {
    sessions: { metrics, kill },
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
  },
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
    ]),
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
    // worktree totals = sum of its sessions
    expect(within(wt).getByText('1.2%')).toBeInTheDocument();
    expect(within(wt).getByText('247.0 MB')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.queryByTestId('sessions-group-other')).not.toBeInTheDocument());
  });

  it('collapses a repo group', async () => {
    renderSection();
    const repo = await screen.findByTestId('sessions-group-fleetx-react-app');
    fireEvent.click(within(repo).getByRole('button', { name: /collapse fleetx-react-app/i }));
    expect(screen.queryByTestId(`sessions-worktree-${WT}`)).not.toBeInTheDocument();
  });

  it('says so when the daemon holds no sessions', async () => {
    metrics.mockResolvedValue({ ...sample(), sessions: [] });
    renderSection();
    expect(await screen.findByText(/no terminal sessions/i)).toBeInTheDocument();
  });
});
