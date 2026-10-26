import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ tree: vi.fn(), read: vi.fn(), marks: vi.fn(), list: vi.fn(), search: vi.fn() }));
const lsp = vi.hoisted(() => ({ definition: vi.fn(), references: vi.fn(), hover: vi.fn(), outline: vi.fn() }));
const lspServers = vi.hoisted(() => ({ list: vi.fn() }));
const runners = vi.hoisted(() => ({ rpc: vi.fn() }));
const shell = vi.hoisted(() => ({ requestRunInShell: vi.fn() }));
const git = vi.hoisted(() => ({ changes: vi.fn() }));
vi.mock('../../api', () => ({ api: { files, lsp, lspServers, runners, worktrees: { git } } }));
vi.mock('../../lib/runInShell', () => shell);
vi.mock('./FileViewer', () => ({
  FileViewer: (p: { path: string; line?: number; col?: number; nonce?: number; reloadKey?: number; read: (x: string) => unknown; onAskAgent?: unknown;
    onNavigate?: (k: 'definition' | 'references', at: { path: string; line: number; col: number }) => void;
    onCursor?: (at: { path: string; line: number; col: number }) => void; highlight?: { q: string } | null; headerStart?: React.ReactNode; headerEnd?: React.ReactNode; onMissing?: () => void }) => (
    <div data-testid="viewer" data-path={p.path} data-line={p.line ?? ''} data-col={p.col ?? ''} data-nonce={p.nonce ?? ''} data-reload={p.reloadKey ?? ''}
      data-ask={String(!!p.onAskAgent)} data-highlight={p.highlight?.q ?? ''}>
      <button type="button" onClick={() => void p.read(p.path)}>read</button>
      <button type="button" onClick={() => p.onNavigate?.('definition', { path: p.path, line: 2, col: 4 })}>F12</button>
      <button type="button" onClick={() => p.onNavigate?.('references', { path: p.path, line: 2, col: 4 })}>Shift-F12</button>
      <input aria-label="cursor" onChange={(e) => p.onCursor?.({ path: p.path, line: Number(e.target.value), col: 1 })} />
      {p.headerStart}
      {p.headerEnd}
      <button type="button" onClick={() => p.onMissing?.()}>missing</button>
    </div>
  ),
}));

import { FilesTab } from './FilesTab';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { registerSelection } from './codeSelection';

const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
const page = (dir: string) => ({ dir, truncated: false, entries: dir === '' ? [{ name: 'a.ts', path: 'a.ts', kind: 'file', change: 'M' }, { name: 'b.ts', path: 'b.ts', kind: 'file' }] : [] });

beforeEach(() => {
  for (const f of [...Object.values(files), ...Object.values(lsp), lspServers.list, runners.rpc, shell.requestRunInShell, git.changes]) f.mockReset();
  git.changes.mockResolvedValue({ files: [] });
  localStorage.clear();
  files.tree.mockImplementation(async (_ws: string, _wt: string, dir: string) => page(dir));
  files.read.mockResolvedValue({});
});

