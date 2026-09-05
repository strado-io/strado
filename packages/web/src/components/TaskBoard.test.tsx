import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskBoard } from './TaskBoard';
import type { MergeRequest, RepoConfig, Worktree } from '../types';
import * as mrSummaries from '../hooks/mrSummaries';
import type { BoardPrefs } from '../hooks/boardPrefs';

const flat: BoardPrefs = { groupBy: 'none', sort: 'manual', tile: null, collapsed: [] };

vi.mock('../hooks/mrSummaries', () => ({
  useMrSummaries: vi.fn(() => new Map()),
}));

function wt(path: string, ticket = 'FD-1', order: number | null = null): Worktree {
  return {
    path, repoId: 'r', branch: 'b', head: 'h', prunable: false, tracked: true,
    meta: { repoId: 'r', ticketId: ticket, title: 'Ticket', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null, order },
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  } as Worktree;
}

const repoById = new Map<string, RepoConfig>([['r', { id: 'r', name: 'React' } as RepoConfig]]);
const handlers = {
  onStart: vi.fn(), onStop: vi.fn(), onKillExternal: vi.fn(), onOpenSettings: vi.fn(),
  onOpenShellTerminal: vi.fn(), onSetWorkflowStatus: vi.fn(),
  onOpenNote: vi.fn(), onOpenDiff: vi.fn(),
};

function baseProps() {
  return {
    wsId: 'ws1',
    worktrees: [wt('/x', 'FD-1'), wt('/y', 'FD-2')],
    repoById, gridTemplate: '1fr', totalWidth: 800, onStartResize: vi.fn(),
    density: 'comfy' as const,
    handlers,
  };
}

