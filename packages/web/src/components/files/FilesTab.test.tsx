import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ tree: vi.fn(), read: vi.fn(), marks: vi.fn(), list: vi.fn() }));
vi.mock('../../api', () => ({ api: { files } }));
vi.mock('./FileViewer', () => ({
  FileViewer: (p: { path: string; line?: number; nonce?: number; reloadKey?: number; read: (x: string) => unknown; onAskAgent?: unknown; onOpenInVsCode?: unknown }) => (
    <div data-testid="viewer" data-path={p.path} data-line={p.line ?? ''} data-nonce={p.nonce ?? ''} data-reload={p.reloadKey ?? ''}
      data-ask={String(!!p.onAskAgent)} data-vscode={String(!!p.onOpenInVsCode)}>
      <button type="button" onClick={() => void p.read(p.path)}>read</button>
    </div>
  ),
}));

import { FilesTab } from './FilesTab';

const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
const page = (dir: string) => ({ dir, truncated: false, entries: dir === '' ? [{ name: 'a.ts', path: 'a.ts', kind: 'file', change: 'M' }, { name: 'b.ts', path: 'b.ts', kind: 'file' }] : [] });

beforeEach(() => {
  for (const f of Object.values(files)) f.mockReset();
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
});
