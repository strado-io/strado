import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock xterm so jsdom (no canvas) can run ---
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    parser = { registerCsiHandler: vi.fn() };
    write = vi.fn();
    onData() {
      return { dispose: vi.fn() };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class { dispose = vi.fn(); } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'default' } }),
}));

vi.mock('../eventStream', () => ({
  subscribeWorktrees: () => () => {},
  subscribeLogs: () => () => {},
}));

const killSession = vi.fn().mockResolvedValue(undefined);
const killRemoteSession = vi.fn().mockResolvedValue({ ok: true });
const runnerRpc = vi.fn();
vi.mock('../api', () => ({
  ApiClientError: class extends Error {},
  api: {
    envCheck: vi.fn().mockResolvedValue([]),
    kb: {
      files: vi.fn().mockResolvedValue({ files: [], truncated: false }),
      file: vi.fn().mockResolvedValue({ content: '', size: 0, mtimeMs: 0 }),
    },
    worktrees: {
      killSession: (...a: unknown[]) => killSession(...a),
      sessionBusy: vi.fn().mockResolvedValue({ busy: false }),
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue(undefined),
      setEnvProfile: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      logs: vi.fn().mockResolvedValue({ lines: [] }),
      upload: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      mergeRequests: vi.fn().mockResolvedValue({ kind: 'absent' }),
      git: {
        changes: vi.fn().mockResolvedValue({ files: [] }),
        branches: vi.fn().mockResolvedValue({ branches: [] }),
        branchChanges: vi.fn().mockResolvedValue({ base: '', baseBranch: 'main', files: [] }),
        diff: vi.fn().mockResolvedValue({ diff: '' }),
        remotes: vi.fn().mockResolvedValue({ remotes: [] }),
      },
    },
    repos: { list: vi.fn().mockResolvedValue([]) },
    runners: {
      list: vi.fn().mockResolvedValue({ runners: [] }),
      socketTicket: vi.fn().mockResolvedValue({ ticket: 't'.repeat(48), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), wsBase: 'wss://run1.r.strado.io', httpBase: 'https://run1.r.strado.io' }),
      rpc: (...a: unknown[]) => runnerRpc(...a),
      killRemoteSession: (...a: unknown[]) => killRemoteSession(...a),
      forwards: {
        open: vi.fn().mockResolvedValue({ runnerId: 'run1', remotePort: 3000, localPort: 51234, url: 'http://127.0.0.1:51234', startedAt: new Date(0).toISOString() }),
        list: vi.fn().mockResolvedValue({ forwards: [] }),
        close: vi.fn().mockResolvedValue(undefined),
      },
    },
    vscode: {
      open: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:7788/' }),
      close: vi.fn().mockResolvedValue({ ok: true }),
    },
  },
}));

class FakeWS {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close = vi.fn();
}

import { TerminalView } from './TerminalView';
import type { Worktree } from '../types';

const remoteWt = {
  path: '/home/strado/repos/site.worktrees/t1',
  remote: { runnerId: 'run1', runnerName: 'runner-dev', wsBase: 'wss://run1.r.strado.io', wsId: 'rw' },
  repoId: 'site', branch: 't1', head: 'abc', prunable: false, tracked: true,
  meta: null,
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  hasShellSession: true,
  shellSessions: ['1', '2'],
} as unknown as Worktree;

// The runner row the poll returns — a snapshot that STILL lists shell 2
// (taken before the kill landed, or the kill hasn't happened at all).
const staleRow = {
  ...remoteWt,
  claudeStatusById: {}, codexStatusById: {}, opencodeStatusById: {},
  claudeSessions: [], codexSessions: [], opencodeSessions: [],
};

beforeEach(() => {
  localStorage.clear();
  killSession.mockClear();
  killRemoteSession.mockClear();
  runnerRpc.mockReset();
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (Element.prototype as any).scrollTo = vi.fn();
});
afterEach(() => { vi.clearAllMocks(); });

describe('remote hub tab highlight', () => {
  it('highlights the active tab on mount (identity includes the runner on both sides)', async () => {
    runnerRpc.mockImplementation(async (_runnerId: string, path: string) =>
      path.includes('/repos') ? { repos: [] } : { worktrees: [staleRow] });
    render(<TerminalView worktree={remoteWt} onClose={() => {}} />);
    // The initial active tab is Shell 1. Its strip entry must carry the
    // active style — sameTab() compares runner identity, so a runner-stamped
    // `active` against a runner-less strip tab highlights nothing.
    const wrapper = screen.getByLabelText('Close Shell session').closest('span.group');
    expect(wrapper?.className).toContain('bg-zinc-800');
  });
});

describe('closing a shell on a remote worktree', () => {
  it('kills the session on the RUNNER and a stale poll snapshot cannot resurrect the tab', async () => {
    // The poll resolves only when we release it, so the test controls whether
    // the stale snapshot lands before or after the close.
    let releasePoll!: () => void;
    const gate = new Promise<void>((r) => { releasePoll = r; });
    runnerRpc.mockImplementation(async (_runnerId: string, path: string) => {
      if (path.includes('/repos')) return { repos: [] };
      await gate;
      return { worktrees: [staleRow] };
    });

    render(<TerminalView worktree={remoteWt} onClose={() => {}} />);
    // Both shells restored from the worktree row.
    expect(screen.getByLabelText('Close Shell 2 session')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close Shell 2 session'));

    // The kill must target the runner via the kill-session proxy — not the
    // local server, which has never heard of this path.
    await vi.waitFor(() => {
      expect(killRemoteSession).toHaveBeenCalledWith('default', {
        runnerId: 'run1', remoteWsId: 'rw', path: remoteWt.path, mode: 'shell', id: '2',
      });
    });
    expect(killSession).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Close Shell 2 session')).not.toBeInTheDocument();

    // Now the stale snapshot lands, still listing shell 2 — the tab must NOT
    // come back (this is exactly the reopen-after-close bug).
    releasePoll();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText('Close Shell 2 session')).not.toBeInTheDocument();
  });
});