describe('TaskBoard', () => {
  it('renders every worktree as a flat row', () => {
    render(<TaskBoard {...baseProps()} />);
    expect(screen.getByTestId('task-row-/x')).toBeInTheDocument();
    expect(screen.getByTestId('task-row-/y')).toBeInTheDocument();
  });

  it('shows an empty hint when there are no worktrees', () => {
    render(<TaskBoard {...baseProps()} worktrees={[]} />);
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Filter tasks')).toBeNull();
    expect(screen.queryByLabelText('Group by')).toBeNull();
  });

  it('sinks settled rows below active ones', () => {
    const done = wt('/done', 'FD-9', 0);
    done.meta!.workflowStatus = 'done';
    const open = wt('/open', 'FD-8', 1);
    render(<TaskBoard {...baseProps()} worktrees={[done, open]} prefs={flat} />);
    const rows = screen.getAllByTestId(/task-row-/).map((el) => el.getAttribute('data-testid'));
    expect(rows).toEqual(['task-row-/open', 'task-row-/done']);
  });

  it('renders a grip on rows when onReorder is provided, none otherwise', () => {
    const { unmount } = render(<TaskBoard {...baseProps()} onReorder={vi.fn()} prefs={flat} />);
    expect(screen.getAllByLabelText('Drag to reorder').length).toBeGreaterThan(0);
    unmount();
    render(<TaskBoard {...baseProps()} prefs={flat} />);
    expect(screen.queryByLabelText('Drag to reorder')).not.toBeInTheDocument();
  });

  it('calls onReorder with the visible row order on a reorder drop', () => {
    const onReorder = vi.fn();
    render(<TaskBoard {...baseProps()} onReorder={onReorder} prefs={flat} />);
    fireEvent.drop(screen.getByTestId('task-row-/y'), {
      dataTransfer: { types: ['text/reorder-path'], getData: (k: string) => (k === 'text/reorder-path' ? '/x' : '') },
    });
    expect(onReorder).toHaveBeenCalled();
    const [rows, dragged, target, place] = onReorder.mock.calls[0]!;
    expect(rows.map((w: Worktree) => w.path)).toEqual(['/x', '/y']);
    expect(dragged).toBe('/x');
    expect(target).toBe('/y');
    expect(place).toBe('after');
  });

  it('ignores a reorder drop for an unknown dragged path', () => {
    const onReorder = vi.fn();
    render(<TaskBoard {...baseProps()} onReorder={onReorder} prefs={flat} />);
    fireEvent.drop(screen.getByTestId('task-row-/y'), {
      dataTransfer: { types: ['text/reorder-path'], getData: (k: string) => (k === 'text/reorder-path' ? '/outsider' : '') },
    });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('feeds hook summaries to the rows as MR chips', () => {
    const open: MergeRequest = {
      number: 5, title: 't', state: 'open', webUrl: 'https://x/5', pipeline: null,
      approvals: null, sourceBranch: 'b', updatedAt: '2026-07-25T00:00:00Z', provider: 'github',
    };
    vi.mocked(mrSummaries.useMrSummaries).mockReturnValue(new Map([['/x', open]]));
    render(<TaskBoard {...baseProps()} />);
    expect(screen.getByTestId('mr-chip')).toHaveTextContent('#5');
    expect(mrSummaries.useMrSummaries).toHaveBeenCalledWith('ws1', ['/x', '/y']);
  });

  it('groups by attention state by default, Needs you first, quiet when empty', () => {
    const waiting = wt('/w', 'FD-3');
    (waiting as any).claudeSessions = ['1'];
    (waiting as any).claudeStatusById = { '1': 'waiting' };
    render(<TaskBoard {...baseProps()} worktrees={[wt('/x', 'FD-1'), waiting]} />);
    const groups = screen.getAllByRole('button', { expanded: true });
    expect(groups.map((g) => g.textContent)).toEqual(['Needs you1', 'Idle1']);
    expect(screen.getByTestId('task-group-Needs you')).toContainElement(screen.getByTestId('task-row-/w'));

    // Quiet state: once the board is big enough to carry headers (two
    // populated groups), an empty needs-you group still says so. With a
    // single group the chips line ("Needs you 0") already answers it.
    const running = wt('/r', 'FD-2');
    (running as any).process = { ...running.process, status: 'running', port: 3000 };
    render(<TaskBoard {...baseProps()} worktrees={[wt('/x', 'FD-1'), running]} />);
    expect(screen.getAllByText('Nothing waiting on you').length).toBeGreaterThan(0);
  });

  it('the strip counts rows and a tile narrows the board to that state', () => {
    const waiting = wt('/w', 'FD-3');
    (waiting as any).claudeSessions = ['1'];
    (waiting as any).claudeStatusById = { '1': 'waiting' };
    const onPrefs = vi.fn();
    const { rerender } = render(<TaskBoard {...baseProps()} worktrees={[wt('/x'), waiting]} onPrefs={onPrefs} />);
    expect(screen.getByTestId('tile-needs-you')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId('tile-needs-you'));
    expect(onPrefs).toHaveBeenCalledWith({ tile: 'needs-you' });

    rerender(<TaskBoard {...baseProps()} worktrees={[wt('/x'), waiting]} onPrefs={onPrefs}
      prefs={{ groupBy: 'state', sort: 'activity', tile: 'needs-you', collapsed: [] }} />);
    expect(screen.getByTestId('task-row-/w')).toBeInTheDocument();
    expect(screen.queryByTestId('task-row-/x')).toBeNull();
    // clicking the active tile clears it
    fireEvent.click(screen.getByTestId('tile-needs-you'));
    expect(onPrefs).toHaveBeenLastCalledWith({ tile: null });
  });

  it('groups by repo with alphabetical headers', () => {
    const other = wt('/o', 'FD-7'); other.repoId = 'z';
    const repos = new Map(repoById); repos.set('z', { id: 'z', name: 'Zeta' } as RepoConfig);
    render(<TaskBoard {...baseProps()} repoById={repos} worktrees={[other, wt('/x')]}
      prefs={{ groupBy: 'repo', sort: 'activity', tile: null, collapsed: [] }} />);
    expect(screen.getAllByRole('button', { expanded: true }).map((g) => g.textContent)).toEqual(['React1', 'Zeta1']);
  });

  it('a collapsed group hides its rows and reports the toggle', () => {
    const onPrefs = vi.fn();
    // Two populated groups, so headers (and therefore collapsing) are in play.
    const waiting = wt('/w', 'FD-3');
    (waiting as any).claudeSessions = ['1'];
    (waiting as any).claudeStatusById = { '1': 'waiting' };
    render(<TaskBoard {...baseProps()} worktrees={[wt('/x', 'FD-1'), waiting]} onPrefs={onPrefs}
      prefs={{ groupBy: 'state', sort: 'activity', tile: null, collapsed: ['idle'] }} />);
    expect(screen.queryByTestId('task-row-/x')).toBeNull();
    expect(screen.getByTestId('task-row-/w')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Idle/ }));
    expect(onPrefs).toHaveBeenCalledWith({ collapsed: [] });
  });

  it('the text filter matches ticket, title and branch', () => {
    const y = wt('/y', 'FD-2'); y.branch = 'FD-2_payments';
    render(<TaskBoard {...baseProps()} worktrees={[wt('/x', 'FD-1'), y]} />);
    fireEvent.change(screen.getByLabelText('Filter tasks'), { target: { value: 'payments' } });
    expect(screen.getByTestId('task-row-/y')).toBeInTheDocument();
    expect(screen.queryByTestId('task-row-/x')).toBeNull();
  });

  it('manual order is offered only without grouping, and the grip follows it', () => {
    const onPrefs = vi.fn();
    render(<TaskBoard {...baseProps()} onReorder={vi.fn()} onPrefs={onPrefs} />);
    const manual = screen.getByRole('option', { name: 'Manual' }) as HTMLOptionElement;
    expect(manual.disabled).toBe(true);
    expect(screen.queryAllByLabelText('Drag to reorder')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'none' } });
    expect(onPrefs).toHaveBeenCalledWith({ groupBy: 'none' });
  });

  it('drops the group header when only one group would render', () => {
    // Grouped by state with every row idle: the needs-you group is empty and
    // the idle group is the only one with rows — a header naming the one
    // group on screen is just a band between the columns and the data.
    render(<TaskBoard {...baseProps()} worktrees={[wt('/x', 'FD-1')]} />);
    expect(screen.queryByRole('button', { expanded: true })).toBeNull();
    expect(screen.queryByText('Nothing waiting on you')).toBeNull();
    expect(screen.getByTestId('task-row-/x')).toBeInTheDocument();
  });

  it('keeps group headers as soon as two groups have rows', () => {
    const waiting = wt('/w', 'FD-3');
    (waiting as any).claudeSessions = ['1'];
    (waiting as any).claudeStatusById = { '1': 'waiting' };
    render(<TaskBoard {...baseProps()} worktrees={[wt('/x', 'FD-1'), waiting]} />);
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(2);
  });

  it('the summary chips and the controls share one line', () => {
    render(<TaskBoard {...baseProps()} />);
    const bar = screen.getByTestId('board-bar');
    expect(bar).toContainElement(screen.getByTestId('tile-needs-you'));
    expect(bar).toContainElement(screen.getByLabelText('Filter tasks'));
    expect(bar).toContainElement(screen.getByLabelText('Group by'));
  });

  it('activity sort puts the most recently opened worktree first', () => {
    localStorage.setItem('strado:worktree-lru', JSON.stringify({ '/y': 2, '/x': 1 }));
    render(<TaskBoard {...baseProps()} prefs={{ groupBy: 'none', sort: 'activity', tile: null, collapsed: [] }} />);
    const rows = screen.getAllByTestId(/task-row-/).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['task-row-/y', 'task-row-/x']);
    localStorage.clear();
  });

  it('a filter that matches nothing says so instead of the quiet needs-you text', () => {
    render(<TaskBoard {...baseProps()} />);
    fireEvent.change(screen.getByLabelText('Filter tasks'), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing waiting on you')).toBeNull();
    expect(screen.queryAllByTestId(/task-row-/)).toHaveLength(0);
  });

  it('a tile that matches nothing says so', () => {
    render(<TaskBoard {...baseProps()}
      prefs={{ groupBy: 'state', sort: 'activity', tile: 'review', collapsed: [] }} />);
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/task-row-/)).toHaveLength(0);
  });

  it('the text filter also matches the repo name', () => {
    const other = wt('/o', 'FD-7'); other.repoId = 'z';
    const repos = new Map(repoById); repos.set('z', { id: 'z', name: 'Zeta' } as RepoConfig);
    render(<TaskBoard {...baseProps()} repoById={repos} worktrees={[other, wt('/x', 'FD-1')]} />);
    fireEvent.change(screen.getByLabelText('Filter tasks'), { target: { value: 'zeta' } });
    expect(screen.getByTestId('task-row-/o')).toBeInTheDocument();
    expect(screen.queryByTestId('task-row-/x')).toBeNull();
  });

  it('a filter hides the quiet needs-you text and shows only matching groups', () => {
    render(<TaskBoard {...baseProps()} worktrees={[wt('/x', 'FD-1'), wt('/y', 'FD-2')]} />);
    fireEvent.change(screen.getByLabelText('Filter tasks'), { target: { value: 'FD-2' } });
    expect(screen.getByTestId('task-row-/y')).toBeInTheDocument();
    expect(screen.queryByTestId('task-row-/x')).toBeNull();
    expect(screen.queryByText('Nothing waiting on you')).toBeNull();
    expect(screen.queryByText('Nothing matches.')).toBeNull();
  });
});
