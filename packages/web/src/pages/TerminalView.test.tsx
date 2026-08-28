import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock xterm so jsdom (no canvas) can run ---
const onDataHandlers: Array<(d: string) => void> = [];
const termWrite = vi.fn();
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    // XtermPane registers CSI handlers (2026 sync-output swallow + DECRQM answer)
    parser = { registerCsiHandler: vi.fn() };
    write = termWrite;
    onData(cb: (d: string) => void) {
      onDataHandlers.push(cb);
      return { dispose: vi.fn() };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit = vi.fn(); },
}));
vi.mock('@xterm/addon-unicode-graphemes', () => ({
  UnicodeGraphemesAddon: class { dispose = vi.fn(); },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// --- Mock the workspace hook ---
vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'default' } }),
}));

// --- Stub the SSE-based worktree subscription (EventSource isn't available in jsdom) ---
// Capture the handler so tests can push synthetic SSE events into the component.
type SseHandler = (evt: { type: 'worktree.updated'; data: Record<string, unknown> & { path: string } }) => void;
let sseHandler: SseHandler | null = null;
vi.mock('../eventStream', () => ({
  subscribeWorktrees: (handler: SseHandler) => {
    sseHandler = handler;
    return () => { sseHandler = null; };
  },
  subscribeLogs: () => () => {},
}));

// --- Mock the api module (the component calls killSession/upload/lists) ---
const killSession = vi.fn().mockResolvedValue(undefined);
const sessionBusy = vi.fn().mockResolvedValue({ busy: false });
const reposList = vi.fn().mockResolvedValue([]);
const worktreesList = vi.fn().mockResolvedValue([]);
const gitChanges = vi.fn().mockResolvedValue({ files: [] });
const mergeRequests = vi.fn().mockResolvedValue({ kind: 'absent' });
const vscodeOpen = vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:7788/' });
const vscodeClose = vi.fn().mockResolvedValue({ ok: true });
const procStart = vi.fn().mockResolvedValue({});
const procStop = vi.fn().mockResolvedValue(undefined);
const setEnvProfile = vi.fn().mockResolvedValue({});
const procLogs = vi.fn().mockResolvedValue({ lines: ['boot line'] });
const wtPatch = vi.fn().mockResolvedValue({});
const envCheck = vi.fn().mockResolvedValue([]);
const kbFiles = vi.fn().mockResolvedValue({ files: [], truncated: false });
const kbFile = vi.fn().mockResolvedValue({ content: '', size: 0, mtimeMs: 0 });
const runnersList = vi.fn().mockResolvedValue({ runners: [] });
const socketTicket = vi.fn().mockResolvedValue({
  ticket: 't'.repeat(48),
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  wsBase: 'wss://runner-dev-wq3p.r.strado.io',
  httpBase: 'https://runner-dev-wq3p.r.strado.io',
});
const runnerRpc = vi.fn();
vi.mock('../api', () => ({
  ApiClientError: class extends Error {},
  api: {
    envCheck: (...a: unknown[]) => envCheck(...a),
    kb: {
      files: (...a: unknown[]) => kbFiles(...a),
      file: (...a: unknown[]) => kbFile(...a),
    },
    worktrees: {
      killSession: (...a: unknown[]) => killSession(...a),
      sessionBusy: (...a: unknown[]) => sessionBusy(...a),
      start: (...a: unknown[]) => procStart(...a),
      stop: (...a: unknown[]) => procStop(...a),
      setEnvProfile: (...a: unknown[]) => setEnvProfile(...a),
      patch: (...a: unknown[]) => wtPatch(...a),
      logs: (...a: unknown[]) => procLogs(...a),
      upload: vi.fn(),
      list: (...a: unknown[]) => worktreesList(...a),
      mergeRequests: (...a: unknown[]) => mergeRequests(...a),
      git: {
        changes: (...a: unknown[]) => gitChanges(...a),
        branches: vi.fn().mockResolvedValue({ branches: [] }),
        branchChanges: vi.fn().mockResolvedValue({ base: '', baseBranch: 'main', files: [] }),
        diff: vi.fn().mockResolvedValue({ diff: '' }),
        remotes: vi.fn().mockResolvedValue({ remotes: [] }),
      },
    },
    repos: { list: (...a: unknown[]) => reposList(...a) },
    runners: {
      list: (...a: unknown[]) => runnersList(...a),
      socketTicket: (...a: unknown[]) => socketTicket(...a),
      rpc: (...a: unknown[]) => runnerRpc(...a),
    },
    vscode: {
      open: (...a: unknown[]) => vscodeOpen(...a),
      close: (...a: unknown[]) => vscodeClose(...a),
    },
  },
}));

// --- Capture WebSocket instances ---
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  url: string;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) { this.url = url; FakeWS.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close = vi.fn();
}

import { TerminalView } from './TerminalView';
import { renderClaudeLight } from '../components/XtermPane';
import type { Worktree } from '../types';

