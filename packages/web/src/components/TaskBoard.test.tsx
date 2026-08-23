import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskBoard } from './TaskBoard';
import type { MergeRequest, RepoConfig, Worktree } from '../types';
import * as mrSummaries from '../hooks/mrSummaries';

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
  });

  it('sinks settled rows below active ones', () => {
    const done = wt('/done', 'FD-9', 0);
    done.meta!.workflowStatus = 'done';
    const open = wt('/open', 'FD-8', 1);
    render(<TaskBoard {...baseProps()} worktrees={[done, open]} />);
    const rows = screen.getAllByTestId(/task-row-/).map((el) => el.getAttribute('data-testid'));
    expect(rows).toEqual(['task-row-/open', 'task-row-/done']);
  });

  it('renders a grip on rows when onReorder is provided, none otherwise', () => {
    const { unmount } = render(<TaskBoard {...baseProps()} onReorder={vi.fn()} />);
    expect(screen.getAllByLabelText('Drag to reorder').length).toBeGreaterThan(0);
    unmount();
    render(<TaskBoard {...baseProps()} />);
    expect(screen.queryByLabelText('Drag to reorder')).not.toBeInTheDocument();
  });

  it('calls onReorder with the visible row order on a reorder drop', () => {
    const onReorder = vi.fn();
    render(<TaskBoard {...baseProps()} onReorder={onReorder} />);
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
    render(<TaskBoard {...baseProps()} onReorder={onReorder} />);
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
});
