import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TerminalView reads intercom state for the focused tab's escalation banner;
// these tests mount it without the provider, so stub a quiet, "loaded" context.
// `intercomStub` is mutable so the banner tests below can seed one escalation.
const intercomStub = vi.hoisted(() => ({
  peers: [] as unknown[],
}));
vi.mock('../contexts/IntercomContext', () => ({
  useIntercom: () => ({
    peers: intercomStub.peers, loaded: true, error: null,
    refresh: vi.fn(),
  }),
}));

// --- Mock xterm so jsdom (no canvas) can run ---
const onDataHandlers: Array<(d: string) => void> = [];
const keyHandlers: Array<(e: KeyboardEvent) => boolean> = [];
const termFocus = vi.fn();
const searchCalls = vi.hoisted(() => ({ next: [] as unknown[][], clear: 0 }));
const termWrite = vi.fn();
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn((h: (e: KeyboardEvent) => boolean) => { keyHandlers.push(h); });
    focus = termFocus;
    dispose = vi.fn();
    // XtermPane registers CSI handlers (2026 sync-output swallow + DECRQM answer)
    parser = { registerCsiHandler: vi.fn() };
    registerLinkProvider = vi.fn();
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
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { onContextLoss = vi.fn(); dispose = vi.fn(); },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = (...a: unknown[]) => { searchCalls.next.push(a); return true; };
    findPrevious = vi.fn();
    clearDecorations = () => { searchCalls.clear += 1; };
    onDidChangeResults = () => ({ dispose: vi.fn() });
    dispose = vi.fn();
  },
}));

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
const procStart = vi.fn().mockResolvedValue({});
const procStop = vi.fn().mockResolvedValue(undefined);
const closeRunTab = vi.fn().mockResolvedValue({ ok: true });
const setRunCommands = vi.fn(async (_ws: string, _id: string, list: { id?: string; name: string; command: string }[]) => list.map((c) => ({ id: c.id ?? c.name, ...c })));
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
    // The focus heartbeat beats once a test leaves something focused.
    activity: { beat: vi.fn().mockResolvedValue({ ok: true }) },
    kb: {
      files: (...a: unknown[]) => kbFiles(...a),
      file: (...a: unknown[]) => kbFile(...a),
    },
    worktrees: {
      killSession: (...a: unknown[]) => killSession(...a),
      sessionBusy: (...a: unknown[]) => sessionBusy(...a),
      start: (...a: unknown[]) => procStart(...a),
      stop: (...a: unknown[]) => procStop(...a),
      closeRunTab: (...a: unknown[]) => closeRunTab(...a),
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
    repos: { list: (...a: unknown[]) => reposList(...a), setRunCommands: (...a: unknown[]) => (setRunCommands as (...x: unknown[]) => unknown)(...a) },
    runners: {
      list: (...a: unknown[]) => runnersList(...a),
      socketTicket: (...a: unknown[]) => socketTicket(...a),
      rpc: (...a: unknown[]) => runnerRpc(...a),
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
// Tab lookups: the strip only (a pane card's header repeats the tab's title).
const strip = () => within(screen.getByTestId('tab-segments'));

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
  localStorage.clear(); // isolate persisted tab state (closed-agents, browser/files tabs)
  FakeWS.instances = [];
  onDataHandlers.length = 0;
  termWrite.mockClear();
  killSession.mockClear();
  reposList.mockReset().mockResolvedValue([]);
  worktreesList.mockReset().mockResolvedValue([]);
  gitChanges.mockReset().mockResolvedValue({ files: [] });
  mergeRequests.mockReset().mockResolvedValue({ kind: 'absent' });
  procStart.mockReset().mockResolvedValue({});
  closeRunTab.mockReset().mockResolvedValue({ ok: true });
  procStop.mockReset().mockResolvedValue(undefined);
  setRunCommands.mockClear();
  procLogs.mockReset().mockResolvedValue({ lines: ['boot line'] });
  wtPatch.mockReset().mockResolvedValue({});
  envCheck.mockReset().mockResolvedValue([]);
  kbFiles.mockReset().mockResolvedValue({ files: [], truncated: false });
  kbFile.mockReset().mockResolvedValue({ content: '', size: 0, mtimeMs: 0 });
  intercomStub.peers = [];
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

  it('offers no embedded editor: Files is the code view (Open in editor hands off to the person\'s own)', async () => {
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('New session'));
    expect(await screen.findByRole('menuitem', { name: 'Files' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /VS Code/ })).not.toBeInTheDocument();
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
      // Dock-capable embed surfaces align to their pane-tree leaf on the next
      // animation frame; fake timers must advance that frame explicitly.
      await vi.advanceTimersByTimeAsync(20);

      // The tab strip renders labels as plain text (no role="tab" in this app —
      // see the existing 'Shell 2' assertions at TerminalView.test.tsx:262), and
      // clicking the item closes the menu, so this text can only be the tab.
      expect(strip().getByText('Knowledge Base')).toBeInTheDocument();
      // KB is not a pty mode: no terminal WebSocket may be opened for it.
      expect(FakeWS.instances.every((ws) => !ws.url.includes('mode=kb'))).toBe(true);

      // The tab label alone doesn't prove the panel mounted — assert the panel
      // itself is there (its filter input renders unconditionally) and is the
      // visible surface. The pane-tree layer stays mounted underneath because
      // it now supplies the geometry used by docked KB and Browser surfaces.
      expect(screen.getByPlaceholderText('Filter files…')).toBeInTheDocument();
      expect(screen.getByTestId('xterm-pane')).not.toHaveClass('hidden');
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
    expect(termWrite).toHaveBeenCalledWith('output-line', undefined);
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
    expect(changes).toHaveTextContent('+0−0');
    expect(changes).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(changes);
    expect(changes).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText(/no changes|couldn.t load changes|loading/i)).toBeInTheDocument();
  });

  it('⌘L opens the Changes tab; again goes back to the tab you came from (the Changes tab stays)', () => {
    render(<TerminalView worktree={worktree} onClose={vi.fn()} />);
    const changes = screen.getByRole('button', { name: 'Changes' });
    expect(changes).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    expect(changes).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('[data-tab-key="diff:1"]')).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    expect(changes).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('[data-tab-key="diff:1"]')).not.toHaveAttribute('data-active');
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
    // Inside the Browser preview the chord never reaches the
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

  it('a parked session waits for a keystroke, then reattaches with resume=1', () => {
    vi.useFakeTimers();
    try {
      render(<TerminalView worktree={worktree} onClose={() => {}} />);
      const ws = FakeWS.instances[0]!;
      expect(ws.url).not.toContain('resume=1');
      act(() => { ws.onmessage?.({ data: '\r\n[strado:parked] Parked after being idle. Press any key.\r\n' }); });
      // the marker is for the pane, not the user
      expect(termWrite).not.toHaveBeenCalledWith(expect.stringContaining('[strado:parked]'));
      expect(termWrite).toHaveBeenCalledWith(expect.stringContaining('Parked after being idle'));
      ws.readyState = 3;
      act(() => { ws.onclose?.(); });
      act(() => { vi.advanceTimersByTime(30000); });
      expect(FakeWS.instances).toHaveLength(1); // parked: no auto-reconnect
      act(() => { onDataHandlers[onDataHandlers.length - 1]!('x'); });
      expect(FakeWS.instances).toHaveLength(2);
      expect(FakeWS.instances[1]!.url).toContain('resume=1');
      // the waking key is not forwarded into the resumed session
      expect(FakeWS.instances[1]!.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dims a parked Claude tab and explains it on hover', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, claudeSessions: ['1'], parkedClaudeSessions: ['1'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    expect(strip().getByText('Claude').closest('[title]')?.getAttribute('title')).toContain('Parked');
  });

  it('renders one tab per shell session plus claude', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasClaudeSession: true, shellSessions: ['1', '2'] } as Worktree}
        mode="claude"
        onClose={vi.fn()}
      />,
    );
    expect(strip().getByText('Claude')).toBeInTheDocument();
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
    const claudeTab = strip().getByText('Claude').closest('button')!;
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
    expect(strip().getByText('Shell')).toBeInTheDocument();
  });

  it('with nothing saved, a generic open lands on a shell', () => {
    render(<TerminalView worktree={baseWorktree} onClose={vi.fn()} />);
    expect(lastWsUrl()).toContain('mode=shell');
  });

  it('keeps visited terminal panes mounted and connected across tab switches', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1', '2'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );

    expect(FakeWS.instances).toHaveLength(1);
    const shell1Socket = FakeWS.instances[0]!;

    fireEvent.click(screen.getByText('Shell 2'));
    expect(FakeWS.instances).toHaveLength(2);
    const shell2Socket = FakeWS.instances[1]!;
    expect(shell1Socket.close).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-surface-shell:1')).toHaveClass('hidden');

    fireEvent.click(screen.getByText('Shell'));
    expect(FakeWS.instances).toHaveLength(2);
    expect(shell1Socket.close).not.toHaveBeenCalled();
    expect(shell2Socket.close).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-surface-shell:2')).toHaveClass('hidden');
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
    expect(strip().getByText('Claude')).toBeInTheDocument();
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
    expect(strip().getByText('Claude 2')).toBeInTheDocument();
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
    expect(strip().getByText('Claude')).toBeInTheDocument(); // session 1 untouched
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
    expect(strip().getByText('Codex')).toBeInTheDocument();
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
    expect(strip().getByText('Codex 2')).toBeInTheDocument();
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
    expect(strip().getByText('Codex')).toBeInTheDocument();
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
    expect(screen.getAllByTestId('pane-host')).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
    // the new pane is a second claude session with its own pty connection
    expect(lastWsUrl()).toContain('mode=claude');
    expect(lastWsUrl()).toContain('session=2');
    // Both now sit in one group tab.
    expect(screen.getByTestId('tab-group')).toHaveTextContent('Claude · Claude 2');
    // layout persisted so the split survives reload
    expect(localStorage.getItem('strado.paneLayout')).toContain('claude:2');
  });

  it('each pane is a card whose header splits, returns to a full tab, and closes', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );
    // A lone tab is a card too: no full-tab action, the tab's tile in its header.
    const lone = screen.getByTestId('pane-host');
    expect(lone.className).toMatch(/\bpane-card\b/);
    expect(within(lone).getByTestId('tab-tile')).toBeInTheDocument();
    expect(within(lone).queryByRole('button', { name: /full tab/ })).not.toBeInTheDocument();
    fireEvent.click(within(lone).getByRole('button', { name: 'Split Shell down' }));
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Open a surface' }), { key: 't' });
    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'col');
    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
    // The new pane is focused: its card is the marked one.
    const second = screen.getAllByTestId('pane-host')[1]!;
    expect(second).toHaveAttribute('data-focused', 'true');
    expect(screen.getAllByTestId('pane-host')[0]).not.toHaveAttribute('data-focused');
    fireEvent.click(within(second).getByRole('button', { name: 'Open Shell 2 as full tab' }));
    expect(screen.getAllByTestId('pane-host')).toHaveLength(1);
  });

  describe('a card\'s Split right / Split down opens an empty pane: "Open a surface"', () => {
    const shellOnly = () => render(
      <TerminalView worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree} mode="shell" onClose={vi.fn()} />,
    );
    const keys = () => screen.getAllByTestId('pane-host').map((el) => el.getAttribute('data-pane-key'));
    const surface = () => screen.getByRole('menu', { name: 'Open a surface' });

    it('the split happens at once: an empty "New pane" card on that side, listing the kinds with their letters', () => {
      shellOnly();
      fireEvent.click(screen.getByRole('button', { name: 'Split Shell right' }));
      expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
      const [first, second] = screen.getAllByTestId('pane-host');
      expect(first).toHaveAttribute('data-pane-key', 'shell:1');
      expect(second!.getAttribute('data-pane-key')).toMatch(/^new:/);
      expect(within(second!).getByTestId('pane-header')).toHaveTextContent('New pane');
      expect(second).toContainElement(surface());
      expect(surface()).toHaveFocus();
      const rows = within(surface()).getAllByRole('menuitem');
      expect(rows.map((r) => r.getAttribute('data-label')).slice(0, 5)).toEqual(['Claude', 'Codex', 'OpenCode', 'Pi', 'Shell']);
      // Nothing was opened yet: no new session, no new tab.
      expect(screen.queryByTestId('tab-group')).not.toBeInTheDocument();
      expect(localStorage.getItem('strado.paneLayout') ?? '').not.toContain('claude');
    });

    it('C opens Claude in that pane', () => {
      shellOnly();
      fireEvent.click(screen.getByRole('button', { name: 'Split Shell right' }));
      fireEvent.keyDown(surface(), { key: 'c' });
      expect(screen.queryByRole('menu', { name: 'Open a surface' })).not.toBeInTheDocument();
      expect(keys()).toEqual(['shell:1', 'claude:1']);
      expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
      expect(lastWsUrl()).toContain('mode=claude');
      expect(screen.getByTestId('tab-group')).toHaveTextContent(/Claude · Shell|Shell · Claude/);
    });

    it('D opens Changes (the diff) in that pane', async () => {
      shellOnly();
      fireEvent.click(screen.getByRole('button', { name: 'Split Shell right' }));
      fireEvent.keyDown(surface(), { key: 'd' });
      expect(keys()).toEqual(['shell:1', 'diff:1']);
      expect(screen.getByTestId('tab-group')).toHaveTextContent(/Shell · Changes/);
      await vi.waitFor(() => expect(screen.getByTestId(`diff-pane-${baseWorktree.path}`)).not.toHaveClass('hidden'));
    });

    it('Split down, then ↓ ↵ picks with the keyboard (Codex below)', () => {
      shellOnly();
      fireEvent.click(screen.getByRole('button', { name: 'Split Shell down' }));
      fireEvent.keyDown(surface(), { key: 'ArrowDown' });
      fireEvent.keyDown(surface(), { key: 'Enter' });
      expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'col');
      expect(keys()).toEqual(['shell:1', 'codex:1']);
    });

    it('a click on a row opens it there', () => {
      shellOnly();
      fireEvent.click(screen.getByRole('button', { name: 'Split Shell right' }));
      fireEvent.click(within(surface()).getByRole('menuitem', { name: /Shell/ }));
      expect(keys()).toEqual(['shell:1', 'shell:2']);
    });

    it('a disabled kind\'s letter (not installed) is ignored', async () => {
      envCheck.mockResolvedValue([{ id: 'opencode', found: false, hint: 'OpenCode needs to be installed to use' }]);
      shellOnly();
      fireEvent.click(screen.getByRole('button', { name: 'Split Shell right' }));
      const row = within(surface()).getByRole('menuitem', { name: /OpenCode/ });
      await vi.waitFor(() => expect(row).toBeDisabled());
      fireEvent.keyDown(surface(), { key: 'o' });
      expect(surface()).toBeInTheDocument();
      expect(keys()[1]).toMatch(/^new:/);
    });

    it('Esc, or the empty card\'s ✕, removes the pane: the layout is as it was', () => {
      shellOnly();
      fireEvent.click(screen.getByRole('button', { name: 'Split Shell right' }));
      fireEvent.keyDown(surface(), { key: 'Escape' });
      expect(keys()).toEqual(['shell:1']);
      expect(screen.queryByTestId('pane-split')).not.toBeInTheDocument();
      expect(localStorage.getItem('strado.paneLayout') ?? '{}').not.toContain('new:');

      fireEvent.click(screen.getByRole('button', { name: 'Split Shell down' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close New pane' }));
      expect(keys()).toEqual(['shell:1']);
    });

    it('inside an existing split, the empty pane goes beside that card and leaves the rest as it was', () => {
      shellOnly();
      fireEvent.keyDown(window, { key: 'd', metaKey: true }); // shell:1 | shell:2
      fireEvent.click(screen.getByRole('button', { name: 'Split Shell 2 down' }));
      fireEvent.keyDown(surface(), { key: 'Escape' });
      expect(keys()).toEqual(['shell:1', 'shell:2']);
    });
  });

  describe('tab groups: a split layout is one tab in the strip', () => {
    // Shell 1 + Shell 3 split (⌘D from Shell 1); Shell 2 stays a lone tab.
    const grouped = () => {
      render(
        <TerminalView worktree={{ ...baseWorktree, shellSessions: ['1', '2'] } as Worktree} mode="shell" onClose={vi.fn()} />,
      );
      fireEvent.keyDown(window, { key: 'd', metaKey: true });
      return screen.getByTestId('tab-group');
    };

    it('two split tabs collapse into one group tab with both tiles, titled by its members', () => {
      const group = grouped();
      expect(within(group).getAllByTestId('tile-layer')).toHaveLength(2);
      expect(group).toHaveTextContent('Shell · Shell 3');
      expect(strip().queryByText('Shell 3', { exact: true })).not.toBeInTheDocument();
      expect(strip().getByText('Shell 2')).toBeInTheDocument();
      expect(screen.getAllByTestId('tab-group')).toHaveLength(1);
    });

    it('clicking the group shows its layout: both cards', () => {
      const group = grouped();
      fireEvent.click(strip().getByText('Shell 2'));
      expect(screen.getAllByTestId('pane-host')).toHaveLength(1);
      fireEvent.click(within(group).getByTestId('tab-title'));
      expect(screen.getAllByTestId('pane-host').map((el) => el.getAttribute('data-pane-key'))).toEqual(['shell:1', 'shell:3']);
    });

    it('closing the group asks per busy member, then closes them all', async () => {
      grouped();
      sessionBusy.mockResolvedValueOnce({ busy: true }).mockResolvedValueOnce({ busy: false });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      fireEvent.click(screen.getByRole('button', { name: 'Close group Shell · Shell 3' }));
      await vi.waitFor(() => expect(killSession).toHaveBeenCalledTimes(2));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(killSession.mock.calls.map((c) => c[3]).sort()).toEqual(['1', '3']);
      expect(screen.queryByTestId('tab-group')).not.toBeInTheDocument();
      confirmSpy.mockRestore();
    });

    it('a member taken out (its card\'s full tab) ungroups: two plain tabs again', () => {
      grouped();
      fireEvent.click(screen.getByRole('button', { name: 'Open Shell 3 as full tab' }));
      expect(screen.queryByTestId('tab-group')).not.toBeInTheDocument();
      expect(strip().getByText('Shell 3')).toBeInTheDocument();
    });

    it('double-click renames the group; the name survives a reload', () => {
      const group = grouped();
      fireEvent.doubleClick(within(group).getByTestId('tab-title'));
      const input = within(screen.getByTestId('tab-group')).getByRole('textbox', { name: 'Rename group' });
      fireEvent.change(input, { target: { value: 'Review' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByTestId('tab-group')).toHaveTextContent('Review');
      const saved = JSON.parse(localStorage.getItem('strado.paneLayout') ?? '{}');
      expect(saved[baseWorktree.path][0].name).toBe('Review');
    });
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
    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
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
    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
    // Cmd+W closes the focused (new) pane's session
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    await vi.waitFor(() =>
      expect(killSession).toHaveBeenCalledWith(expect.anything(), baseWorktree.path, 'shell', '2'),
    );
    expect(screen.getAllByTestId('pane-host')).toHaveLength(1);
    expect(screen.queryByTestId('pane-split')).not.toBeInTheDocument();
  });

  it('drags an existing tab to a pane edge, then returns it to a full tab', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1', '2'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );

    const shell1 = strip().getByText('Shell').closest<HTMLElement>('[data-tab-key]')!;
    const shell2 = screen.getByText('Shell 2').closest<HTMLElement>('[data-tab-key]')!;
    const pane = screen.getByTestId('pane-host');
    vi.spyOn(shell1, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 0, left: 10, top: 0, right: 70, bottom: 30, width: 60, height: 30,
      toJSON: () => ({}),
    });
    vi.spyOn(shell2, 'getBoundingClientRect').mockReturnValue({
      x: 72, y: 0, left: 72, top: 0, right: 142, bottom: 30, width: 70, height: 30,
      toJSON: () => ({}),
    });
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 40, left: 0, top: 40, right: 800, bottom: 640, width: 800, height: 600,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(shell2, { button: 0, pointerId: 1, clientX: 100, clientY: 15 });
    fireEvent.pointerMove(shell2, { pointerId: 1, clientX: 790, clientY: 320 });
    expect(screen.getByTestId('pane-drop-preview')).toHaveAttribute('data-dock-side', 'right');
    fireEvent.pointerUp(shell2, { pointerId: 1, clientX: 790, clientY: 320 });

    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
    expect(localStorage.getItem('strado.paneLayout')).toContain('shell:2');
    // The two tabs are one group tab now, the shown one; Shell 2's card is focused.
    expect(screen.getByTestId('tab-group')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('tab-group')).toHaveTextContent('Shell · Shell 2');
    expect(screen.getAllByTestId('pane-host')[1]).toHaveAttribute('data-focused', 'true');
    expect(screen.queryByLabelText('Split tab group')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Shell 2 as full tab' }));
    expect(screen.getAllByTestId('pane-host')).toHaveLength(1);
    expect(screen.queryByTestId('pane-split')).not.toBeInTheDocument();
    expect(localStorage.getItem('strado.paneLayout')).not.toContain(baseWorktree.path);
  });

  it('creates and switches between multiple split groups in one worktree', async () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1', '2', '3', '4'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );

    const mockTabRect = (el: Element, left: number) => {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: left, y: 0, left, top: 0, right: left + 70, bottom: 30, width: 70, height: 30,
        toJSON: () => ({}),
      });
    };
    const mockPaneRect = (el: Element) => {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 40, left: 0, top: 40, right: 800, bottom: 640, width: 800, height: 600,
        toJSON: () => ({}),
      });
    };

    // First group: Shell + Shell 2.
    let shell1 = strip().getByText('Shell').closest<HTMLElement>('[data-tab-key]')!;
    let shell2 = screen.getByText('Shell 2').closest<HTMLElement>('[data-tab-key]')!;
    mockTabRect(shell1, 10);
    mockTabRect(shell2, 82);
    mockPaneRect(screen.getByTestId('pane-host'));
    fireEvent.pointerDown(shell2, { button: 0, pointerId: 11, clientX: 100, clientY: 15 });
    fireEvent.pointerMove(shell2, { pointerId: 11, clientX: 790, clientY: 320 });
    fireEvent.pointerUp(shell2, { pointerId: 11, clientX: 790, clientY: 320 });
    fireEvent.click(shell2); // browser emits this click after pointerup; drag guard consumes it
    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
    // Shell 2 folded into a group tab, so that click found no tab: the guard
    // still ends with the gesture and the next click is a real one.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Leave that group intact, open Shell 3 full-size, then make a second
    // independent group by docking Shell 4 beside it.
    fireEvent.click(screen.getByText('Shell 3'));
    expect(screen.getAllByTestId('pane-host')).toHaveLength(1);
    const shell3 = strip().getByText('Shell 3').closest<HTMLElement>('[data-tab-key]')!;
    const shell4 = screen.getByText('Shell 4').closest<HTMLElement>('[data-tab-key]')!;
    mockTabRect(shell3, 154);
    mockTabRect(shell4, 226);
    mockPaneRect(screen.getByTestId('pane-host'));
    fireEvent.pointerDown(shell4, { button: 0, pointerId: 12, clientX: 250, clientY: 15 });
    fireEvent.pointerMove(shell4, { pointerId: 12, clientX: 790, clientY: 320 });
    fireEvent.pointerUp(shell4, { pointerId: 12, clientX: 790, clientY: 320 });
    fireEvent.click(shell4);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const saved = JSON.parse(localStorage.getItem('strado.paneLayout') ?? '{}');
    expect(saved[baseWorktree.path]).toHaveLength(2);

    // Two group tabs, one per layout.
    const groupTabs = screen.getAllByTestId('tab-group');
    expect(groupTabs.map((g) => [g.getAttribute('data-group-index'), g.textContent])).toEqual([
      ['0', expect.stringContaining('Shell · Shell 2')],
      ['1', expect.stringContaining('Shell 3 · Shell 4')],
    ]);
    expect(screen.queryByLabelText('Split tab group')).not.toBeInTheDocument();
    expect(FakeWS.instances).toHaveLength(4);
    const groupSockets = [...FakeWS.instances];

    fireEvent.click(within(groupTabs[0]!).getByTestId('tab-title'));
    expect(screen.getAllByTestId('pane-host').map((el) => el.getAttribute('data-pane-key'))).toEqual([
      'shell:1', 'shell:2',
    ]);
    fireEvent.click(within(screen.getAllByTestId('tab-group')[1]!).getByTestId('tab-title'));
    expect(screen.getAllByTestId('pane-host').map((el) => el.getAttribute('data-pane-key'))).toEqual([
      'shell:3', 'shell:4',
    ]);
    expect(FakeWS.instances).toHaveLength(4);
    expect(groupSockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
  });

  it('docks Knowledge Base beside a shell and marks both tabs as tiled', async () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Knowledge Base' }));
    fireEvent.click(screen.getByText('Shell'));

    const shell = strip().getByText('Shell').closest<HTMLElement>('[data-tab-key]')!;
    const kb = screen.getByText('Knowledge Base').closest<HTMLElement>('[data-tab-key]')!;
    const pane = screen.getByTestId('pane-host');
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 0, left: 10, top: 0, right: 70, bottom: 30, width: 60, height: 30,
      toJSON: () => ({}),
    });
    vi.spyOn(kb, 'getBoundingClientRect').mockReturnValue({
      x: 72, y: 0, left: 72, top: 0, right: 172, bottom: 30, width: 100, height: 30,
      toJSON: () => ({}),
    });
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 40, left: 0, top: 40, right: 800, bottom: 640, width: 800, height: 600,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(kb, { button: 0, pointerId: 2, clientX: 110, clientY: 15 });
    fireEvent.pointerMove(kb, { pointerId: 2, clientX: 790, clientY: 320 });
    fireEvent.pointerUp(kb, { pointerId: 2, clientX: 790, clientY: 320 });

    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
    expect(screen.getByTestId('tab-group')).toHaveTextContent('Shell · Knowledge Base');
    expect(screen.queryByLabelText('Split tab group')).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.getByTestId(`kb-pane-${baseWorktree.path}`)).not.toHaveClass('hidden'),
    );
    expect(screen.getByRole('button', { name: 'Open Knowledge Base as full tab' })).toBeInTheDocument();
  });

  it('opens multiple independently selected documents in one worktree', async () => {
    kbFiles.mockResolvedValue({
      files: [
        { path: 'README.md', size: 10, mtimeMs: 1 },
        { path: 'docs/DEPLOYING.md', size: 20, mtimeMs: 2 },
      ],
      truncated: false,
      cap: 100,
    });
    render(<TerminalView worktree={baseWorktree} mode="shell" onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Knowledge Base' }));
    const openNew = await screen.findByRole('button', { name: 'Open in new tab' });
    await vi.waitFor(() => expect(document.querySelector('[data-tab-key="kb:1"]')).toHaveTextContent('README.md'));
    fireEvent.click(openNew);

    const secondPane = await screen.findByTestId(`kb-pane-${baseWorktree.path}-2`);
    await vi.waitFor(() => expect(secondPane).not.toHaveClass('hidden'));
    fireEvent.click(within(secondPane).getByText('DEPLOYING.md'));

    await vi.waitFor(() => {
      expect(document.querySelector('[data-tab-key="kb:1"]')).toHaveTextContent('README.md');
      expect(document.querySelector('[data-tab-key="kb:2"]')).toHaveTextContent('DEPLOYING.md');
    });
    expect(localStorage.getItem(`strado:kb-selected:${baseWorktree.path}`)).toBe('README.md');
    expect(localStorage.getItem(`strado:kb-selected:${baseWorktree.path}\0kb:2`)).toBe('docs/DEPLOYING.md');
    expect(JSON.parse(localStorage.getItem('strado:kb-tab-ids') ?? '{}')[baseWorktree.path]).toEqual(['2']);
  });

  it('opening one pane as a full tab preserves the rest of a larger layout', () => {
    localStorage.setItem('strado.paneLayout', JSON.stringify({
      [baseWorktree.path]: {
        kind: 'split', dir: 'row', ratio: 0.5,
        a: { kind: 'leaf', key: 'shell:1' },
        b: {
          kind: 'split', dir: 'col', ratio: 0.5,
          a: { kind: 'leaf', key: 'shell:2' },
          b: { kind: 'leaf', key: 'shell:3' },
        },
      },
    }));
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1', '2', '3'] } as Worktree}
        mode="shell"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Shell as full tab' }));
    expect(screen.getAllByTestId('pane-host')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Open Shell as full tab' })).not.toBeInTheDocument();

    // The other two panes remain persisted and return when either tiled tab is
    // selected; only the popped-out tab is full-size.
    fireEvent.click(within(screen.getByTestId('tab-group')).getByTestId('tab-title'));
    expect(screen.getAllByTestId('pane-host')).toHaveLength(2);
    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'col');
    expect(localStorage.getItem('strado.paneLayout')).not.toContain('shell:1');
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
    expect(strip().getByText('Shell 2')).toBeInTheDocument();
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
    expect(strip().getByText('Shell')).toBeInTheDocument();
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
    expect(strip().getByText('Claude')).toBeInTheDocument();
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
    expect(strip().getByText('Claude')).toBeInTheDocument();

    pushSse({ path: baseWorktree.path, hasClaudeSession: false });

    expect(strip().getByText('Claude')).toBeInTheDocument();
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
    expect(strip().getByText('Claude')).toBeInTheDocument();

    pushSse({ path: baseWorktree.path, hasClaudeSession: false });

    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    expect(strip().getByText('Shell')).toBeInTheDocument();
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
    expect(strip().getByText('Shell')).toBeInTheDocument();

    // Server confirms the session: it now owns id '1' (dropped from local).
    pushSse({ path: baseWorktree.path, shellSessions: ['1'] });
    expect(strip().getByText('Shell')).toBeInTheDocument();
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
    expect(strip().getByText('Shell')).toBeInTheDocument();

    // pty spawned -> server confirms id '1' (moves it out of the local set).
    pushSse({ path: baseWorktree.path, shellSessions: ['1'] });

    // Stale list response says no shell sessions -> must not wipe the tab.
    await act(async () => { resolveList([{ ...baseWorktree, shellSessions: [] }]); });
    expect(strip().getByText('Shell')).toBeInTheDocument();
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
    const claudeSocket = FakeWS.instances[0]!;
    // Open a second shell tab locally and switch to it.
    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shell' }));
    expect(strip().getByText('Shell 2')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('session=2');

    // Server confirms both sessions.
    pushSse({ path: baseWorktree.path, shellSessions: ['1', '2'] });
    expect(strip().getByText('Shell 2')).toBeInTheDocument();

    // Server later reports shell 2 gone -> active tab must switch away.
    pushSse({ path: baseWorktree.path, shellSessions: ['1'] });
    expect(screen.queryByText('Shell 2')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('strado.activeTab') ?? '{}')[baseWorktree.path]).toBe('claude:1');
    expect(claudeSocket.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a saved tab from the removed VS Code embed comes back as the Files tab', async () => {
    localStorage.setItem('strado:vscode-tabs', JSON.stringify([baseWorktree.path]));
    localStorage.setItem('strado.activeTab', JSON.stringify({ [baseWorktree.path]: 'vscode:1' }));
    const { migrateEditorTabs } = await import('../hooks/filesTabs');
    migrateEditorTabs();
    render(<TerminalView worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree} onClose={vi.fn()} />);
    expect(strip().getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('files-tab')).toBeInTheDocument();
    expect(localStorage.getItem('strado:vscode-tabs')).toBeNull();
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
    fireEvent.click(screen.getByLabelText('Run'));
    expect(procStart).toHaveBeenCalledWith('default', baseWorktree.path);

    pushSse({ path: baseWorktree.path, process: { status: 'running', detectedUrl: 'http://localhost:8080' } });
    const stopBtn = screen.getByLabelText('Stop');
    expect(stopBtn.title).toContain('running');
    expect(stopBtn.title).toContain('http://localhost:8080');
    fireEvent.click(stopBtn);
    expect(procStop).toHaveBeenCalledWith('default', baseWorktree.path);
  });

  it('run button says what the server is doing: starting, serving on a port, stopping', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Run'));

    // Spawned, nothing listening yet — and still cancellable.
    pushSse({ path: baseWorktree.path, process: { status: 'starting', port: 3000 } });
    const starting = screen.getByLabelText('Stop');
    expect(starting).toHaveTextContent('Starting…');
    expect(starting).not.toBeDisabled();

    pushSse({ path: baseWorktree.path, process: { status: 'running', port: 3000 } });
    expect(screen.getByLabelText('Stop')).toHaveTextContent('Stop :3000');

    fireEvent.click(screen.getByLabelText('Stop'));
    expect(procStop).toHaveBeenCalledWith('default', baseWorktree.path);
    // The kill can take seconds; the button must not pretend it is done.
    pushSse({ path: baseWorktree.path, process: { status: 'stopping', port: 3000 } });
    const stopping = screen.getByLabelText('Stop');
    expect(stopping).toHaveTextContent('Stopping…');
    expect(stopping).toBeDisabled();

    pushSse({ path: baseWorktree.path, process: { status: 'stopped', port: 3000, exitCode: 0 } });
    expect(screen.getByLabelText('Run')).toHaveTextContent('Run');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a start the server refuses is shown, not swallowed', async () => {
    procStart.mockRejectedValue(new Error('empty startCommand'));
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Run'));
    expect(await screen.findByRole('alert')).toHaveTextContent('empty startCommand');
    // The button itself is still a Run button — nothing started.
    expect(screen.getByLabelText('Run')).toHaveTextContent('Run');

    // A later successful start clears the complaint.
    procStart.mockResolvedValue({});
    fireEvent.click(screen.getByLabelText('Run'));
    pushSse({ path: baseWorktree.path, process: { status: 'starting', port: 3000 } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a crash is named as one, with the exit code, and Run is offered again', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    pushSse({ path: baseWorktree.path, process: { status: 'running', port: 3000 } });
    pushSse({ path: baseWorktree.path, process: { status: 'crashed', port: 3000, exitCode: 137 } });

    const btn = screen.getByLabelText('Run');
    expect(btn).toHaveTextContent('Crashed');
    expect(screen.getByRole('alert')).toHaveTextContent('exit code 137');
    fireEvent.click(btn);
    expect(procStart).toHaveBeenCalledWith('default', baseWorktree.path);
  });

  describe('named run commands (they replace env profiles)', () => {
    const RC = [{ id: 'dev', name: 'dev', command: 'pnpm dev' }, { id: 'api', name: 'api', command: 'pnpm api', envFile: '.env.api' }];
    const hubWithRepo = async () => {
      reposList.mockResolvedValue([{ id: 'r', name: 'Reporting', runCommands: RC }]);
      worktreesList.mockResolvedValue([{ ...baseWorktree }]);
      render(<TerminalView worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree} mode="shell" sessionId="1" onClose={vi.fn()} />);
      return screen.findByLabelText('Run dev');
    };
    it('no ENV dropdown any more', async () => {
      await hubWithRepo();
      expect(screen.queryByLabelText('Env profile')).toBeNull();
    });
    it('the main Run runs the default (first) command, without a runId', async () => {
      fireEvent.click(await hubWithRepo());
      expect(procStart).toHaveBeenCalledWith('default', baseWorktree.path);
    });
    it('the ▾ menu runs another command in its own tab "run: api", attached to /ws/run?run=api', async () => {
      await hubWithRepo();
      fireEvent.click(screen.getByLabelText('Run commands'));
      fireEvent.click(screen.getByRole('menuitem', { name: /^api/ }));
      expect(procStart).toHaveBeenCalledWith('default', baseWorktree.path, 'api');
      expect(await strip().findByText('run: api')).toBeInTheDocument();
      await vi.waitFor(() => expect(lastWsUrl()).toContain('/ws/run?'));
      expect(new URL(lastWsUrl()).searchParams.get('run')).toBe('api');
    });
    it('another run\'s state comes from its own events; the default button is untouched', async () => {
      await hubWithRepo();
      pushSse({ path: baseWorktree.path, run: { runId: 'api', name: 'api', status: 'running', tab: 'run' } });
      expect(screen.getByLabelText('Run dev')).toHaveTextContent('Run dev');
      fireEvent.click(screen.getByLabelText('Run commands'));
      expect(screen.getByRole('menuitem', { name: 'api · running' })).toBeInTheDocument();
      fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Stop api' }));
      expect(procStop).toHaveBeenCalledWith('default', baseWorktree.path, 'api');
    });
    it('several at once: the default and api each get their own tab', async () => {
      await hubWithRepo();
      fireEvent.click(screen.getByLabelText('Run dev'));
      expect(await strip().findByText('run')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Run commands'));
      fireEvent.click(screen.getByRole('menuitem', { name: /^api/ }));
      expect(await strip().findByText('run: api')).toBeInTheDocument();
      expect(screen.getByText('run')).toBeInTheDocument();
    });
    it('after a reload a live run of another command comes back as its tab', async () => {
      reposList.mockResolvedValue([{ id: 'r', name: 'Reporting', runCommands: RC }]);
      worktreesList.mockResolvedValue([{ ...baseWorktree, runs: [{ runId: 'api', name: 'api', status: 'running', tab: 'run' }] }]);
      render(<TerminalView worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree} mode="shell" sessionId="1" onClose={vi.fn()} />);
      expect(await screen.findByText('run: api')).toBeInTheDocument();
    });
    it('"+ Add run command…" opens the repo\'s run-command editor; saving replaces the list', async () => {
      await hubWithRepo();
      fireEvent.click(screen.getByLabelText('Run commands'));
      fireEvent.click(screen.getByRole('menuitem', { name: '+ Add run command…' }));
      const dialog = screen.getByRole('dialog', { name: 'Run commands — Reporting' });
      const rows = within(dialog).getAllByRole('group', { name: /^Run command/ });
      fireEvent.change(within(rows[2]!).getByLabelText('Name'), { target: { value: 'storybook' } });
      fireEvent.change(within(rows[2]!).getByLabelText('Command'), { target: { value: 'pnpm sb' } });
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save' })); });
      expect(setRunCommands).toHaveBeenCalledWith('default', 'r', [
        { id: 'dev', name: 'dev', command: 'pnpm dev', envFile: null },
        { id: 'api', name: 'api', command: 'pnpm api', envFile: '.env.api' },
        { name: 'storybook', command: 'pnpm sb', envFile: null },
      ]);
      expect(screen.queryByRole('dialog', { name: /Run commands/ })).toBeNull();
      fireEvent.click(screen.getByLabelText('Run commands'));
      expect(screen.getByRole('menuitem', { name: /^storybook/ })).toBeInTheDocument();
    });
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

  it('no Logs button or drawer: the run output lives in the run tab', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Logs')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Logs' })).toBeNull();
  });

  describe('after the run ends the run tab is a normal shell', () => {
    const hub = () => render(<TerminalView worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree} mode="shell" sessionId="1" onClose={vi.fn()} />);
    const openRun = async () => {
      hub();
      fireEvent.click(screen.getByLabelText('Run'));
      await vi.waitFor(() => expect(lastWsUrl()).toContain('/ws/run?'));
      return FakeWS.instances[FakeWS.instances.length - 1]!;
    };
    it('"[process exited …]" is not the end: input still goes to the shell, and a new Run (4000) reconnects', async () => {
      vi.useFakeTimers();
      try {
        const ws = await openRun();
        act(() => { ws.onmessage?.({ data: '\x1b[2m[process exited with code 0]\x1b[0m\r\n$ ' }); });
        act(() => { onDataHandlers[onDataHandlers.length - 1]!('ls\r'); });
        expect(ws.sent.some((m) => m.includes('ls'))).toBe(true);
        const before = FakeWS.instances.length;
        act(() => { (ws.onclose as unknown as (e: { code: number }) => void)?.({ code: 4000 }); });
        act(() => { vi.advanceTimersByTime(5_000); });
        expect(FakeWS.instances.length).toBeGreaterThan(before);
        expect(lastWsUrl()).toContain('/ws/run?');
      } finally { vi.useRealTimers(); }
    });
    it('Run while the post-run shell is busy: asks first, then starts with force; declined, nothing more', async () => {
      const busy = Object.assign(new Error('CONFLICT'), { details: { reason: 'run_tab_busy' } });
      const confirmSpy = vi.spyOn(window, 'confirm');
      hub();
      procStart.mockRejectedValueOnce(busy);
      confirmSpy.mockReturnValueOnce(true);
      fireEvent.click(screen.getByLabelText('Run'));
      await vi.waitFor(() => expect(procStart).toHaveBeenCalledTimes(2));
      expect(confirmSpy).toHaveBeenCalledWith('The run tab is running something. Stop it and run?');
      expect(procStart).toHaveBeenLastCalledWith('default', baseWorktree.path, undefined, { force: true });
      expect(screen.queryByRole('alert')).toBeNull();
      procStart.mockRejectedValueOnce(busy);
      confirmSpy.mockReturnValueOnce(false);
      fireEvent.click(screen.getByLabelText('Run'));
      await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(2));
      expect(procStart).toHaveBeenCalledTimes(3);
      confirmSpy.mockRestore();
    });
    it('closing the run tab ends its idle shell (DELETE run-tab); while the run is live the server says so and it only detaches', async () => {
      await openRun();
      fireEvent.click(screen.getByLabelText('Close run session'));
      await vi.waitFor(() => expect(screen.queryByText('run')).toBeNull());
      expect(closeRunTab).toHaveBeenCalledWith('default', baseWorktree.path, undefined);
      expect(procStop).not.toHaveBeenCalled();
      closeRunTab.mockRejectedValueOnce(Object.assign(new Error('CONFLICT'), { details: { reason: 'running' } }));
      fireEvent.click(screen.getByLabelText('Run'));
      expect(await strip().findByText('run')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Close run session'));
      await vi.waitFor(() => expect(screen.queryByText('run')).toBeNull());
      expect(screen.queryByRole('alert')).toBeNull();
      expect(procStop).not.toHaveBeenCalled();
    });
  });

  describe('find in the terminal (Ctrl+F here; ⌘F on a Mac)', () => {
    const key = (o: Partial<KeyboardEvent> = {}) => {
      const e = { type: 'keydown', key: 'f', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...o } as unknown as KeyboardEvent;
      let r = true;
      act(() => { r = keyHandlers[keyHandlers.length - 1]!(e); });
      return { r, e };
    };
    const hub = () => render(<TerminalView worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree} mode="shell" sessionId="1" onClose={vi.fn()} />);
    it('opens the find bar on the focused terminal; the key never reaches the pty or another handler', async () => {
      hub();
      await vi.waitFor(() => expect(keyHandlers.length).toBeGreaterThan(0));
      const { r, e } = key();
      expect(r).toBe(false);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(e.stopPropagation).toHaveBeenCalled();
      const input = screen.getByLabelText('Find in terminal');
      expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: 'error' } });
      expect(searchCalls.next.at(-1)?.[0]).toBe('error');
    });
    it('Esc closes it, clears the highlights, and gives the keyboard back to the terminal', async () => {
      hub();
      await vi.waitFor(() => expect(keyHandlers.length).toBeGreaterThan(0));
      key();
      termFocus.mockClear();
      const before = searchCalls.clear;
      fireEvent.keyDown(screen.getByLabelText('Find in terminal'), { key: 'Escape' });
      expect(screen.queryByLabelText('Find in terminal')).toBeNull();
      expect(searchCalls.clear).toBeGreaterThan(before);
      expect(termFocus).toHaveBeenCalled();
    });
    it('Ctrl+Shift+F (⌘⇧F on a Mac) is the worktree\'s file search: never sent to the pty, and not this find bar', async () => {
      hub();
      await vi.waitFor(() => expect(keyHandlers.length).toBeGreaterThan(0));
      expect(key({ shiftKey: true }).r).toBe(false);
      expect(screen.queryByLabelText('Find in terminal')).toBeNull();
    });
    it('other keys pass through to the terminal', async () => {
      hub();
      await vi.waitFor(() => expect(keyHandlers.length).toBeGreaterThan(0));
      expect(key({ key: 'g' }).r).toBe(true);
      expect(key({ ctrlKey: false }).r).toBe(true);
      expect(screen.queryByLabelText('Find in terminal')).toBeNull();
    });
  });

  describe('Run runs the start command in a terminal tab named "run"', () => {
    const hub = () => render(
      <TerminalView
        worktree={{ ...baseWorktree, shellSessions: ['1'] } as Worktree}
        mode="shell"
        sessionId="1"
        onClose={vi.fn()}
      />,
    );
    it('Run starts the server, then opens and focuses the run tab, attached to /ws/run (never a shell spawn)', async () => {
      hub();
      fireEvent.click(screen.getByLabelText('Run'));
      expect(procStart).toHaveBeenCalledWith('default', baseWorktree.path);
      expect(await strip().findByText('run')).toBeInTheDocument();
      await vi.waitFor(() => expect(lastWsUrl()).toContain('/ws/run?'));
      const u = new URL(lastWsUrl());
      expect(u.searchParams.get('ws')).toBe('default');
      expect(u.searchParams.get('path')).toBe(baseWorktree.path);
      expect(u.searchParams.get('cols')).toBeTruthy();
      expect(u.searchParams.has('mode')).toBe(false);
      expect(u.searchParams.has('session')).toBe(false);
    });
    it('closing the run tab detaches: no shell session is killed, the server keeps running', async () => {
      hub();
      fireEvent.click(screen.getByLabelText('Run'));
      expect(await strip().findByText('run')).toBeInTheDocument();
      pushSse({ path: baseWorktree.path, process: { status: 'running', port: 3000 } });
      fireEvent.click(screen.getByLabelText('Close run session'));
      await vi.waitFor(() => expect(screen.queryByText('run')).toBeNull());
      expect(sessionBusy).not.toHaveBeenCalled();
      expect(killSession).not.toHaveBeenCalled();
      expect(procStop).not.toHaveBeenCalled();
    });
    it('Run again reuses the run tab (never a second one)', async () => {
      hub();
      fireEvent.click(screen.getByLabelText('Run'));
      expect(await strip().findByText('run')).toBeInTheDocument();
      pushSse({ path: baseWorktree.path, process: { status: 'stopped', exitCode: 0 } });
      fireEvent.click(screen.getByText('Shell'));
      fireEvent.click(screen.getByLabelText('Run'));
      await vi.waitFor(() => expect(lastWsUrl()).toContain('/ws/run?'));
      expect(screen.getAllByText('run')).toHaveLength(1);
    });
    it('a refused start opens no tab', async () => {
      procStart.mockRejectedValue(new Error('empty startCommand'));
      hub();
      fireEvent.click(screen.getByLabelText('Run'));
      expect(await screen.findByRole('alert')).toHaveTextContent('empty startCommand');
      expect(screen.queryByText('run')).toBeNull();
    });
    it('/ws/run closing with 4404 (nothing to show) is final: no reconnect loop', async () => {
      vi.useFakeTimers();
      try {
        hub();
        fireEvent.click(screen.getByLabelText('Run'));
        await vi.waitFor(() => expect(lastWsUrl()).toContain('/ws/run?'));
        const ws = FakeWS.instances[FakeWS.instances.length - 1]!;
        const before = FakeWS.instances.length;
        act(() => { (ws.onclose as unknown as (e: { code: number }) => void)?.({ code: 4404 }); });
        act(() => { vi.advanceTimersByTime(30_000); });
        expect(FakeWS.instances.length).toBe(before);
      } finally { vi.useRealTimers(); }
    });
    it('after a reload the run tab comes back while the server says there is one (live or crashed)', async () => {
      for (const status of ['running', 'crashed'] as const) {
        worktreesList.mockResolvedValue([{ ...baseWorktree, process: { status, tab: 'run' } }]);
        const v = hub();
        expect(await screen.findByText('run')).toBeInTheDocument();
        // Restored, not forced to the front.
        expect(lastWsUrl()).not.toContain('/ws/run?');
        v.unmount();
      }
    });
    it('no run tab when the server has none (idle, or tab null)', async () => {
      worktreesList.mockResolvedValue([{ ...baseWorktree, process: { status: 'stopped', tab: null } }]);
      hub();
      await vi.waitFor(() => expect(worktreesList).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByText('run')).toBeNull();
    });
    it('a restored run tab the user closes stays closed (until the next Run)', async () => {
      worktreesList.mockResolvedValue([{ ...baseWorktree, process: { status: 'running', tab: 'run' } }]);
      hub();
      expect(await screen.findByText('run')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Close run session'));
      await vi.waitFor(() => expect(screen.queryByText('run')).toBeNull());
      pushSse({ path: baseWorktree.path, process: { status: 'running', port: 3000, tab: 'run' } });
      expect(screen.queryByText('run')).toBeNull();
    });
    it('a crash note links to the run tab ("Open run tab"), not a Logs drawer', async () => {
      hub();
      pushSse({ path: baseWorktree.path, process: { status: 'crashed', port: 3000, exitCode: 1 } });
      expect(screen.getByRole('alert')).toHaveTextContent('exit code 1');
      expect(within(screen.getByRole('alert')).queryByText('Logs')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Open run tab' }));
      await vi.waitFor(() => expect(lastWsUrl()).toContain('/ws/run?'));
      expect(strip().getByText('run')).toBeInTheDocument();
      expect(procStart).not.toHaveBeenCalled();
    });
  });

  it('header quick-launch buttons open Claude/Codex tabs for the active worktree', async () => {
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
    expect(strip().getByText('Claude')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=claude');

    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));
    expect(strip().getByText('Codex')).toBeInTheDocument();
    expect(lastWsUrl()).toContain('mode=codex');
  });

  it('renders a Codex tab when a codex session is live and connects with mode=codex when opened on it', () => {
    render(
      <TerminalView
        worktree={{ ...baseWorktree, hasCodexSession: true } as Worktree}
        mode="codex"
        onClose={vi.fn()}
      />,
    );
    expect(strip().getByText('Codex')).toBeInTheDocument();
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
    expect(strip().getByText('OpenCode')).toBeInTheDocument();
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

  it('the Changes button opens the diff as a tab; Esc leaves it and the hub open', async () => {
    const onClose = vi.fn();
    gitChanges.mockResolvedValue({
      files: [{ path: 'src/app.ts', status: 'M', staged: 'none', untracked: false }],
    });
    render(<TerminalView worktree={baseWorktree as Worktree} mode="claude" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    expect(await screen.findByPlaceholderText('Commit message')).toBeInTheDocument();
    expect(gitChanges).toHaveBeenCalledWith(expect.anything(), baseWorktree.path);

    expect(screen.getByTestId(`diff-pane-${baseWorktree.path}`)).toContainElement(screen.getByPlaceholderText('Commit message'));
    expect(screen.queryByText('Close (Esc)')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByPlaceholderText('Commit message')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  // A blocked agent is invisible once its terminal scrolls on, so the hub
  // itself says who is waiting — for the FOCUSED tab only.
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

describe('shortCount', () => {
  it('keeps the changes pill narrow', async () => {
    const { shortCount } = await import('./TerminalView');
    expect([0, 999, 1000, 1234, 9999, 12_345].map(shortCount)).toEqual(['0', '999', '1k', '1.2k', '10k', '12k']);
  });
});
