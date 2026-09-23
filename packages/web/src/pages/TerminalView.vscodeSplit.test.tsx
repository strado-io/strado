import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TerminalView reads intercom state for the focused tab's escalation banner;
// these tests mount it without the provider, so stub a quiet, "loaded" context.
vi.mock('../contexts/IntercomContext', () => ({
  useIntercom: () => ({
    escalations: [], tasks: [], peers: [], loaded: true, error: null,
    refresh: vi.fn(), resolve: vi.fn(), dismiss: vi.fn(), createTask: vi.fn(),
    assignTask: vi.fn(), releaseTask: vi.fn(), doneTask: vi.fn(), cancelTask: vi.fn(),
  }),
}));

// window.strado must exist BEFORE TerminalView is imported: isElectron is a
// module-level const, and the VS Code tab only surfaces with desktop embeds.
const { hotkeyScopeMock } = vi.hoisted(() => {
  const hotkeyScope = vi.fn((_enabled: boolean) => undefined);
  (globalThis as unknown as { window: { strado?: unknown } }).window.strado = {
    hotkeyScope,
    vscodeOrigin: () => Promise.resolve(true),
  };
  return { hotkeyScopeMock: hotkeyScope };
});

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
        open: vi.fn(),
        list: vi.fn().mockResolvedValue({ forwards: [] }),
        close: vi.fn().mockResolvedValue(undefined),
      },
    },
    vscode: {
      open: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:7788/' }),
      close: vi.fn().mockResolvedValue({ ok: true }),
    },
    usage: { accounts: vi.fn().mockResolvedValue([]) },
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
  hasShellSession: true,
  shellSessions: ['1'],
  meta: { ticketId: 'FD-1', title: 'T', repoId: 'r', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
} as unknown as Worktree;

const rect = (left: number, top: number, width: number, height: number) => ({
  x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
  toJSON: () => ({}),
});

beforeEach(() => {
  localStorage.clear();
  hotkeyScopeMock.mockClear();
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (Element.prototype as any).scrollTo = vi.fn();
});
afterEach(() => { vi.clearAllMocks(); });

describe('VS Code split panes', () => {
  it('docks VS Code beside a shell: the iframe is placed over its leaf and the split survives', async () => {
    const P = worktree.path;
    localStorage.setItem('strado:vscode-tabs', JSON.stringify([P]));
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);

    const shell = screen.getByText('Shell').closest('span')!;
    const vscode = screen.getByText('VS Code').closest('span')!;
    const pane = screen.getByTestId('pane-host');
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(rect(10, 0, 60, 30));
    vi.spyOn(vscode, 'getBoundingClientRect').mockReturnValue(rect(72, 0, 80, 30));
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(rect(0, 40, 800, 600));

    // Drag the VS Code tab onto the right edge of the shell pane.
    fireEvent.pointerDown(vscode, { button: 0, pointerId: 3, clientX: 110, clientY: 15 });
    fireEvent.pointerMove(vscode, { pointerId: 3, clientX: 790, clientY: 320 });
    fireEvent.pointerUp(vscode, { pointerId: 3, clientX: 790, clientY: 320 });

    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
    expect(shell).toHaveAttribute('data-split-group', '0');
    expect(vscode).toHaveAttribute('data-split-group', '0');
    // Both leaves render as pane hosts; the pane tree is not hidden.
    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
    expect(screen.getByTestId('xterm-pane')).not.toHaveClass('hidden');

    // The iframe boots even though the shell tab is the focused pane, and it
    // is absolutely positioned over its leaf rather than filling the surface.
    const frame = await screen.findByTitle('VS Code');
    expect(frame).not.toHaveClass('hidden');
    expect(frame).not.toHaveClass('h-full');
    expect(frame.style.position).toBe('absolute');
    expect(screen.getByRole('button', { name: 'Open VS Code as full tab' })).toBeInTheDocument();
    // Cmd+Arrow interception follows the visible iframe, not the active tab.
    expect(hotkeyScopeMock).toHaveBeenLastCalledWith(true);
  });

  it('keeps VS Code visible in the split when a shell in the same group is focused after reload', async () => {
    const P = worktree.path;
    localStorage.setItem('strado:vscode-tabs', JSON.stringify([P]));
    localStorage.setItem(
      'strado.paneLayout',
      JSON.stringify({ [P]: [{ kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'leaf', key: 'shell:1' }, b: { kind: 'leaf', key: 'vscode:1' } }] }),
    );
    localStorage.setItem('strado.activeTab', JSON.stringify({ [P]: 'shell:1' }));
    render(<TerminalView worktree={worktree} onClose={() => {}} />);

    // The persisted layout still contains the VS Code leaf (not pruned away).
    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
    const frame = await screen.findByTitle('VS Code');
    expect(frame).not.toHaveClass('hidden');
    expect(JSON.parse(localStorage.getItem('strado.paneLayout') ?? '{}')[P]).toHaveLength(1);
  });

  it('switching to a tab outside the group hides the iframe but keeps it mounted', async () => {
    const P = worktree.path;
    localStorage.setItem('strado:vscode-tabs', JSON.stringify([P]));
    render(<TerminalView worktree={worktree} mode="vscode" onClose={() => {}} />);
    const frame = await screen.findByTitle('VS Code');
    expect(frame.style.position).toBe('absolute');
    expect(hotkeyScopeMock).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByText('Shell'));
    expect(screen.getByTitle(`VS Code — ${P}`)).toHaveClass('hidden');
    expect(hotkeyScopeMock).toHaveBeenLastCalledWith(false);
  });
});
