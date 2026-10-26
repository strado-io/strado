import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Files tab in the hub: its mount (local and runner worktrees), ⌘P, paths
// in terminal output, "Ask an agent" and "Open in editor". FilesTab itself is
// stubbed: these tests are about what the hub hands it.

const peers = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../contexts/IntercomContext', () => ({
  useIntercom: () => ({ peers: peers.list, loaded: true, error: null, refresh: vi.fn() }),
}));

type LinkProvider = { provideLinks(y: number, cb: (links: Array<{ text: string; activate(e: MouseEvent): void }> | undefined) => void): void };
const term = vi.hoisted(() => ({ providers: [] as unknown[], rows: [] as string[] }));
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
    registerLinkProvider = (p: unknown) => { term.providers.push(p); return { dispose: vi.fn() }; };
    buffer = { active: { getLine: (i: number) => (term.rows[i] === undefined ? undefined : { translateToString: () => term.rows[i] }) } };
    write = vi.fn();
    onData() { return { dispose: vi.fn() }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss = vi.fn(); dispose = vi.fn(); } }));
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class { dispose = vi.fn(); } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults = () => ({ dispose: vi.fn() }); dispose = vi.fn(); } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../hooks/useWorkspace', () => ({ useWorkspace: () => ({ workspace: { id: 'default' } }) }));
vi.mock('../eventStream', () => ({ subscribeWorktrees: () => () => {}, subscribeLogs: () => () => {} }));

type FilesTabProps = {
  wsId: string; worktreePath: string; remote?: { runnerId: string; remoteWsId: string; name?: string };
  openPath?: { path: string; line?: number; nonce: number };
  searchRequest?: number;
  onAskAgent?: (ctx: { worktreePath: string; path: string; from: number; to: number; snippet: string }) => void;
  onActiveFile?: (f: { path: string; line: number } | null) => void;
};
const filesTab = vi.hoisted(() => ({ last: null as FilesTabProps | null, fileTabOpen: false }));
vi.mock('../components/files/FilesTab', () => ({
  FilesTab: (p: FilesTabProps) => {
    filesTab.last = p;
    // The real FilesTab marks its root, and whether a file tab is open (the hub's ⌘W defers to it).
    return (
      <div data-testid="files-tab" data-files-tab="" {...(filesTab.fileTabOpen ? { 'data-file-tab-open': '' } : {})}
        data-path={p.worktreePath} data-open={p.openPath ? `${p.openPath.path}:${p.openPath.line ?? ''}` : ''} data-search={p.searchRequest ?? 0}>
        <button type="button">inside files</button>
      </div>
    );
  },
}));

const jarvisMessage = vi.hoisted(() => vi.fn(async () => ({})));
const jarvisRun = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ output: '' })));
vi.mock('../lib/jarvis/serverPort', () => ({ jarvisServerPort: () => ({ message: jarvisMessage, run: jarvisRun }) }));

