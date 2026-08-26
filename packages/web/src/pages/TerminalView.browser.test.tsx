import { act, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// window.strado must exist BEFORE TerminalView is imported: isElectron is a
// module-level const, and the Browser tab surfaces only inside Electron.
const { previewMock, devtoolsMock } = vi.hoisted(() => {
  const preview = vi.fn((...args: unknown[]) => Promise.resolve(args[0] === 'open' ? 42 : undefined));
  const devtools = vi.fn((..._args: unknown[]) => Promise.resolve(true));
  (globalThis as unknown as { window: { strado?: unknown } }).window.strado = {
    preview,
    devtools,
  };
  return { previewMock: preview, devtoolsMock: devtools };
});

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

vi.mock('../api', () => ({
  ApiClientError: class extends Error {},
  api: {
    envCheck: vi.fn().mockResolvedValue([]),
    kb: {
      files: vi.fn().mockResolvedValue({ files: [], truncated: false }),
      file: vi.fn().mockResolvedValue({ content: '', size: 0, mtimeMs: 0 }),
    },
    worktrees: {
      killSession: vi.fn().mockResolvedValue(undefined),
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
      socketTicket: vi.fn().mockResolvedValue({ ticket: 't'.repeat(48), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), wsBase: '', httpBase: '' }),
      rpc: vi.fn(),
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

const worktree = {
  path: '/Users/me/repo.worktrees/FD-1',
  repoId: 'r', branch: 'FD-1', head: 'abc', prunable: false, tracked: true,
  meta: { ticketId: 'FD-1', title: 'T', repoId: 'r', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
} as unknown as Worktree;

beforeEach(() => {
  localStorage.clear();
  previewMock.mockClear();
  devtoolsMock.mockClear();
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (Element.prototype as any).scrollTo = vi.fn();
});
afterEach(() => { vi.clearAllMocks(); });

describe('remote browser tab default URL', () => {
  it('heals a blank remote browser tab once the port forward comes up', async () => {
    const remoteWt = {
      ...worktree,
      path: '/home/strado/repos/site.worktrees/t1',
      remote: { runnerId: 'run1', runnerName: 'runner-dev', wsBase: 'wss://run1.r.strado.io', wsId: 'w1' },
      process: { status: 'running', pid: 12, startedAt: null, port: 3000, detectedUrl: null, exitCode: null },
    } as unknown as Worktree;
    const P = remoteWt.path;
    // Browser tab was opened before the forward existed: 'about:blank' stuck.
    localStorage.setItem('strado:browser-tabs', JSON.stringify([P]));
    localStorage.setItem('strado:browser-urls', JSON.stringify({ [P]: 'about:blank' }));
    render(<TerminalView worktree={remoteWt} onClose={() => {}} />);

    // Once forwards.open resolves, the tab must point at the forwarded local
    // port — state, persistence, and the live view.
    await vi.waitFor(() => {
      const nav = previewMock.mock.calls.find((c) => c[0] === 'navigate' && c[1] === P);
      expect(nav).toBeTruthy();
      expect((nav![2] as { url?: string }).url).toBe('http://127.0.0.1:51234/');
      expect(JSON.parse(localStorage.getItem('strado:browser-urls') ?? '{}')[P]).toBe('http://127.0.0.1:51234/');
    });
  });
});

describe('browser tab close → add', () => {
  it('forgets the closed tab URL so a new tab starts fresh, not on the closed page', async () => {
    const P = worktree.path;
    const PK2 = `${P}\0browser:2`;
    // Restored session: Browser 1 + Browser 2 open, Browser 2 deep in an app.
    localStorage.setItem('strado:browser-tabs', JSON.stringify([P]));
    localStorage.setItem('strado:browser-tab-ids', JSON.stringify({ [P]: ['2'] }));
    localStorage.setItem(
      'strado:browser-urls',
      JSON.stringify({ [P]: 'http://localhost:3000', [PK2]: 'http://localhost:5555/deep/page' }),
    );
    render(<TerminalView worktree={worktree} onClose={() => {}} />);

    // Close Browser 2 — its URL must be forgotten everywhere.
    fireEvent.click(screen.getByLabelText('Close Browser 2 session'));
    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem('strado:browser-urls') ?? '{}')).not.toHaveProperty(PK2);
    });

    // Add a NEW browser tab: the lowest unused id is 2 again, and the pane
    // must open on the worktree default URL — not the closed tab's page.
    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browser' }));
    await vi.waitFor(() => {
      const open = previewMock.mock.calls.find((c) => c[0] === 'open' && c[1] === PK2);
      expect(open).toBeTruthy();
      expect((open![2] as { url?: string }).url).toBe('http://localhost:3000');
    });
  });
});

describe('renderer modal visibility', () => {
  it('detaches the native preview while a parent modal is open and restores it after close', async () => {
    const P = worktree.path;
    localStorage.setItem('strado:browser-tabs', JSON.stringify([P]));
    localStorage.setItem('strado.activeTab', JSON.stringify({ [P]: 'browser:1' }));

    const view = render(<TerminalView worktree={worktree} onClose={() => {}} modalOpen={false} />);
    await vi.waitFor(() => {
      expect(previewMock.mock.calls.some((c) => c[0] === 'open' && c[1] === P)).toBe(true);
    });

    previewMock.mockClear();
    view.rerender(<TerminalView worktree={worktree} onClose={() => {}} modalOpen />);
    await vi.waitFor(() => {
      expect(previewMock.mock.calls.some((c) => c[0] === 'thumb' && c[1] === P)).toBe(true);
      expect(previewMock.mock.calls.some((c) => c[0] === 'hide' && c[1] === P)).toBe(true);
    });

    previewMock.mockClear();
    view.rerender(<TerminalView worktree={worktree} onClose={() => {}} modalOpen={false} />);
    await vi.waitFor(() => {
      expect(previewMock.mock.calls.some((c) => c[0] === 'open' && c[1] === P)).toBe(true);
    });
  });
});

describe('docked DevTools tab switching', () => {
  it('parks and restores the existing frontend instead of recreating it', async () => {
    const P = worktree.path;
    const wtWithShell = { ...worktree, hasShellSession: true, shellSessions: ['1'] } as Worktree;
    localStorage.setItem('strado:browser-tabs', JSON.stringify([P]));
    localStorage.setItem('strado.activeTab', JSON.stringify({ [P]: 'browser:1' }));
    render(<TerminalView worktree={wtWithShell} onClose={() => {}} />);

    await vi.waitFor(() => {
      expect(previewMock.mock.calls.some((c) => c[0] === 'open' && c[1] === P)).toBe(true);
    });
    // Flush BrowserPreviewPane.onReady -> previewIds before invoking the dock
    // action, which reads the current target id synchronously from a ref.
    await act(async () => {});
    fireEvent.click(screen.getByLabelText('DevTools'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dock to bottom' }));
    await vi.waitFor(() => {
      expect(devtoolsMock.mock.calls.some((c) => c[0] === 'dock' && c[1] === 42)).toBe(true);
    });

    devtoolsMock.mockClear();
    fireEvent.click(screen.getByText('Shell'));
    await vi.waitFor(() => {
      expect(devtoolsMock.mock.calls.some((c) => c[0] === 'hide' && c[1] === 42)).toBe(true);
    });
    expect(devtoolsMock.mock.calls.some((c) => c[0] === 'undock')).toBe(false);

    devtoolsMock.mockClear();
    fireEvent.click(screen.getByText('Browser'));
    await vi.waitFor(() => {
      expect(devtoolsMock.mock.calls.some((c) => c[0] === 'show' && c[1] === 42)).toBe(true);
    });
    expect(devtoolsMock.mock.calls.some((c) => c[0] === 'dock')).toBe(false);
  });
});