const worktree = {
  path: '/Users/me/repo.worktrees/FD-1',
  repoId: 'r', branch: 'FD-1', head: 'abc', prunable: false, tracked: true,
  meta: { ticketId: 'FD-1', title: 'T', repoId: 'r', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
} as unknown as Worktree;
const baseWorktree = worktree;

describe('Claude light terminal rendering', () => {
  it('translates reverse-video message bars to a light neutral highlight', () => {
    expect(renderClaudeLight('\x1b[1;7mhey\x1b[27m')).toBe(
      '\x1b[1;48;2;228;228;231;38;2;39;39;42mhey\x1b[49;39m',
    );
  });
});

function lastWsUrl(): string {
  return FakeWS.instances[FakeWS.instances.length - 1]!.url;
}

function pushSse(data: Record<string, unknown> & { path: string }) {
  act(() => { sseHandler?.({ type: 'worktree.updated', data }); });
}

beforeEach(() => {
  localStorage.clear(); // isolate persisted tab state (closed-agents, vscode/browser tabs)
  FakeWS.instances = [];
  onDataHandlers.length = 0;
  termWrite.mockClear();
  killSession.mockClear();
  reposList.mockReset().mockResolvedValue([]);
  worktreesList.mockReset().mockResolvedValue([]);
  gitChanges.mockReset().mockResolvedValue({ files: [] });
  mergeRequests.mockReset().mockResolvedValue({ kind: 'absent' });
  vscodeOpen.mockReset().mockResolvedValue({ url: 'http://127.0.0.1:7788/' });
  vscodeClose.mockReset().mockResolvedValue({ ok: true });
  procStart.mockReset().mockResolvedValue({});
  procStop.mockReset().mockResolvedValue(undefined);
  setEnvProfile.mockReset().mockResolvedValue({});
  procLogs.mockReset().mockResolvedValue({ lines: ['boot line'] });
  wtPatch.mockReset().mockResolvedValue({});
  envCheck.mockReset().mockResolvedValue([]);
  kbFiles.mockReset().mockResolvedValue({ files: [], truncated: false });
  kbFile.mockReset().mockResolvedValue({ content: '', size: 0, mtimeMs: 0 });
  sseHandler = null;
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (Element.prototype as any).scrollTo = vi.fn(); // jsdom lacks scrollTo (LogPanel autoscroll)
});
afterEach(() => { vi.clearAllMocks(); });

describe('TerminalView', () => {
  it('offers Browser in the new-session menu only inside Electron', () => {
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('New session'));
    // jsdom UA has no "Electron" — the webview-backed option must be absent
    expect(screen.getByRole('menuitem', { name: 'Claude' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Browser' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('hides VS Code when the server has no Electron embeds (a runner)', async () => {
    // The M3 contract: a self-hosted runner reports embeds:false, and the tab
    // must be ABSENT rather than present-but-broken.
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).includes('/api/capabilities')
        ? ({ ok: true, json: async () => ({ embeds: false, notifications: false, runner: true }) } as Response)
        : ({ ok: false, json: async () => ({}) } as Response));
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('New session'));
    await vi.waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: 'VS Code' })).not.toBeInTheDocument());
    // Terminals still work on a runner — only the Electron surfaces go.
    expect(screen.getByRole('menuitem', { name: 'Shell' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    vi.unstubAllGlobals();
  });

  it('offers VS Code on a normal local server', async () => {
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('New session'));
    expect(await screen.findByRole('menuitem', { name: 'VS Code' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  // A session on a runner rendered in THIS window, beside the local tabs, with
  // its bytes going straight to the relay. These tabs are no longer created
  // from the "+" menu (a runner's worktrees appear in the sidebar, so a shell
  // opened there is already remote) — they come back from storage.
  describe('remote shells', () => {
    const stored = {
      runnerId: 'runner-dev-wq3p',
      wsBase: 'wss://runner-dev-wq3p.r.strado.io',
      wsId: 'remote-ws',
      path: '/home/strado/repos/Hello-World',
      id: '1',
    };

    function seedRemoteShell() {
      localStorage.setItem('strado.remoteShells', JSON.stringify({ [worktree.path]: [stored] }));
    }

    async function attachRemoteShell() {
      seedRemoteShell();
      const view = render(<TerminalView worktree={worktree} onClose={() => {}} />);
      // Like any inactive tab it holds no socket until clicked.
      await act(async () => {
        fireEvent.click(await screen.findByText('runner-dev'));
      });
      return view;
    }

    it('connects straight to the relay, with the RUNNER’s workspace and path', async () => {
      await attachRemoteShell();
      const url = await vi.waitFor(() => {
        const u = lastWsUrl();
        expect(u).toContain('runner-dev-wq3p');
        return u;
      });
      // Not localhost: routing terminal bytes through the local server is the
      // thing this design exists to avoid.
      expect(url.startsWith('wss://runner-dev-wq3p.r.strado.io/ws/terminal?')).toBe(true);
      expect(url).toContain(`ws=${encodeURIComponent('remote-ws')}`);
      expect(url).toContain(`path=${encodeURIComponent('/home/strado/repos/Hello-World')}`);
      expect(url).toContain(`ticket=${'t'.repeat(48)}`);
    });

    it('keeps a remote shell and a local shell as separate panes', async () => {
      await attachRemoteShell();
      await vi.waitFor(() => expect(lastWsUrl()).toContain('runner-dev-wq3p'));
      // Both are "shell 1"; only the runner distinguishes them, so a shared
      // pane key would silently merge two sessions on two machines.
      fireEvent.click(screen.getByLabelText('New session'));
      await act(async () => {
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Shell' }));
      });
      expect(lastWsUrl()).toContain('ws=default');
      expect(lastWsUrl()).not.toContain('runner-dev-wq3p');
      expect(FakeWS.instances.filter((w) => w.url.includes('runner-dev-wq3p')).length).toBe(1);
    });

    it('never offers a per-runner shell row in the new-session menu', async () => {
      runnersList.mockResolvedValue({
        runners: [{ runnerId: 'runner-dev-wq3p', name: 'runner-dev', online: true }],
      });
      render(<TerminalView worktree={worktree} onClose={() => {}} />);
      fireEvent.click(screen.getByLabelText('New session'));
      // The row guessed a repo on the runner (first worktree it found), which
      // is never what the user meant. Its replacement is the sidebar.
      expect(await screen.findByRole('menuitem', { name: 'Shell' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /Shell on/ })).not.toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
    });
  });

  it('shows OpenCode enabled when installed', async () => {
    envCheck.mockResolvedValue([{ id: 'opencode', found: true, hint: null }]);
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('New session'));
    const item = await screen.findByRole('menuitem', { name: 'OpenCode' });
    await vi.waitFor(() => expect(item).not.toBeDisabled());
    fireEvent.click(item);
    expect(lastWsUrl()).toContain('mode=opencode');
  });

  it('shows OpenCode disabled with a hint when not installed', async () => {
    envCheck.mockResolvedValue([{ id: 'opencode', found: false, hint: 'OpenCode needs to be installed to use' }]);
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('New session'));
    const item = await screen.findByRole('menuitem', { name: 'OpenCode' });
    await vi.waitFor(() => expect(item).toBeDisabled());
    expect(item).toHaveAttribute('title', 'OpenCode needs to be installed to use');
  });


  it('opens a Knowledge Base tab from the new-session menu, and it is the actual visible panel', async () => {
    // Fake timers must be installed BEFORE mount: the KB panel arms its
    // 10s poll interval (window.setInterval) inside a mount-time effect —
    // installing fake timers later would leave that interval running on the
    // real clock, and advanceTimersByTimeAsync below would never touch it.
    vi.useFakeTimers();
    try {
      render(<TerminalView worktree={worktree} onClose={() => {}} />);
      fireEvent.click(screen.getByLabelText('New session'));

      // No `await findBy*` here: with fake timers installed, testing-library's
      // waitFor polling never fires on its own (nothing advances it), so an
      // async query that isn't already satisfied synchronously would hang.
      // Every element below is produced synchronously by the preceding
      // fireEvent (no promise in the path — Knowledge Base is ungated, unlike
      // OpenCode), so plain sync queries are correct here, not a workaround.
      fireEvent.click(screen.getByRole('menuitem', { name: 'Knowledge Base' }));
      // Flush the kb.files/envCheck microtasks under act() (a plain await
      // Promise.resolve() would do the same but act() also silences the
      // "not wrapped in act" warning for the resulting state update).
      await act(async () => {});

      // The tab strip renders labels as plain text (no role="tab" in this app —
      // see the existing 'Shell 2' assertions at TerminalView.test.tsx:262), and
      // clicking the item closes the menu, so this text can only be the tab.
      expect(screen.getByText('Knowledge Base')).toBeInTheDocument();
      // KB is not a pty mode: no terminal WebSocket may be opened for it.
      expect(FakeWS.instances.every((ws) => !ws.url.includes('mode=kb'))).toBe(true);

      // The tab label alone doesn't prove the panel mounted — assert the panel
      // itself is there (its filter input renders unconditionally) and is the
      // visible pane, with the xterm pane hidden underneath it.
      expect(screen.getByPlaceholderText('Filter files…')).toBeInTheDocument();
      expect(screen.getByTestId('xterm-pane')).toHaveClass('hidden');
      expect(screen.getByTestId(`kb-pane-${worktree.path}`)).not.toHaveClass('hidden');
      expect(kbFiles).toHaveBeenCalledTimes(1); // active fetched its listing

      // Switching away must flip visibility both ways — the KB pane hides and
      // the xterm pane reappears — instead of the panel silently staying the
      // active pane behind the terminal. (Default entry tab is a shell.)
      fireEvent.click(screen.getByText('Shell'));
      expect(screen.getByTestId('xterm-pane')).not.toHaveClass('hidden');
      expect(screen.getByTestId(`kb-pane-${worktree.path}`)).toHaveClass('hidden');

      // The discriminator that a hardcoded active={true} can't fake: a
      // hidden panel must stop polling. 30s (3x POLL_MS) of fake time must
      // not produce another api.kb.files call once the tab isn't visible.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(kbFiles).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('connects to the terminal WS with workspace id and worktree path', () => {
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    const ws = FakeWS.instances[0]!;
    expect(ws.url).toContain('/ws/terminal');
    expect(ws.url).toContain('ws=default');
    expect(ws.url).toContain(encodeURIComponent(worktree.path));
  });

  it('writes inbound messages to the terminal', () => {
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    const ws = FakeWS.instances[0]!;
    act(() => { ws.onmessage?.({ data: 'output-line' }); });
    expect(termWrite).toHaveBeenCalledWith('output-line');
  });

  it('forwards terminal input as a data frame', () => {
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    const ws = FakeWS.instances[0]!;
    act(() => { ws.onopen?.(); });
    act(() => { onDataHandlers[0]!('x'); });
    expect(ws.sent.some((m) => m.includes('"type":"data"') && m.includes('"x"'))).toBe(true);
  });


  it('renders no cross-worktree super-tab picker (single-worktree hub)', () => {
    render(<TerminalView worktree={worktree} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Open another worktree')).not.toBeInTheDocument();
  });

  it('toggles the Changes rail', async () => {
    render(<TerminalView worktree={worktree} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Diff & commit' })).not.toBeInTheDocument();
    const changes = screen.getByRole('button', { name: 'Changes' });
    expect(changes).toHaveTextContent('+0 -0');
    expect(changes).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(changes);
    expect(changes).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText(/no changes|couldn.t load changes|loading/i)).toBeInTheDocument();
  });

  it('⌘L toggles the Changes rail', () => {
    render(<TerminalView worktree={worktree} onClose={vi.fn()} />);
    const changes = screen.getByRole('button', { name: 'Changes' });
    expect(changes).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    expect(changes).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    expect(changes).toHaveAttribute('aria-pressed', 'false');
  });

  it('leaves Ctrl+L to the shell (clear screen) and ignores auto-repeat', () => {
    render(<TerminalView worktree={worktree} onClose={vi.fn()} />);
    const changes = screen.getByRole('button', { name: 'Changes' });
    const ctrlL = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ctrlL);
    expect(ctrlL.defaultPrevented).toBe(false);
    expect(changes).toHaveAttribute('aria-pressed', 'false');
    // a held ⌘L must not flap the rail open/closed
    fireEvent.keyDown(window, { key: 'l', metaKey: true, repeat: true });
    expect(changes).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles the Changes rail from the embed hotkey bridge', () => {
    // Inside the Browser preview / VS Code iframe the chord never reaches the
    // window listener — main.cjs forwards it as the 'changes' combo instead.
    const handlers: ((combo: string) => void)[] = [];
    (window as any).strado = { onHotkey: (cb: (combo: string) => void) => { handlers.push(cb); return () => {}; } };
    try {
      render(<TerminalView worktree={worktree} onClose={vi.fn()} />);
      const changes = screen.getByRole('button', { name: 'Changes' });
      expect(handlers.length).toBeGreaterThan(0);
      act(() => { handlers.forEach((cb) => cb('changes')); });
      expect(changes).toHaveAttribute('aria-pressed', 'true');
    } finally {
      delete (window as any).strado;
    }
  });

  it('does not render the removed Sessions rail toggle', () => {
    render(<TerminalView worktree={worktree} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Toggle sessions' })).toBeNull();
  });

  it('auto-reconnects on an unexpected close (server drop), with backoff', () => {
    vi.useFakeTimers();
    try {
      render(<TerminalView worktree={worktree} onClose={() => {}} />);
      expect(FakeWS.instances).toHaveLength(1);
      const ws = FakeWS.instances[0]!;
      // socket drops without the pty having exited → should retry
      act(() => { ws.onclose?.(); });
      expect(termWrite).toHaveBeenCalledWith(expect.stringContaining('reconnecting'));
      expect(FakeWS.instances).toHaveLength(1); // not yet — waits for backoff
      act(() => { vi.advanceTimersByTime(1000); });
      expect(FakeWS.instances).toHaveLength(2); // reconnected
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT reconnect after the process exits (deliberate end)', () => {
    vi.useFakeTimers();
    try {
      render(<TerminalView worktree={worktree} onClose={() => {}} />);
      const ws = FakeWS.instances[0]!;
      // server announces the pty exit, then closes
      act(() => { ws.onmessage?.({ data: '\r\n[process exited 0]\r\n' }); });
      act(() => { ws.onclose?.(); });
      expect(termWrite).toHaveBeenCalledWith(expect.stringContaining('disconnected'));
      act(() => { vi.advanceTimersByTime(30000); });
      expect(FakeWS.instances).toHaveLength(1); // no reconnect
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders one tab per shell session plus claude', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1', '2'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(screen.getByText('Shell 2')).toBeInTheDocument();
  });

  it('gives a Shell tab hosting a hand-launched agent that agent\'s status, and no other tab', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1', '2'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    // Claude launched by hand inside Shell 2: the worktree aggregate goes
    // 'working', but the dedicated Claude tab is not the one that is busy
    pushSse({
      path: baseWorktree.path,
      claudeStatus: 'working',
      claudeStatusById: { 'shell:2': 'working' },
    });
    const shellTab = screen.getByTitle(/^Claude working/);
    expect(shellTab).toHaveTextContent('Shell 2');
    expect(shellTab.querySelector('svg')).toHaveClass('animate-pulse');
    // the dedicated Claude tab is idle — it must not borrow the aggregate
    const claudeTab = screen.getByText('Claude').closest('button')!;
    expect(claudeTab).toHaveAttribute('title', 'Double-click to rename');
    expect(claudeTab.querySelector('svg')).not.toHaveClass('animate-pulse');
  });

  it('keeps the hosted-agent icon on a Shell tab until the agent exits', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );
    pushSse({ path: baseWorktree.path, codexStatus: 'waiting', codexStatusById: { 'shell:1': 'waiting' } });
    expect(screen.getByTitle(/^Codex waiting/)).toHaveTextContent('Shell');
    // idle between turns is not an exit — the agent still owns the tab
    pushSse({ path: baseWorktree.path, codexStatus: 'idle', codexStatusById: { 'shell:1': 'idle' } });
    expect(screen.getByTitle(/^Codex idle/)).toHaveTextContent('Shell');
    // the server drops the session when the launcher reports the exit
    pushSse({ path: baseWorktree.path, codexStatus: 'idle', codexStatusById: {} });
    expect(screen.queryByTitle(/^Codex/)).not.toBeInTheDocument();
  });

  it('with no explicit mode, restores the worktree\'s last-active tab', () => {
    localStorage.setItem('strado.activeTab', JSON.stringify({ [baseWorktree.path]: 'shell:2' }));
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1', '2'] } as Worktree}
        onClose={vi.fn()}
      />,
    );
    expect(lastWsUrl()).toContain('mode=shell');
    expect(lastWsUrl()).toContain('session=2');
  });

  it('a saved agent tab that was user-closed falls back to a shell instead of respawning the agent', () => {
    // Regression: restored claude:1 + closed-agents suppression left an empty
    // tab strip, the recovery effect closed the hub (blank board), and the
    // orphan pane had already spawned a fresh claude.
    localStorage.setItem('strado.activeTab', JSON.stringify({ [baseWorktree.path]: 'claude:1' }));
    localStorage.setItem('strado:closed-agents', JSON.stringify({ claude: [baseWorktree.path], codex: [], opencode: [] }));
    const onClose = vi.fn();
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: false } as Worktree}
        onClose={onClose}
      />,
    );
    expect(lastWsUrl()).toContain('mode=shell');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Shell')).toBeInTheDocument();
  });

  it('with nothing saved, a generic open lands on a shell', () => {
    render(<TerminalView worktree={baseWorktree} onClose={vi.fn()} />);
    expect(lastWsUrl()).toContain('mode=shell');
  });

  it('an explicit mode overrides the saved tab', () => {
    localStorage.setItem('strado.activeTab', JSON.stringify({ [baseWorktree.path]: 'shell:2' }));
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1', '2'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    expect(lastWsUrl()).toContain('mode=claude');
  });

  it('remembers the active tab as the user switches, for the next mount', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1', '2'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Shell 2'));
    expect(JSON.parse(localStorage.getItem('strado.activeTab') ?? '{}')[baseWorktree.path]).toBe('shell:2');
  });

  it('renders one Claude tab per live claude session', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, claudeSessions: ['1', '2'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Claude 2')).toBeInTheDocument();
  });

  it('new-session menu Claude opens the next claude session when one is already open', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, claudeSessions: ['1'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }));
    expect(screen.getByText('Claude 2')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=claude');
    expect(lastWsUrl()).toContain('session=2');
  });

  it('tab ✕ on a second Claude session kills that session id', async () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, claudeSessions: ['1', '2'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close Claude 2 session'));
    await vi.waitFor(() =>
      expect(killSession).toHaveBeenCalledWith(expect.anything(), baseWorktree.path, 'claude', '2'),
    );
    expect(screen.queryByText('Claude 2')).not.toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument(); // session 1 untouched
  });

  it('an SSE claudeSessions update adds and removes Claude tabs', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, claudeSessions: ['1'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Claude 2')).not.toBeInTheDocument();
    pushSse({ path: baseWorktree.path, hasClaudeSession: true, claudeSessions: ['1', '2'] });
    expect(screen.getByText('Claude 2')).toBeInTheDocument();
    pushSse({ path: baseWorktree.path, hasClaudeSession: true, claudeSessions: ['1'] });
    expect(screen.queryByText('Claude 2')).not.toBeInTheDocument();
  });

  it('renders one tab per codex and opencode session', () => {
    render(
      <TerminalView
        worktree={{
          ...baseWorktree,
          hasCodexSession: true, codexSessions: ['1', '2'],
          hasOpencodeSession: true, opencodeSessions: ['1', '2'],
        } as Worktree}
        mode="codex"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Codex 2')).toBeInTheDocument();
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.getByText('OpenCode 2')).toBeInTheDocument();
  });

  it('new-session menu Codex opens the next codex session when one is already open', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasCodexSession: true, codexSessions: ['1'] } as Worktree}
        mode="codex"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(screen.getByText('Codex 2')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=codex');
    expect(lastWsUrl()).toContain('session=2');
  });

  it('tab ✕ on a second Codex session kills that session id', async () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasCodexSession: true, codexSessions: ['1', '2'] } as Worktree}
        mode="codex"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close Codex 2 session'));
    await vi.waitFor(() =>
      expect(killSession).toHaveBeenCalledWith(expect.anything(), baseWorktree.path, 'codex', '2'),
    );
    expect(screen.queryByText('Codex 2')).not.toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
  });

  it('agent tabs rename on double-click, and the name persists', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, claudeSessions: ['1', '2'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    fireEvent.doubleClick(screen.getByText('Claude 2'));
    const input = screen.getByLabelText('Rename tab') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'reviewer' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('reviewer')).toBeInTheDocument();
    expect(screen.queryByText('Claude 2')).not.toBeInTheDocument();
    expect(localStorage.getItem('strado:shell-names')).toContain('reviewer');
  });

  it('Cmd+D splits the focused pane side-by-side with a new session of the same mode', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, claudeSessions: ['1'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('pane-leaf')).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    expect(screen.getAllByTestId('pane-leaf')).toHaveLength(2);
    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
    // the new pane is a second claude session with its own pty connection
    expect(lastWsUrl()).toContain('mode=claude');
    expect(lastWsUrl()).toContain('session=2');
    expect(screen.getByText('Claude 2')).toBeInTheDocument();
    // layout persisted so the split survives reload
    expect(localStorage.getItem('strado.paneLayout')).toContain('claude:2');
  });

  it('Cmd+Shift+D splits the focused pane top/bottom', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'd', metaKey: true, shiftKey: true });
    expect(screen.getAllByTestId('pane-leaf')).toHaveLength(2);
    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'col');
    expect(lastWsUrl()).toContain('mode=shell');
    expect(lastWsUrl()).toContain('session=2');
  });

  it('closing a split pane collapses back to a single pane', async () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    expect(screen.getAllByTestId('pane-leaf')).toHaveLength(2);
    // Cmd+W closes the focused (new) pane's session
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    await vi.waitFor(() =>
      expect(killSession).toHaveBeenCalledWith(expect.anything(), baseWorktree.path, 'shell', '2'),
    );
    expect(screen.getAllByTestId('pane-leaf')).toHaveLength(1);
    expect(screen.queryByTestId('pane-split')).not.toBeInTheDocument();
  });

  it('connects with the session id when opened on a shell tab', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['2'] } as Worktree}
        mode="shell"
        sessionId="2"
        onClose={vi.fn()}
      />,
    );
    expect(lastWsUrl()).toContain('mode=shell');
    expect(lastWsUrl()).toContain('session=2');
  });

  it('+ opens the lowest unused shell id', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1', '3'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shell' }));
    expect(screen.getByText('Shell 2')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('session=2');
  });

  it('tab ✕ kills that session (after the not-busy check)', async () => {
    sessionBusy.mockResolvedValueOnce({ busy: false });
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1', '2'] } as Worktree}
        mode="shell"
        sessionId="2"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close Shell 2 session'));
    await vi.waitFor(() =>
      expect(killSession).toHaveBeenCalledWith(expect.anything(), baseWorktree.path, 'shell', '2'),
    );
  });

  it('warns before closing a busy shell and does not kill when cancelled', async () => {
    sessionBusy.mockResolvedValueOnce({ busy: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1', '2'] } as Worktree}
        mode="shell"
        sessionId="2"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close Shell 2 session'));
    await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(killSession).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('closing the sole tab via its ✕ calls onClose exactly once', () => {
    const onClose = vi.fn();
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true } as Worktree}
        mode="claude"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close Claude session'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not re-open a Claude tab the user closed, even with a live session and mode=claude', () => {
    // A prior close persisted this worktree as a closed Claude tab. On remount
    // (e.g. reload, where mode defaults back to 'claude') the tab must stay
    // closed despite a live server session, until the user opens it again.
    localStorage.setItem('strado:closed-agents', JSON.stringify({ claude: [baseWorktree.path] }));
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1'] } as Worktree}
        mode="claude"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    expect(screen.getByText('Shell')).toBeInTheDocument();
  });

  it('applies a later explicit open request on an already-mounted hub — mount respects a closed tab, a bumped openSeq opens it', () => {
    // A notification targets a session whose worktree hub is ALREADY open.
    // mode/sessionId are read once at mount, so the switch rides on openSeq.
    localStorage.setItem('strado:closed-agents', JSON.stringify({ claude: [baseWorktree.path] }));
    const wt = { ...baseWorktree, hasClaudeSession: true, shellSessions: ['1'] } as Worktree;
    const view = render(<TerminalView worktree={wt} mode="claude" sessionId="1" openSeq={0} onClose={() => {}} />);
    // Mount still respects the user-closed suppression (guarded off the mount run).
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    // A later explicit request bumps openSeq → the closed tab opens.
    view.rerender(<TerminalView worktree={wt} mode="claude" sessionId="1" openSeq={1} onClose={() => {}} />);
    expect(screen.getByText('Claude')).toBeInTheDocument();
  });

  it('keeps a freshly-opened Claude tab when a pre-spawn hasClaudeSession:false SSE lands', () => {
    // New worktree: no server-side Claude session yet, opened straight into
    // Claude. A snapshot SSE taken before the pty registered must NOT close
    // the only tab (which would close the hub) — the tab is unconfirmed.
    const onClose = vi.fn();
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: false } as Worktree}
        mode="claude"
        onClose={onClose}
      />,
    );
    expect(screen.getByText('Claude')).toBeInTheDocument();

    pushSse({ path: baseWorktree.path, hasClaudeSession: false });

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Once the server confirms the session, a later false is a genuine close.
    pushSse({ path: baseWorktree.path, hasClaudeSession: true });
    pushSse({ path: baseWorktree.path, hasClaudeSession: false });
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });

  it('SSE hasClaudeSession:false removes the Claude tab and switches away from it', () => {
    const onClose = vi.fn();
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1'] } as Worktree}
        mode="claude"
        onClose={onClose}
      />,
    );
    expect(screen.getByText('Claude')).toBeInTheDocument();

    pushSse({ path: baseWorktree.path, hasClaudeSession: false });

    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=shell');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('SSE shellSessions shrink removes a server-confirmed shell tab and closes when none remain', () => {
    const onClose = vi.fn();
    // Opened directly on a shell session the server hasn't reported yet
    // (freshly spawned pty) — starts out purely local.
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: [] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={onClose}
      />,
    );
    expect(screen.getByText('Shell')).toBeInTheDocument();

    // Server confirms the session: it now owns id '1' (dropped from local).
    pushSse({ path: baseWorktree.path, shellSessions: ['1'] });
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Server later reports the session gone -> tab must actually disappear,
    // and with no tabs left the panel closes.
    pushSse({ path: baseWorktree.path, shellSessions: [] });
    expect(onClose).toHaveBeenCalled();
  });

  it('stale worktree list arriving after SSE confirmation does not close a fresh shell', async () => {
    const onClose = vi.fn();
    // Slow GET /worktrees: snapshot is taken before the pty spawns, but the
    // response lands after the server has already confirmed the session.
    let resolveList!: (rows: unknown[]) => void;
    worktreesList.mockReturnValue(new Promise((r) => { resolveList = r; }));
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: [] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={onClose}
      />,
    );
    expect(screen.getByText('Shell')).toBeInTheDocument();

    // pty spawned -> server confirms id '1' (moves it out of the local set).
    pushSse({ path: baseWorktree.path, shellSessions: ['1'] });

    // Stale list response says no shell sessions -> must not wipe the tab.
    await act(async () => { resolveList([{ ...baseWorktree, shellSessions: [] }]); });
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('SSE shellSessions shrink switches the active tab away from a removed confirmed shell', () => {
    const onClose = vi.fn();
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1'] } as Worktree}
        mode="claude"
        onClose={onClose}
      />,
    );
    // Open a second shell tab locally and switch to it.
    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shell' }));
    expect(screen.getByText('Shell 2')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('session=2');

    // Server confirms both sessions.
    pushSse({ path: baseWorktree.path, shellSessions: ['1', '2'] });
    expect(screen.getByText('Shell 2')).toBeInTheDocument();

    // Server later reports shell 2 gone -> active tab must switch away.
    pushSse({ path: baseWorktree.path, shellSessions: ['1'] });
    expect(screen.queryByText('Shell 2')).not.toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=claude');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opened in vscode mode shows a VS Code tab next to the sessions and embeds the editor', async () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="vscode"
        onClose={vi.fn()}
      />,
    );
    // tab strip has both the live shell and the VS Code tab
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(screen.getByText('VS Code')).toBeInTheDocument();
    const frame = await screen.findByTitle('VS Code');
    expect(frame).toHaveAttribute(
      'src',
      `http://127.0.0.1:7788/?folder=${encodeURIComponent(baseWorktree.path)}`,
    );
    // no terminal websocket for the iframe tab
    expect(FakeWS.instances.length).toBe(0);

    // switching to the shell tab shows a live terminal but keeps the VS Code
    // frame MOUNTED (css-hidden) so the workbench + Claude IDE bridge survive
    fireEvent.click(screen.getByText('Shell'));
    expect(FakeWS.instances.length).toBe(1);
    expect(lastWsUrl()).toContain('mode=shell');
    expect(screen.getByTitle(`VS Code — ${baseWorktree.path}`)).toBeInTheDocument();

    // closing the VS Code tab needs no server kill
    fireEvent.click(screen.getByLabelText('Close VS Code session'));
    expect(killSession).not.toHaveBeenCalled();
    expect(screen.queryByText('VS Code')).not.toBeInTheDocument();
  });

  it('header run button starts the dev server and flips to stop when SSE reports it running', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Start dev server'));
    expect(procStart).toHaveBeenCalledWith('default', baseWorktree.path);

    pushSse({ path: baseWorktree.path, process: { status: 'running', detectedUrl: 'http://localhost:8080' } });
    const stopBtn = screen.getByLabelText('Stop dev server');
    expect(stopBtn.title).toContain('running');
    expect(stopBtn.title).toContain('http://localhost:8080');
    fireEvent.click(stopBtn);
    expect(procStop).toHaveBeenCalledWith('default', baseWorktree.path);
  });

  it('shows the env-profile dropdown for repos that define profiles and switches via the API', async () => {
    reposList.mockResolvedValue([
      {
        id: 'r',
        name: 'Reporting',
        envProfiles: [{ name: 'PROD', envFile: '.env.prod' }, { name: 'DEV', envFile: '.env.dev' }],
        defaultEnvProfile: 'PROD',
      },
    ]);
    worktreesList.mockResolvedValue([{ ...baseWorktree }]);
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    const select = await screen.findByLabelText('Env profile'); // appears once the repos fetch lands
    expect(select).toHaveValue('PROD');
    fireEvent.change(select, { target: { value: 'DEV' } });
    expect(setEnvProfile).toHaveBeenCalledWith('default', baseWorktree.path, 'DEV');
    expect(select).toHaveValue('DEV');
  });

  it('shows the workflow-status dropdown for tracked worktrees and patches via the API', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Workflow status');
    fireEvent.change(select, { target: { value: 'in_progress' } });
    expect(wtPatch).toHaveBeenCalledWith('default', baseWorktree.path, { workflowStatus: 'in_progress' });
    expect(select).toHaveValue('in_progress');
  });

  it('hides the workflow-status dropdown when disabled in Appearance settings', () => {
    localStorage.setItem('strado:hub-show-status', 'false');
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Workflow status')).not.toBeInTheDocument();
  });

  it('shows tracked time by default and hides it when disabled in Appearance settings', () => {
    const timed = { ...baseWorktree, activitySeconds: 3900, shellSessions: ['1'] } as Worktree;
    const first = render(<TerminalView worktree={timed} mode="shell" sessionId="1" onClose={vi.fn()} />);
    expect(screen.getByTitle('Active time / original estimate')).toHaveTextContent('1h 5m');
    first.unmount();

    localStorage.setItem('strado:hub-show-time', 'false');
    render(<TerminalView worktree={timed} mode="shell" sessionId="1" onClose={vi.fn()} />);
    expect(screen.queryByTitle('Active time / original estimate')).not.toBeInTheDocument();
  });

  it('hides the workflow-status dropdown for untracked worktrees', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, meta: undefined, shellSessions: ['1'] } as unknown as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Workflow status')).not.toBeInTheDocument();
  });

  // The "Open another worktree" picker (+ header button, search-and-Enter
  // flow) no longer exists — the hub is scoped to a single worktree (see
  // "renders no cross-worktree super-tab picker" above).

  it('Logs button opens the log drawer for the active worktree and Esc closes only the drawer', async () => {
    const onClose = vi.fn();
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('Logs'));
    expect(await screen.findByText('boot line')).toBeInTheDocument();
    expect(procLogs).toHaveBeenCalledWith('default', baseWorktree.path, 500);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('boot line')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('header quick-launch buttons open Claude/Codex/VS Code tabs for the active worktree', async () => {
    localStorage.removeItem('strado:vscode-tabs');
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }));
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=claude');

    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=codex');

    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'VS Code' }));
    expect(await screen.findByTitle('VS Code')).toBeInTheDocument();
    localStorage.removeItem('strado:vscode-tabs');
  });

  it('a VS Code tab survives closing and reopening the panel', async () => {
    localStorage.removeItem('strado:vscode-tabs');
    const first = render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="vscode"
        onClose={vi.fn()}
      />,
    );
    await screen.findByTitle('VS Code');
    first.unmount();

    // reopened on the shell session — the VS Code tab must come back too
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('VS Code')).toBeInTheDocument();

    // ✕ forgets it for the next open
    fireEvent.click(screen.getByLabelText('Close VS Code session'));
    expect(
      JSON.parse(localStorage.getItem('strado:vscode-tabs') ?? '[]'),
    ).toEqual([]);
  });

  it('renders a Codex tab when a codex session is live and connects with mode=codex when opened on it', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasCodexSession: true } as Worktree}
        mode="codex"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=codex');
    expect(lastWsUrl()).toContain('session=1');
  });

  it('renders an OpenCode tab when an opencode session is live and connects with mode=opencode when opened on it', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasOpencodeSession: true } as Worktree}
        mode="opencode"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=opencode');
    expect(lastWsUrl()).toContain('session=1');
  });

  it('codex tab ✕ kills the codex session', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, hasCodexSession: true } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close Codex session'));
    expect(killSession).toHaveBeenCalledWith(expect.anything(), baseWorktree.path, 'codex', '1');
  });

  it('SSE hasCodexSession:false removes the Codex tab', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, hasCodexSession: true } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Codex')).toBeInTheDocument();
    pushSse({ path: baseWorktree.path, hasCodexSession: false });
    expect(screen.queryByText('Codex')).not.toBeInTheDocument();
  });

  it('shows only the opened worktree\'s own label (single-worktree hub)', async () => {
    // Other worktrees with live sessions used to surface as clickable super
    // tabs; the hub is now scoped to the one it was opened on, so their
    // labels must never appear even though `groups` still tracks them (SSE).
    reposList.mockResolvedValue([{ id: 'r', name: 'React' }, { id: 'be', name: 'BE' }]);
    worktreesList.mockResolvedValue([
      { ...baseWorktree },
      {
        ...baseWorktree,
        path: '/Users/me/repo.worktrees/FD-2',
        meta: { ...(baseWorktree.meta as object), ticketId: 'FD-2' },
        shellSessions: ['1', '2'],
      },
      {
        ...baseWorktree,
        path: '/Users/me/be.worktrees/FD-3',
        repoId: 'be',
        meta: { ...(baseWorktree.meta as object), ticketId: 'FD-3' },
        hasClaudeSession: true,
      },
    ]);
    render(<TerminalView worktree={baseWorktree as Worktree} mode="claude" onClose={vi.fn()} />);
    await vi.waitFor(() => expect(worktreesList).toHaveBeenCalled());
    // the header shows no worktree labels at all — the sidebar owns naming
    expect(screen.queryByText('React | FD-1')).not.toBeInTheDocument();
    expect(screen.queryByText('React | FD-2')).not.toBeInTheDocument();
    expect(screen.queryByText('BE | FD-3')).not.toBeInTheDocument();
  });

  it('SSE updates for another worktree never surface its label (single-worktree hub)', async () => {
    reposList.mockResolvedValue([{ id: 'r', name: 'React' }]);
    worktreesList.mockResolvedValue([
      { ...baseWorktree },
      {
        ...baseWorktree,
        path: '/Users/me/repo.worktrees/FD-2',
        meta: { ...(baseWorktree.meta as object), ticketId: 'FD-2' },
      },
    ]);
    render(<TerminalView worktree={baseWorktree as Worktree} mode="claude" onClose={vi.fn()} />);
    await vi.waitFor(() => expect(worktreesList).toHaveBeenCalled());
    pushSse({ path: '/Users/me/repo.worktrees/FD-2', shellSessions: ['1'] });
    expect(screen.queryByText('React | FD-2')).not.toBeInTheDocument();
  });

  it('Review all changes opens the diff for the active worktree and Esc closes only the diff', async () => {
    const onClose = vi.fn();
    gitChanges.mockResolvedValue({
      files: [{ path: 'src/app.ts', status: 'M', staged: 'none', untracked: false }],
    });
    render(<TerminalView worktree={baseWorktree as Worktree} mode="claude" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review all changes' }));
    expect(await screen.findByPlaceholderText('Commit message')).toBeInTheDocument();
    expect(gitChanges).toHaveBeenCalledWith(expect.anything(), baseWorktree.path);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Commit message')).not.toBeInTheDocument();
    // the terminal panel underneath stays open
    expect(onClose).not.toHaveBeenCalled();
  });

  // Clicking a runner's worktree opens THIS hub, not a separate surface — one
  // set of habits regardless of which machine the work is on.
  describe('a worktree that lives on a runner', () => {
    const remoteWorktree = {
      ...worktree,
      path: '/home/strado/repos/strado-website',
      branch: 'main',
      remote: {
        runnerId: 'runner-dev-wq3p',
        runnerName: 'runner-dev',
        wsBase: 'wss://runner-dev-wq3p.r.strado.io',
        wsId: 'default',
      },
    } as unknown as Worktree;

    async function openRemoteHub() {
      runnerRpc.mockReset();
      runnerRpc
        .mockResolvedValueOnce({ repos: [{ id: 'strado-website', name: 'Strado Website', path: '/home/strado/repos/strado-website' }] })
        .mockResolvedValueOnce({
          worktrees: [{
            path: '/home/strado/repos/strado-website',
            repoId: 'strado-website',
            branch: 'main',
            head: 'abc',
            shellSessions: ['1'],
            process: { status: 'idle' },
          }],
        });
      const view = render(<TerminalView worktree={remoteWorktree} onClose={() => {}} mode="shell" />);
      await act(async () => {});
      return view;
    }

    it('sources its session list from the runner, never from this machine', async () => {
      await openRemoteHub();
      expect(runnerRpc).toHaveBeenCalledWith('runner-dev-wq3p', '/api/w/default/worktrees');
      // The local server has never heard of this path; asking it would be a
      // guaranteed miss dressed up as "no sessions".
      expect(worktreesList).not.toHaveBeenCalled();
    });

    it('opens its terminals on the runner', async () => {
      await openRemoteHub();
      await vi.waitFor(() => {
        expect(FakeWS.instances.some((w) => w.url.startsWith('wss://runner-dev-wq3p.r.strado.io/ws/terminal?'))).toBe(true);
      });
      const url = FakeWS.instances.find((w) => w.url.includes('runner-dev-wq3p'))!.url;
      expect(url).toContain(`path=${encodeURIComponent('/home/strado/repos/strado-website')}`);
      expect(url).toContain('ws=default');
    });

    it('names the machine, and omits controls that only read local state', async () => {
      await openRemoteHub();
      // Present: you must always be able to tell where the work is running.
      expect(screen.getByTitle(/on runner-dev$/)).toBeInTheDocument();
      // Absent, not disabled — same rule the capability flag applies to the
      // Electron embeds. An inert control implies it might work.
      expect(screen.queryByLabelText('Diff & commit')).toBeNull();
      expect(screen.queryByLabelText('Changes')).toBeNull();
      expect(screen.queryByLabelText('Logs')).toBeNull();
    });
  });
});