const filesList = vi.fn();
const runnerRpc = vi.fn();
const editorOpen = vi.fn();
const editorsList = vi.fn();
vi.mock('../api', () => ({
  ApiClientError: class extends Error {},
  api: {
    envCheck: vi.fn().mockResolvedValue([]),
    activity: { beat: vi.fn().mockResolvedValue({ ok: true }) },
    kb: { files: vi.fn().mockResolvedValue({ files: [], truncated: false }), file: vi.fn() },
    files: { list: (...a: unknown[]) => filesList(...a) },
    worktrees: {
      killSession: vi.fn().mockResolvedValue(undefined),
      sessionBusy: vi.fn().mockResolvedValue({ busy: false }),
      start: vi.fn(), stop: vi.fn(), patch: vi.fn().mockResolvedValue({}),
      logs: vi.fn().mockResolvedValue({ lines: [] }), upload: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      mergeRequests: vi.fn().mockResolvedValue({ kind: 'absent' }),
      git: { changes: vi.fn().mockResolvedValue({ files: [] }), branches: vi.fn().mockResolvedValue({ branches: [] }), remotes: vi.fn().mockResolvedValue({ remotes: [] }) },
    },
    repos: { list: vi.fn().mockResolvedValue([]) },
    runners: {
      list: vi.fn().mockResolvedValue({ runners: [] }),
      socketTicket: vi.fn().mockResolvedValue({ ticket: 't'.repeat(48), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), wsBase: 'wss://run1.r.strado.io', httpBase: 'https://run1.r.strado.io' }),
      rpc: (...a: unknown[]) => runnerRpc(...a),
      forwards: { list: vi.fn().mockResolvedValue({ forwards: [] }), open: vi.fn(), close: vi.fn() },
    },
    editors: { open: (...a: unknown[]) => editorOpen(...a), list: (...a: unknown[]) => editorsList(...a) },
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
import { requestRunInShell } from '../lib/runInShell';
import { resetEditorsCache } from '../hooks/editors';
import type { Worktree } from '../types';

const ROOT = '/Users/me/repo.worktrees/FD-1';
const worktree = {
  path: ROOT, repoId: 'r', branch: 'FD-1', head: 'abc', prunable: false, tracked: true,
  meta: { ticketId: 'FD-1', title: 'T', repoId: 'r', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  hasShellSession: true, shellSessions: ['1'],
} as unknown as Worktree;
const remoteWt = {
  ...worktree, path: '/home/strado/repos/site.worktrees/t1', meta: null,
  remote: { runnerId: 'run1', runnerName: 'runner-dev', wsBase: 'wss://run1.r.strado.io', wsId: 'rw' },
} as unknown as Worktree;

const strip = () => within(screen.getByTestId('tab-segments'));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  localStorage.clear();
  term.providers.length = 0;
  term.rows = [];
  filesTab.last = null;
  filesTab.fileTabOpen = false;
  resetEditorsCache();
  editorsList.mockReset().mockResolvedValue({
    preferred: null,
    editors: [
      { id: 'vscode', label: 'VS Code', available: false, lines: true },
      { id: 'cursor', label: 'Cursor', available: true, lines: true },
      { id: 'system', label: 'Finder', available: true, lines: false },
    ],
  });
  peers.list = [];
  filesList.mockReset().mockResolvedValue({ files: ['src/app.ts', 'README.md'], truncated: false });
  runnerRpc.mockReset().mockResolvedValue({ worktrees: [], repos: [] });
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (Element.prototype as any).scrollTo = vi.fn();
});
afterEach(() => { vi.clearAllMocks(); });

describe('Files tab in the hub', () => {
  it('opens from the new-session menu, is a Files tab in the strip, and survives a remount', async () => {
    const { unmount } = render(<TerminalView worktree={worktree} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('New session'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Files' }));
    expect(strip().getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('files-tab')).toHaveAttribute('data-path', ROOT);
    expect(filesTab.last!.remote).toBeUndefined();
    unmount();
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    expect(strip().getByText('Files')).toBeInTheDocument();
  });

  it('mode="files" (the hover card) opens it; closing it forgets it', async () => {
    const { unmount } = render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
    expect(screen.getByTestId('files-tab')).toBeInTheDocument();
    fireEvent.click(strip().getByLabelText(/Close Files/));
    await flush();
    expect(strip().queryByText('Files')).toBeNull();
    unmount();
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    expect(strip().queryByText('Files')).toBeNull();
  });

  it('a runner worktree gets it too, reading through the runner', async () => {
    render(<TerminalView worktree={remoteWt} mode="files" onClose={() => {}} />);
    await flush();
    expect(filesTab.last!.remote).toEqual({ runnerId: 'run1', remoteWsId: 'rw', name: 'runner-dev' });
  });

  it('the hub header: one Open in <editor>, right before Run; it opens the Files tab\'s file at its cursor, else the worktree; ⌘O and ⌘⇧O do the same', async () => {
    editorOpen.mockReset().mockResolvedValue(undefined);
    render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
    await flush();
    expect(screen.getAllByRole('button', { name: 'Open in Cursor' })).toHaveLength(1);
    expect(within(screen.getByTestId('pane-header')).queryByRole('button', { name: 'Open in Cursor' })).toBeNull();
    const pair = screen.getByRole('button', { name: 'Open in Cursor' }).parentElement!;
    const next = pair.nextElementSibling!;
    expect(next.matches('button') ? next : next.querySelector('button')).toHaveAccessibleName(/run/i);
    const button = screen.getByRole('button', { name: 'Open in Cursor' });
    fireEvent.click(button);
    expect(editorOpen).toHaveBeenLastCalledWith('default', { worktreePath: ROOT, editor: 'cursor' });
    act(() => filesTab.last!.onActiveFile!({ path: 'src/app.ts', line: 12 }));
    fireEvent.click(button);
    expect(editorOpen).toHaveBeenLastCalledWith('default', { worktreePath: ROOT, path: 'src/app.ts', line: 12, editor: 'cursor' });
    editorOpen.mockClear();
    fireEvent.keyDown(screen.getByTestId('files-tab'), { key: 'o', metaKey: true });
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
    expect(editorOpen).toHaveBeenCalledTimes(2);
    expect(editorOpen).toHaveBeenLastCalledWith('default', { worktreePath: ROOT, path: 'src/app.ts', line: 12, editor: 'cursor' });
    act(() => filesTab.last!.onActiveFile!(null));
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    expect(editorOpen).toHaveBeenLastCalledWith('default', { worktreePath: ROOT, editor: 'cursor' });
  });

  it('Open with…: another editor just this once, or Finder at the file\'s folder; a failure says so in fixed words', async () => {
    editorOpen.mockReset().mockResolvedValue(undefined);
    render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
    await flush();
    act(() => filesTab.last!.onActiveFile!({ path: 'src/app.ts', line: 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Open with…' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Cursor⌘O', expect.stringMatching(/^(Finder|File manager)$/)]);
    fireEvent.click(screen.getAllByRole('menuitem')[1]!);
    expect(editorOpen).toHaveBeenLastCalledWith('default', { worktreePath: ROOT, path: 'src', editor: 'system' });
    editorOpen.mockRejectedValue(new Error('spawn /usr/bin/code ENOENT'));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Cursor' }));
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t open the editor. Pick one in Settings › Files.');
  });

  it('⌘O inside a dialog (the palette\'s agent cards) is left to it', async () => {
    editorOpen.mockReset().mockResolvedValue(undefined);
    render(<><TerminalView worktree={worktree} mode="files" onClose={() => {}} /><div role="dialog"><input aria-label="box" /></div></>);
    await flush();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'box' }), { key: 'o', metaKey: true });
    expect(editorOpen).not.toHaveBeenCalled();
  });

  it('a shell tab of a local worktree has it too, opening the worktree', async () => {
    editorOpen.mockReset().mockResolvedValue(undefined);
    render(<TerminalView worktree={worktree} mode="shell" sessionId="1" onClose={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Cursor' }));
    expect(editorOpen).toHaveBeenLastCalledWith('default', { worktreePath: ROOT, editor: 'cursor' });
  });

  it('a runner worktree offers no editor: no button, and ⌘O does nothing', async () => {
    editorOpen.mockReset();
    render(<TerminalView worktree={remoteWt} mode="files" onClose={() => {}} />);
    await flush();
    expect(screen.queryByRole('button', { name: 'Open in Cursor' })).toBeNull();
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    expect(editorOpen).not.toHaveBeenCalled();
  });

  it('a UI served by a runner box offers no editor: there is no desktop there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ runner: true, embeds: false }) })));
    try {
      render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
      await flush();
      await flush();
      editorOpen.mockReset();
      expect(screen.queryByRole('button', { name: 'Open in Cursor' })).toBeNull();
      fireEvent.keyDown(window, { key: 'o', metaKey: true });
      expect(editorOpen).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('⌘P lists the worktree files; Enter opens the pick in the Files tab', async () => {
    render(<TerminalView worktree={worktree} onClose={() => {}} />);
    fireEvent.keyDown(window, { key: 'p', metaKey: true });
    const input = await screen.findByRole('combobox', { name: 'Go to file' });
    await flush();
    expect(filesList).toHaveBeenCalledWith('default', ROOT, undefined);
    fireEvent.change(input, { target: { value: 'app:12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('combobox', { name: 'Go to file' })).toBeNull();
    expect(screen.getByTestId('files-tab')).toHaveAttribute('data-open', 'src/app.ts:12');
  });

  describe('⌘⇧F (Ctrl+Shift+F off a Mac): search the worktree\'s files from any tab', () => {
    const filesInFront = () => document.querySelector('[data-tab-key="files:1"]')?.getAttribute('data-active') === 'true';
    afterEach(() => { delete (window as { strado?: unknown }).strado; });

    it('from a terminal tab with no Files tab: one opens, in front, with its search asked for; again asks again', async () => {
      render(<TerminalView worktree={worktree} mode="shell" sessionId="1" onClose={() => {}} />);
      expect(screen.queryByTestId('files-tab')).toBeNull();
      const e = new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      act(() => { window.dispatchEvent(e); });
      expect(e.defaultPrevented).toBe(true);
      expect(screen.getByTestId('files-tab')).toHaveAttribute('data-search', '1');
      expect(strip().getAllByText('Files')).toHaveLength(1);
      expect(filesInFront()).toBe(true);
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true });
      expect(screen.getByTestId('files-tab')).toHaveAttribute('data-search', '2');
      expect(strip().getAllByText('Files')).toHaveLength(1);
    });

    it('on a Mac it is ⌘⇧F; an existing Files tab comes to the front (no second one)', async () => {
      (window as unknown as { strado: unknown }).strado = { platform: 'darwin' };
      render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
      fireEvent.click(strip().getByText(/^Shell/));
      expect(filesInFront()).toBe(false);
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true }); // not the Mac chord
      expect(screen.getByTestId('files-tab')).toHaveAttribute('data-search', '0');
      fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true });
      expect(filesInFront()).toBe(true);
      expect(strip().getAllByText('Files')).toHaveLength(1);
      expect(screen.getByTestId('files-tab')).toHaveAttribute('data-search', '1');
    });

    it('inside the Files tab it works as before (the hub asks the Files tab for its search)', async () => {
      render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
      fireEvent.keyDown(screen.getByRole('button', { name: 'inside files' }), { key: 'f', ctrlKey: true, shiftKey: true });
      expect(screen.getByTestId('files-tab')).toHaveAttribute('data-search', '1');
    });

    it('forwarded from a Browser embed (the desktop\'s files-search hotkey) it does the same', async () => {
      const handlers: Array<(combo: string) => void> = [];
      (window as unknown as { strado: unknown }).strado = { platform: 'darwin', onHotkey: (cb: (combo: string) => void) => { handlers.push(cb); return () => {}; } };
      render(<TerminalView worktree={worktree} mode="shell" sessionId="1" onClose={() => {}} />);
      act(() => { handlers.forEach((h) => h('files-search')); });
      expect(screen.getByTestId('files-tab')).toHaveAttribute('data-search', '1');
    });

    it('⌘F is left alone, and a dialog keeps its keys', async () => {
      render(<TerminalView worktree={worktree} mode="shell" sessionId="1" onClose={() => {}} />);
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
      expect(screen.queryByTestId('files-tab')).toBeNull();
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const input = document.createElement('input');
      dialog.appendChild(input);
      document.body.appendChild(dialog);
      fireEvent.keyDown(input, { key: 'f', ctrlKey: true, shiftKey: true });
      expect(screen.queryByTestId('files-tab')).toBeNull();
      dialog.remove();
    });
  });

  it('a path in terminal output: ⌘-click opens it at its line; a plain click does nothing', async () => {
    render(<TerminalView worktree={worktree} mode="shell" sessionId="1" onClose={() => {}} />);
    const provider = term.providers.at(-1) as LinkProvider;
    expect(provider).toBeDefined();
    term.rows = ['src/app.ts:7:2 - error TS2322'];
    const get = () => new Promise<Array<{ text: string; activate(e: MouseEvent): void }>>((res) => provider.provideLinks(1, (l) => res(l ?? [])));
    let links = await get();
    expect(links.map((l) => l.text)).toEqual(['src/app.ts:7:2']);
    act(() => links[0]!.activate(new MouseEvent('click')));
    expect(screen.queryByTestId('files-tab')).toBeNull();
    act(() => links[0]!.activate(new MouseEvent('click', { metaKey: true, ctrlKey: true })));
    expect(screen.getByTestId('files-tab')).toHaveAttribute('data-open', 'src/app.ts:7');
    // Once the file list is in, a path that isn't a file in the worktree is no link.
    await flush();
    term.rows = ['src/gone.ts:3 and README.md'];
    links = await get();
    expect(links.map((l) => l.text)).toEqual(['README.md']);
  });

  it('Ask an agent: the dialog offers this worktree\'s agent and sends an ask with the lines as context', async () => {
    peers.list = [{ agentId: 'claude-1@repo', alias: null, mode: 'claude', worktreePath: ROOT, sessionId: '1', lifecycle: 'idle', live: true }];
    render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
    act(() => filesTab.last!.onAskAgent!({ worktreePath: ROOT, path: 'src/app.ts', from: 2, to: 3, snippet: 'a\nb' }));
    const dialog = screen.getByRole('dialog', { name: 'Ask an agent about these lines' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Question' }), { target: { value: 'why?' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Ask' })); });
    expect(jarvisMessage).toHaveBeenCalledWith('claude-1@repo', 'why?', {
      ask: true,
      context: [
        { kind: 'file', value: `${ROOT}/src/app.ts:2-3`, label: 'src/app.ts:2-3' },
        { kind: 'text', value: 'a\nb', label: 'selected lines' },
      ],
    });
    expect(screen.queryByRole('dialog', { name: 'Ask an agent about these lines' })).toBeNull();
  });

  it('an Install request opens a new Shell tab and types the command there, retrying until the shell is live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    jarvisRun.mockRejectedValueOnce(new Error('no live tab for that shell yet')).mockResolvedValueOnce({ output: '' });
    render(<TerminalView worktree={worktree} mode="shell" sessionId="1" onClose={() => {}} />);
    act(() => requestRunInShell({ worktreePath: '/elsewhere', command: 'nope' }));
    act(() => requestRunInShell({ worktreePath: ROOT, command: 'npm install -g pyright' }));
    expect(strip().getByText('Shell 2')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(jarvisRun).toHaveBeenCalledTimes(2);
    expect(jarvisRun).toHaveBeenLastCalledWith({ worktreePath: ROOT, mode: 'shell', sessionId: '2' }, 'npm install -g pyright');
    expect(jarvisRun.mock.calls.flat()).not.toContain('nope');
    vi.useRealTimers();
  });

  it('a command that cannot be typed is copied, and the hub says so', async () => {
    jarvisRun.mockRejectedValue(new Error('target is not a shell tab'));
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TerminalView worktree={worktree} mode="shell" sessionId="1" onClose={() => {}} />);
    await act(async () => { requestRunInShell({ worktreePath: ROOT, command: 'brew install gopls' }); await Promise.resolve(); });
    await flush();
    expect(writeText).toHaveBeenCalledWith('brew install gopls');
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't type the command — it's copied; paste it into the shell");
  });

  it('on a runner worktree, Install opens a Shell tab there and copies the command (nothing is typed from this Mac)', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TerminalView worktree={remoteWt} mode="shell" sessionId="1" onClose={() => {}} />);
    await flush();
    act(() => requestRunInShell({ worktreePath: remoteWt.path, command: 'go install golang.org/x/tools/gopls@latest' }));
    expect(strip().getByText('Shell 2')).toBeInTheDocument();
    expect(jarvisRun).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('go install golang.org/x/tools/gopls@latest');
    expect(screen.getByRole('status')).toHaveTextContent('Copied the install command — paste it into this shell on runner-dev');
  });

  it('⌘W inside the Files tab is the Files tab\'s (closes its file tab) while one is open; otherwise it closes the hub tab', async () => {
    filesTab.fileTabOpen = true;
    const { unmount } = render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
    const inside = screen.getByRole('button', { name: 'inside files' });
    inside.focus();
    const ev = new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true });
    act(() => { inside.dispatchEvent(ev); });
    await flush();
    expect(ev.defaultPrevented).toBe(false); // left for the Files tab's own handler
    expect(strip().getByText('Files')).toBeInTheDocument();
    unmount();

    filesTab.fileTabOpen = false;
    render(<TerminalView worktree={worktree} mode="files" onClose={() => {}} />);
    const again = screen.getByRole('button', { name: 'inside files' });
    again.focus();
    act(() => { fireEvent.keyDown(again, { key: 'w', metaKey: true }); });
    await flush();
    expect(strip().queryByText('Files')).toBeNull();
  });
});
