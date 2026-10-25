import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ tree: vi.fn(), read: vi.fn(), marks: vi.fn(), list: vi.fn(), search: vi.fn() }));
const lsp = vi.hoisted(() => ({ definition: vi.fn(), references: vi.fn(), hover: vi.fn(), outline: vi.fn() }));
vi.mock('../../api', () => ({ api: { files, lsp } }));
vi.mock('./FileViewer', () => ({
  FileViewer: (p: { path: string; line?: number; col?: number; nonce?: number; reloadKey?: number; read: (x: string) => unknown; onAskAgent?: unknown; onOpenInVsCode?: unknown;
    onNavigate?: (k: 'definition' | 'references', at: { path: string; line: number; col: number }) => void; headerStart?: React.ReactNode }) => (
    <div data-testid="viewer" data-path={p.path} data-line={p.line ?? ''} data-col={p.col ?? ''} data-nonce={p.nonce ?? ''} data-reload={p.reloadKey ?? ''}
      data-ask={String(!!p.onAskAgent)} data-vscode={String(!!p.onOpenInVsCode)}>
      <button type="button" onClick={() => void p.read(p.path)}>read</button>
      <button type="button" onClick={() => p.onNavigate?.('definition', { path: p.path, line: 2, col: 4 })}>F12</button>
      <button type="button" onClick={() => p.onNavigate?.('references', { path: p.path, line: 2, col: 4 })}>Shift-F12</button>
      {p.headerStart}
    </div>
  ),
}));

import { FilesTab } from './FilesTab';

const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
const page = (dir: string) => ({ dir, truncated: false, entries: dir === '' ? [{ name: 'a.ts', path: 'a.ts', kind: 'file', change: 'M' }, { name: 'b.ts', path: 'b.ts', kind: 'file' }] : [] });

beforeEach(() => {
  for (const f of [...Object.values(files), ...Object.values(lsp)]) f.mockReset();
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

  it('"Show ignored" reloads with ignored files; "Changed only" filters without asking again', async () => {
    render(<FilesTab wsId="ws1" worktreePath="/wt" />);
    await flush();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Changed only' }));
    expect(document.querySelector('[data-path="b.ts"]')).toBeNull();
    expect(files.tree).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show ignored' }));
    await flush();
    expect(files.tree).toHaveBeenLastCalledWith('ws1', '/wt', '', { ignored: true }, undefined);
  });

  it('openPath opens that file at its line, and a new nonce opens it again', async () => {
    const { rerender } = render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', line: 7, nonce: 1 }} />);
    await flush();
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-path', 'a.ts');
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-line', '7');
    rerender(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', line: 7, nonce: 2 }} />);
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-nonce', '2');
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

  it('passes Ask agent and Open in VS Code through', async () => {
    render(<FilesTab wsId="ws1" worktreePath="/wt" openPath={{ path: 'a.ts', nonce: 1 }} onAskAgent={vi.fn()} onOpenInVsCode={vi.fn()} />);
    await flush();
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-ask', 'true');
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-vscode', 'true');
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
      fireEvent.click(screen.getByRole('button', { name: /deep\/c\.ts:12/ }));
      expect(where()).toEqual(['deep/c.ts', '12', '3']);
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(where()[0]).toBe('a.ts');
      fireEvent.keyDown(screen.getByTestId('search-panel'), { key: 'Escape' });
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });
  });
});