describe('FilesTab', () => {
  it('lists the worktree\'s root and opens a picked file in the viewer', async () => {
    render(<FilesTab wsId="ws1" worktreePath="/wt" />);
    await flush();
    expect(files.tree).toHaveBeenCalledWith('ws1', '/wt', '', { ignored: false }, undefined);
    expect(screen.getByText('Pick a file to read it here.')).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-path="a.ts"]')!);
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-path', 'a.ts');
    fireEvent.click(screen.getByRole('button', { name: 'read' }));
    expect(files.read).toHaveBeenCalledWith('ws1', '/wt', 'a.ts', undefined);
  });

  it('a runner\'s worktree reads through the runner', async () => {
    render(<FilesTab wsId="ws1" worktreePath="/home/u/wt" remote={{ runnerId: 'r1', remoteWsId: 'default' }} />);
    await flush();
    expect(files.tree).toHaveBeenCalledWith('ws1', '/home/u/wt', '', { ignored: false }, { runnerId: 'r1', remoteWsId: 'default' });
  });

  it('"Ignored" reloads with ignored files; "Changed" filters without asking again', async () => {
    render(<FilesTab wsId="ws1" worktreePath="/wt" />);
    await flush();
    const changed = screen.getByRole('button', { name: 'Changed' });
    expect(changed).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(changed);
    expect(changed).toHaveAttribute('aria-pressed', 'true');
    expect(changed.className).toContain('glass-pill');
    expect(document.querySelector('[data-path="b.ts"]')).toBeNull();
    expect(files.tree).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Ignored' }));
    await flush();
    expect(files.tree).toHaveBeenLastCalledWith('ws1', '/wt', '', { ignored: true }, undefined);
  });

  it('the header is one row: chips with titles, a changed-files count, and icon buttons', async () => {
    git.changes.mockResolvedValue({ files: [{ path: 'a.ts' }, { path: 'c.ts' }, { path: 'd.ts' }] });
    render(<FilesTab wsId="ws1" worktreePath="/wt" />);
    await flush();
    const header = screen.getByTestId('files-tree-header');
    expect(header.className).toContain('flex-nowrap');
    expect(header.querySelector('input[type="checkbox"]')).toBeNull();
    // The count is in the chip's name, so a screen reader hears it.
    const changed = within(header).getByRole('button', { name: 'Changed, 3 changed' });
    expect(changed).toHaveAttribute('title', expect.stringMatching(/^Changed only/));
    expect(changed).toHaveTextContent('3');
    expect(within(header).getByRole('button', { name: 'Ignored' })).toHaveAttribute('title', expect.stringMatching(/^Show ignored/));
    expect(within(header).getByRole('button', { name: 'Search files' }).querySelector('svg')).not.toBeNull();
    expect(within(header).getByRole('button', { name: 'Refresh files' }).querySelector('svg')).not.toBeNull();
    expect(git.changes).toHaveBeenCalledWith('ws1', '/wt');
  });

  it('the changed count on a runner comes through its rpc', async () => {
    runners.rpc.mockResolvedValue({ files: [{ path: 'x' }] });
    render(<FilesTab wsId="ws1" worktreePath="/home/u/wt" remote={{ runnerId: 'r1', remoteWsId: 'default' }} />);
    await flush();
    expect(runners.rpc).toHaveBeenCalledWith('r1', `/api/w/default/worktrees/${encodeURIComponent('/home/u/wt')}/git/changes`);
    expect(git.changes).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Changed, 1 changed' })).toBeInTheDocument();
  });

  it('narrow: the chips show icons only instead of wrapping', async () => {
    let fire!: () => void;
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb: () => void) { fire = cb; } observe() {} disconnect() {} } as never;
    try {
      render(<FilesTab wsId="ws1" worktreePath="/wt" />);
      await flush();
      const header = screen.getByTestId('files-tree-header');
      expect(within(header).getByRole('button', { name: 'Changed' })).toHaveTextContent('Changed');
      Object.defineProperty(header, 'clientWidth', { configurable: true, value: 180 });
      act(() => fire());
      expect(within(header).getByRole('button', { name: 'Changed' })).not.toHaveTextContent('Changed');
      expect(within(header).getByRole('button', { name: 'Ignored' })).not.toHaveTextContent('Ignored');
    } finally {
      globalThis.ResizeObserver = RO;
    }
  });

  it('openPath opens that file at its line, and a new nonce opens it again', async () => {
    const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', line: 7, nonce: 1 }} />);
    await flush();
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-path', 'a.ts');
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-line', '7');
    const nonce = screen.getByTestId('viewer').getAttribute('data-nonce');
    rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', line: 7, nonce: 2 }} />);
    expect(screen.getByTestId('viewer').getAttribute('data-nonce')).not.toBe(nonce);
    rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'b.ts', nonce: 3 }} />);
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-path', 'b.ts');
  });

  it('Refresh re-lists the tree and re-reads the open file', async () => {
    render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
    await flush();
    const calls = files.tree.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
    await flush();
    expect(files.tree.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-reload', '1');
  });

  it('refreshes by itself when the person comes back — window focus, or the tab shown again — at most every 2s, no polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let observe!: (visible: boolean) => void;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) { observe = (v) => cb([{ isIntersecting: v }]); }
      observe() {} disconnect() {}
    });
    try {
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      const reload = () => screen.getByTestId('viewer').getAttribute('data-reload');
      expect(reload()).toBe('0');
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(reload()).toBe('0'); // nothing on a timer
      act(() => { window.dispatchEvent(new Event('focus')); });
      expect(reload()).toBe('1');
      act(() => { window.dispatchEvent(new Event('focus')); });
      expect(reload()).toBe('1'); // within 2s: once
      await act(async () => { vi.advanceTimersByTime(2500); });
      act(() => { observe(false); });
      act(() => { observe(true); });
      expect(reload()).toBe('2');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('passes Ask agent through', async () => {
    render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} onAskAgent={vi.fn()} />);
    await flush();
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-ask', 'true');
  });

  it('glass panes, 13/11px type, no raw hex', async () => {
    const { container } = render(<FilesTab wsId="ws1" worktreePath="/wt" />);
    await flush();
    expect(container.querySelectorAll('.glass.pane-card')).toHaveLength(2);
    expect(container.innerHTML).not.toMatch(/text-\[(9|10|12)px\]/);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{6}\b/i);
  });

  describe('code navigation', () => {
    const hit = (path: string, line: number, col = 1) => ({ path, line, col, preview: `${path}:${line}` });
    const viewer = () => screen.getByTestId('viewer');
    const where = () => [viewer().getAttribute('data-path'), viewer().getAttribute('data-line'), viewer().getAttribute('data-col')];

    it('one exact definition jumps there; back and forward (buttons, ⌘[ ⌘], Alt←→) walk the history', async () => {
      lsp.definition.mockResolvedValue({ source: 'lsp', server: 'typescript', hits: [hit('lib/util.ts', 40, 7)] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      expect(lsp.definition).toHaveBeenCalledWith('ws1', '/wt', { path: 'a.ts', line: 2, col: 4 }, undefined, expect.any(AbortSignal));
      expect(where()).toEqual(['lib/util.ts', '40', '7']);
      expect(screen.queryByTestId('nav-panel')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(where()).toEqual(['a.ts', '2', '4']);
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: ']', metaKey: true });
      expect(where()).toEqual(['lib/util.ts', '40', '7']);
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: 'ArrowLeft', altKey: true });
      expect(where()).toEqual(['a.ts', '2', '4']);
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: 'ArrowRight', altKey: true });
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: '[', metaKey: true });
      expect(where()).toEqual(['a.ts', '2', '4']);
    });

    it('cursor moves: far ones are recorded, near ones move the current place; Ctrl+- / Ctrl+Shift+- walk them', async () => {
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      const cursor = (line: number) => fireEvent.change(screen.getByLabelText('cursor'), { target: { value: String(line) } });
      const tab = screen.getByTestId('files-tab');
      cursor(5); // near line 1: no entry
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      cursor(30); // far: 5 is recorded
      cursor(35); // near 30: 30 becomes 35
      cursor(80); // far: 35 is recorded
      fireEvent.keyDown(tab, { key: '-', code: 'Minus', ctrlKey: true });
      expect(where()).toEqual(['a.ts', '35', '1']);
      fireEvent.keyDown(tab, { key: '-', code: 'Minus', ctrlKey: true });
      expect(where()).toEqual(['a.ts', '5', '1']);
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      fireEvent.keyDown(tab, { key: '_', code: 'Minus', ctrlKey: true, shiftKey: true });
      expect(where()).toEqual(['a.ts', '35', '1']);
      fireEvent.keyDown(tab, { key: '_', code: 'Minus', ctrlKey: true, shiftKey: true });
      expect(where()).toEqual(['a.ts', '80', '1']);
      expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
      // A new far move after going back drops the forward list.
      fireEvent.keyDown(tab, { key: '[', metaKey: true });
      cursor(200);
      expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    });

    it('switching files records the place left, including an open from elsewhere; history keeps 50', async () => {
      const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'b.ts', line: 9, nonce: 2 }} />);
      expect(where()).toEqual(['b.ts', '9', '1']);
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(where()).toEqual(['a.ts', '1', '1']);
      const cursor = (line: number) => fireEvent.change(screen.getByLabelText('cursor'), { target: { value: String(line) } });
      for (let i = 1; i <= 60; i++) cursor(i * 100);
      let backs = 0;
      while (!screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')) { fireEvent.click(screen.getByRole('button', { name: 'Back' })); backs++; }
      expect(backs).toBe(50);
      expect(where()).toEqual(['a.ts', '1000', '1']);
    });

    it('several definitions, or a search guess, are offered to pick from with why', async () => {
      lsp.definition.mockResolvedValueOnce({ source: 'search', server: 'typescript', fallback: 'not-installed', hits: [hit('x.ts', 3)] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      expect(where()[0]).toBe('a.ts');
      const panel = screen.getByTestId('nav-panel');
      expect(panel).toHaveTextContent('Possible definitions (no TypeScript server — install in Settings)');
      fireEvent.click(within(panel).getByRole('button', { name: /x\.ts:3/ }));
      expect(where()).toEqual(['x.ts', '3', '1']);
      expect(screen.queryByTestId('nav-panel')).toBeNull();
    });

    it('references open a panel grouped by file that stays while you click through; Esc closes', async () => {
      lsp.references.mockResolvedValue({ source: 'lsp', server: 'typescript', hits: [hit('a.ts', 2), hit('b.ts', 9), hit('a.ts', 30)] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Shift-F12' }));
      expect(screen.getByTestId('nav-panel')).toHaveTextContent('Finding references');
      await flush();
      const panel = screen.getByTestId('nav-panel');
      expect(panel).toHaveTextContent('References · 3');
      fireEvent.click(within(within(panel).getByRole('region', { name: 'b.ts' })).getByRole('button'));
      expect(where()).toEqual(['b.ts', '9', '1']);
      expect(screen.getByTestId('nav-panel')).toBeInTheDocument();
      fireEvent.keyDown(screen.getByTestId('nav-panel'), { key: 'Escape' });
      expect(screen.queryByTestId('nav-panel')).toBeNull();
    });

    it('a newer navigation cancels the one in flight', async () => {
      const signals: AbortSignal[] = [];
      lsp.definition.mockImplementation((_w: string, _p: string, _a: unknown, _r: unknown, s: AbortSignal) => { signals.push(s); return new Promise(() => {}); });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(signals[1]!.aborted).toBe(true);
    });

    it('a runner\'s worktree navigates through the runner', async () => {
      lsp.definition.mockResolvedValue({ source: 'lsp', hits: [] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" remote={{ runnerId: 'r1', remoteWsId: 'default' }} openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      expect(lsp.definition.mock.calls[0]![3]).toEqual({ runnerId: 'r1', remoteWsId: 'default' });
      expect(screen.getByTestId('nav-panel')).toHaveTextContent('No definition found.');
    });

    it('⌘⇧F opens search in place of the tree; a result opens there and Back returns', async () => {
      files.search.mockResolvedValue({ engine: 'rg', truncated: false, hits: [hit('deep/c.ts', 12, 3)] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: 'F', metaKey: true, shiftKey: true });
      expect(screen.getByTestId('search-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('file-tree')).toBeNull();
      fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'needle' } });
      await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
      expect(files.search).toHaveBeenCalledWith('ws1', '/wt', { q: 'needle', word: false, case: false, regex: false }, undefined, expect.any(AbortSignal));
      fireEvent.click(screen.getByRole('option', { name: /deep\/c\.ts:12/ }));
      expect(where()).toEqual(['deep/c.ts', '12', '3']);
      // The code marks what was searched for, until the search closes.
      expect(screen.getByTestId('viewer')).toHaveAttribute('data-highlight', 'needle');
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(where()[0]).toBe('a.ts');
      fireEvent.keyDown(screen.getByTestId('search-panel'), { key: 'Escape' });
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
      expect(screen.getByTestId('viewer')).toHaveAttribute('data-highlight', '');
    });

    it('⌘⇧F from elsewhere in the hub (searchRequest): the search opens, seeded with the code\'s one-line selection', async () => {
      const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      expect(screen.queryByTestId('search-panel')).toBeNull();
      // The code view (FileViewer is stubbed here): a real editor in the focused pane, "needle" selected.
      const doc = 'const needle = 1;\nnext line';
      const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: 6, head: 12 } }), parent: screen.getByTestId('files-pane-0') });
      registerSelection(view.dom, () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)); // as codeView does
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} searchRequest={1} />);
      expect(screen.getByTestId('search-panel')).toBeInTheDocument();
      expect(screen.getByLabelText('Search text')).toHaveValue('needle');
      expect(screen.getByLabelText('Search text')).toHaveFocus();
      // A selection across lines seeds nothing; the box keeps what it has and is focused again.
      view.dispatch({ selection: { anchor: 6, head: doc.length } });
      fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'kept' } });
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} searchRequest={2} />);
      expect(screen.getByLabelText('Search text')).toHaveValue('kept');
      view.destroy();
    });

    it('in a text box Alt←/→, ⌘[ and Ctrl- are the box\'s; elsewhere they go back', async () => {
      lsp.definition.mockResolvedValue({ source: 'lsp', server: 'typescript', hits: [hit('lib/util.ts', 40, 7)] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      fireEvent.keyDown(screen.getByLabelText('cursor'), { key: 'ArrowLeft', altKey: true });
      expect(where()[0]).toBe('lib/util.ts');
      fireEvent.keyDown(screen.getByLabelText('cursor'), { key: '[', metaKey: true });
      fireEvent.keyDown(screen.getByLabelText('cursor'), { key: '-', code: 'Minus', ctrlKey: true });
      expect(where()[0]).toBe('lib/util.ts');
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: '[', metaKey: true });
      expect(where()[0]).toBe('a.ts');
    });

    it('no server installed: Install sends this machine\'s command to a Shell tab', async () => {
      lsp.definition.mockResolvedValue({ source: 'search', server: 'typescript', fallback: 'not-installed', hits: [hit('x.ts', 3)] });
      lspServers.list.mockResolvedValue([{ id: 'typescript', install: [{ command: 'brew install x', available: false }, { command: 'npm i -g typescript-language-server typescript', available: true }] }]);
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      fireEvent.click(within(screen.getByTestId('nav-panel')).getByRole('button', { name: 'Install' }));
      await flush();
      expect(shell.requestRunInShell).toHaveBeenCalledWith({ worktreePath: '/wt', command: 'npm i -g typescript-language-server typescript' });
    });

    it('on a runner: the hint names it, and Install asks the runner for its command', async () => {
      lsp.definition.mockResolvedValue({ source: 'search', server: 'pyright', fallback: 'not-installed', hits: [hit('x.py', 3)] });
      runners.rpc.mockResolvedValue({ servers: [{ id: 'pyright', install: [{ command: 'pipx install pyright', available: true }] }] });
      render(<FilesTab wsId="ws1" worktreePath="/home/u/wt" remote={{ runnerId: 'r1', remoteWsId: 'default', name: 'runner-dev' }} openPath={{ path: 'a.py', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      const panel = screen.getByTestId('nav-panel');
      expect(panel).toHaveTextContent('Possible definitions (no Python server — install it on runner-dev from a Shell tab there)');
      fireEvent.click(within(panel).getByRole('button', { name: 'Install' }));
      await flush();
      expect(runners.rpc).toHaveBeenCalledWith('r1', '/api/lsp/servers');
      expect(lspServers.list).not.toHaveBeenCalled();
      expect(shell.requestRunInShell).toHaveBeenCalledWith({ worktreePath: '/home/u/wt', command: 'pipx install pyright' });
    });

    it('opening another file drops a definition still being looked up', async () => {
      let resolve!: (a: unknown) => void;
      lsp.definition.mockReturnValue(new Promise((r) => { resolve = r; }));
      const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      expect(screen.getByTestId('nav-panel')).toBeInTheDocument();
      const signal = lsp.definition.mock.calls[0]![4] as AbortSignal;
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'b.ts', nonce: 2 }} />);
      expect(signal.aborted).toBe(true);
      expect(screen.queryByTestId('nav-panel')).toBeNull();
      resolve({ source: 'lsp', server: 'typescript', hits: [hit('lib/util.ts', 40, 7)] });
      await flush();
      expect(where()[0]).toBe('b.ts');
    });

    it('a failed lookup says so in navigation words', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      lsp.references.mockRejectedValue({ code: 'TIMEOUT', message: 'relay said <b>x</b>' });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Shift-F12' }));
      await flush();
      expect(screen.getByTestId('nav-panel')).toHaveTextContent('That took too long — try again.');
    });
  });

  it('a slow first lookup says the project is loading, with Cancel; the answer clears it', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (a: unknown) => void;
      lsp.references.mockReturnValue(new Promise((r) => { resolve = r; }));
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Shift-F12' }));
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.getByTestId('nav-panel')).not.toHaveTextContent('Loading TypeScript project');
      act(() => { vi.advanceTimersByTime(400); });
      const panel = screen.getByTestId('nav-panel');
      expect(panel).toHaveTextContent('Loading TypeScript project… (first lookup takes a while)');
      resolve({ source: 'lsp', server: 'typescript', hits: [{ path: 'a.ts', line: 3, col: 1, preview: 'x' }] });
      await flush();
      expect(screen.getByTestId('nav-panel')).toHaveTextContent('References · 1');
      expect(within(screen.getByTestId('nav-panel')).queryByRole('button', { name: 'Cancel' })).toBeNull();
      // Cancel ends a slow one.
      lsp.references.mockReturnValue(new Promise(() => {}));
      fireEvent.click(screen.getByRole('button', { name: 'Shift-F12' }));
      act(() => { vi.advanceTimersByTime(900); });
      const signal = lsp.references.mock.calls.at(-1)![4] as AbortSignal;
      fireEvent.click(within(screen.getByTestId('nav-panel')).getByRole('button', { name: 'Cancel' }));
      expect(signal.aborted).toBe(true);
      expect(screen.queryByTestId('nav-panel')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('file tabs', () => {
    const hit = (path: string, line: number, col = 1) => ({ path, line, col, preview: `${path}:${line}` });
    const pane = (i: number) => screen.getByTestId(`files-pane-${i}`);
    const strip = (i = 0) => within(pane(i)).getAllByRole('tab').map((t) => `${t.textContent?.replace('×', '')}${t.hasAttribute('data-preview') ? '*' : ''}${t.getAttribute('aria-selected') === 'true' ? '!' : ''}`);
    const viewerIn = (i: number) => within(pane(i)).getByTestId('viewer');
    const treeItem = (path: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;

    it('a tree click opens the preview tab, the next one replaces it; double-click keeps it', async () => {
      render(<FilesTab wsId="ws1" worktreePath="/wt" />);
      await flush();
      fireEvent.click(treeItem('a.ts'));
      expect(strip()).toEqual(['a.ts*!']);
      fireEvent.click(treeItem('b.ts'));
      expect(strip()).toEqual(['b.ts*!']);
      fireEvent.doubleClick(within(pane(0)).getByRole('tab'));
      expect(strip()).toEqual(['b.ts!']);
      fireEvent.click(treeItem('a.ts'));
      expect(strip()).toEqual(['b.ts', 'a.ts*!']);
      fireEvent.doubleClick(treeItem('a.ts'));
      expect(strip()).toEqual(['b.ts', 'a.ts!']);
    });

    it('a definition opens its own tab and the first stays; each tab keeps its cursor; an open file is switched to', async () => {
      lsp.definition.mockResolvedValue({ source: 'lsp', server: 'typescript', hits: [hit('lib/util.ts', 40, 7)] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.change(screen.getByLabelText('cursor'), { target: { value: '5' } });
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      expect(strip()).toEqual(['a.ts', 'util.ts!']);
      expect(viewerIn(0)).toHaveAttribute('data-path', 'lib/util.ts');
      fireEvent.click(within(pane(0)).getByRole('tab', { name: /a\.ts/ }));
      expect(viewerIn(0)).toHaveAttribute('data-path', 'a.ts');
      expect(viewerIn(0)).toHaveAttribute('data-line', '2'); // where F12 was pressed: the cursor
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      expect(strip()).toEqual(['a.ts', 'util.ts!']); // switched to, not opened twice
      expect(viewerIn(0)).toHaveAttribute('data-line', '40');
    });

    it('× , middle-click and ⌘W close tabs; the neighbour takes over', async () => {
      const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'b.ts', nonce: 2 }} />);
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'c.ts', nonce: 3 }} />);
      expect(strip()).toEqual(['a.ts', 'b.ts', 'c.ts!']);
      // The hub's ⌘W steps aside while this is set.
      expect(screen.getByTestId('files-tab')).toHaveAttribute('data-file-tab-open');
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: 'w', metaKey: true });
      expect(strip()).toEqual(['a.ts', 'b.ts!']);
      fireEvent.click(within(pane(0)).getByRole('button', { name: 'Close b.ts' }));
      expect(strip()).toEqual(['a.ts!']);
      fireEvent(within(pane(0)).getByRole('tab'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
      expect(screen.queryByRole('tab')).toBeNull();
      expect(screen.getByText('Pick a file to read it here.')).toBeInTheDocument();
      // No file tab left: ⌘W is the hub's again.
      expect(screen.getByTestId('files-tab')).not.toHaveAttribute('data-file-tab-open');
    });

    it('⌥-click a reference opens it to the side; both show; Esc closes the side pane', async () => {
      lsp.references.mockResolvedValue({ source: 'lsp', server: 'typescript', hits: [hit('a.ts', 2, 4), hit('lib/util.ts', 9)] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Shift-F12' }));
      await flush();
      fireEvent.click(within(screen.getByTestId('nav-panel')).getByRole('button', { name: /lib\/util\.ts:9/ }), { altKey: true });
      expect(viewerIn(0)).toHaveAttribute('data-path', 'a.ts');
      expect(viewerIn(1)).toHaveAttribute('data-path', 'lib/util.ts');
      expect(viewerIn(1)).toHaveAttribute('data-line', '9');
      // A plain click opens in the pane the lookup came from.
      fireEvent.click(within(screen.getByTestId('nav-panel')).getByRole('button', { name: /lib\/util\.ts:9/ }));
      expect(strip(0)).toEqual(['a.ts', 'util.ts!']);
      fireEvent.click(within(screen.getByTestId('nav-panel')).getByRole('button', { name: 'Close' }));
      fireEvent.mouseDown(pane(1));
      fireEvent.keyDown(viewerIn(1), { key: 'Escape' });
      expect(screen.queryByTestId('files-pane-1')).toBeNull();
    });

    it('"Open to the side" shows the file in a second pane; its × closes that pane', async () => {
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Open to the side' }));
      expect(viewerIn(1)).toHaveAttribute('data-path', 'a.ts');
      expect(screen.queryByRole('button', { name: 'Open to the side' })).toBeNull(); // two panes at most
      fireEvent.click(screen.getByRole('button', { name: 'Close side pane' }));
      expect(screen.queryByTestId('files-pane-1')).toBeNull();
    });

    it('back/forward switch tabs and panes as needed', async () => {
      lsp.definition.mockResolvedValue({ source: 'lsp', server: 'typescript', hits: [hit('lib/util.ts', 40, 7)] });
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: '[', metaKey: true });
      expect(strip()).toEqual(['a.ts!', 'util.ts']);
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: ']', metaKey: true });
      expect(strip()).toEqual(['a.ts', 'util.ts!']);
      // Closed meanwhile: back reopens it.
      fireEvent.click(within(pane(0)).getByRole('button', { name: 'Close a.ts' }));
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: '[', metaKey: true });
      expect(viewerIn(0)).toHaveAttribute('data-path', 'a.ts');
    });

    it('open tabs are kept per worktree and come back when it reopens', async () => {
      const first = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Open to the side' }));
      first.unmount();
      render(<FilesTab wsId="ws1" worktreePath="/wt" />);
      await flush();
      expect(strip(0)).toEqual(['a.ts!']);
      expect(viewerIn(1)).toHaveAttribute('data-path', 'a.ts');
      cleanupOther();
    });
    const cleanupOther = () => { localStorage.clear(); };

    it('another worktree has its own tabs', async () => {
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      const { unmount } = render(<FilesTab wsId="ws1" worktreePath="/other" />);
      expect(within(screen.getAllByTestId('files-tab')[1]!).queryByRole('tab')).toBeNull();
      unmount();
    });

    it('keyboard: ←/→/Home/End move between tabs, Enter shows one, Delete closes; each pane has its tabpanel', async () => {
      const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'b.ts', nonce: 2 }} />);
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'c.ts', nonce: 3 }} />);
      const tabs = () => within(pane(0)).getAllByRole('tab');
      expect(tabs()[2]).toHaveAttribute('tabindex', '0');
      expect(within(tabs()[2]!).queryByRole('button')).toBeNull(); // no button inside a tab
      const panel = within(pane(0)).getByRole('tabpanel');
      expect(tabs()[2]).toHaveAttribute('aria-controls', panel.id);
      expect(panel).toHaveAttribute('aria-labelledby', tabs()[2]!.id);
      tabs()[2]!.focus();
      fireEvent.keyDown(tabs()[2]!, { key: 'ArrowRight' });
      expect(document.activeElement).toBe(tabs()[0]);
      fireEvent.keyDown(tabs()[0]!, { key: 'End' });
      expect(document.activeElement).toBe(tabs()[2]);
      fireEvent.keyDown(tabs()[2]!, { key: 'ArrowLeft' });
      fireEvent.keyDown(tabs()[1]!, { key: 'Enter' });
      expect(strip()).toEqual(['a.ts', 'b.ts!', 'c.ts']);
      fireEvent.keyDown(tabs()[1]!, { key: 'Delete' });
      expect(strip()).toEqual(['a.ts', 'c.ts!']);
    });

    it('⌘W from the find bar or another box closes the file tab too', async () => {
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.keyDown(screen.getByLabelText('cursor'), { key: 'w', metaKey: true });
      expect(screen.queryByRole('tab')).toBeNull();
    });

    it('opening an open file without a line keeps its place', async () => {
      const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', line: 30, nonce: 1 }} />);
      await flush();
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'b.ts', nonce: 2 }} />);
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 3 }} />);
      expect(viewerIn(0)).toHaveAttribute('data-path', 'a.ts');
      expect(viewerIn(0)).toHaveAttribute('data-line', '30');
    });

    it('a restored tab whose file is gone closes; one opened now stays to say so', async () => {
      const first = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'gone.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'missing' }));
      expect(strip()).toEqual(['gone.ts!']);
      first.unmount();
      render(<FilesTab wsId="ws1" worktreePath="/wt" />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'missing' }));
      expect(screen.queryByRole('tab')).toBeNull();
    });

    it('another worktree starts with its own history', async () => {
      lsp.definition.mockResolvedValue({ source: 'lsp', server: 'typescript', hits: [hit('lib/util.ts', 40, 7)] });
      const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'F12' }));
      await flush();
      expect(screen.getByRole('button', { name: 'Back' })).not.toBeDisabled();
      rerender(<FilesTab wsId="ws1" worktreePath="/wt2" openPath={{ path: 'a.ts', nonce: 2 }} />);
      await flush();
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    });

    it('reports the active file and its cursor line for the pane title bar, and null with none', async () => {
      const onActiveFile = vi.fn();
      const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" onActiveFile={onActiveFile} />);
      await flush();
      expect(onActiveFile).toHaveBeenLastCalledWith(null);
      expect(within(screen.getByTestId('files-tree-header')).queryByRole('button', { name: /Open worktree/ })).toBeNull();
      // ⌘⇧O is the hub's (its window listener), not this tab's.
      const ev = new KeyboardEvent('keydown', { key: 'O', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
      screen.getByTestId('files-tab').dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      rerender(<FilesTab wsId="ws1" worktreePath="/wt" onActiveFile={onActiveFile} openPath={{ path: 'a.ts', line: 7, nonce: 1 }} />);
      expect(onActiveFile).toHaveBeenLastCalledWith({ path: 'a.ts', line: 7 });
      fireEvent.change(screen.getByLabelText('cursor'), { target: { value: '40' } });
      expect(onActiveFile).toHaveBeenLastCalledWith({ path: 'a.ts', line: 40 });
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: 'w', metaKey: true });
      expect(onActiveFile).toHaveBeenLastCalledWith(null);
    });

  describe('explorer', () => {
    const explorer = () => screen.getByRole('complementary', { hidden: true, name: 'Explorer' });
    const shown = () => !explorer().classList.contains('hidden');

    it('hides and shows with the toggle (or ⌘⇧E, even from a box), and stays as left', async () => {
      const first = render(<FilesTab wsId="ws1" worktreePath="/wt" />);
      await flush();
      expect(shown()).toBe(true);
      const toggle = screen.getByRole('button', { name: 'Hide explorer' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(toggle).toHaveAttribute('title', 'Hide explorer (⌘⇧E)');
      fireEvent.click(toggle);
      expect(shown()).toBe(false);
      expect(screen.queryByTestId('explorer-resize')).toBeNull();
      expect(screen.getByRole('button', { name: 'Show explorer' })).toHaveAttribute('aria-pressed', 'false');
      first.unmount();
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      expect(shown()).toBe(false); // remembered, and opening a file doesn't force it open
      fireEvent.keyDown(screen.getByLabelText('cursor'), { key: 'E', metaKey: true, shiftKey: true });
      expect(shown()).toBe(true);
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: 'E', metaKey: true, shiftKey: true });
      expect(shown()).toBe(false);
    });

    it('⌘⇧F while hidden shows it for the search; closing the search hides it again', async () => {
      render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Hide explorer' }));
      fireEvent.keyDown(screen.getByTestId('files-tab'), { key: 'F', metaKey: true, shiftKey: true });
      expect(shown()).toBe(true);
      expect(screen.getByTestId('search-panel')).toBeInTheDocument();
      fireEvent.keyDown(screen.getByTestId('search-panel'), { key: 'Escape' });
      expect(shown()).toBe(false);
      expect(screen.getByRole('button', { name: 'Show explorer' })).toBeInTheDocument();
    });

    it('resizes by keys, drag and double-click, within its bounds, and keeps the width', async () => {
      const first = render(<FilesTab wsId="ws1" worktreePath="/wt" />);
      await flush();
      const handle = screen.getByRole('separator', { name: 'Resize explorer' });
      expect(handle).toHaveAttribute('aria-valuenow', '256');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(handle).toHaveAttribute('aria-valuenow', '272');
      expect(explorer().style.width).toBe('272px');
      fireEvent.keyDown(handle, { key: 'Home' });
      expect(handle).toHaveAttribute('aria-valuenow', '176');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(handle).toHaveAttribute('aria-valuenow', '176'); // not below the minimum
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 220, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 220, pointerId: 1 });
      expect(handle).toHaveAttribute('aria-valuenow', '296');
      first.unmount();
      render(<FilesTab wsId="ws1" worktreePath="/wt" />);
      await flush();
      expect(screen.getByRole('separator', { name: 'Resize explorer' })).toHaveAttribute('aria-valuenow', '296');
      fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize explorer' }));
      expect(screen.getByRole('separator', { name: 'Resize explorer' })).toHaveAttribute('aria-valuenow', '256');
    });
  });
  });
});
