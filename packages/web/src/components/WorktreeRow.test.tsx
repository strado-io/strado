import { render, screen, fireEvent, createEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeRow, formatActiveTime } from './WorktreeRow';
import { publishTickets } from '../hooks/tickets';
import type { Worktree, MergeRequest } from '../types';

const worktree = {
  path: '/Users/me/repo.worktrees/FD-1',
  repoId: 'r', branch: 'FD-1', head: 'abc', prunable: false, tracked: true,
  meta: { ticketId: 'FD-1', title: 'Ticket', repoId: 'r', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  nodeModules: { status: 'missing' },
} as unknown as Worktree;

function noopProps() {
  return {
    worktree,
    gridTemplate: '1fr',
    onOpenShellTerminal: vi.fn(),
    onSetWorkflowStatus: vi.fn(),
    onOpenNote: vi.fn(),
    onOpenDiff: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onKillExternal: vi.fn(),
    onOpenSettings: vi.fn(),
  };
}

describe('WorktreeRow', () => {
  it('calls onOpenDiff when the diff affordance is clicked (clean tree)', () => {
    const props = noopProps();
    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /diff & commit/i }));
    expect(props.onOpenDiff).toHaveBeenCalledWith(worktree);
  });

  it('the changes count opens the diff modal', () => {
    const props = noopProps();
    props.worktree = { ...worktree, diffStats: { files: 3, additions: 12, deletions: 4 } } as any;
    render(<WorktreeRow {...props} />);
    const btn = screen.getByRole('button', { name: /open diff & commit/i });
    expect(btn).toHaveTextContent('+12');
    fireEvent.click(btn);
    expect(props.onOpenDiff).toHaveBeenCalledWith(props.worktree);
    expect(props.onOpenShellTerminal).not.toHaveBeenCalled();
  });

  it('start/stop control rides next to the run dot', () => {
    const props = noopProps();
    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(props.onStart).toHaveBeenCalledWith(worktree);
    expect(props.onOpenShellTerminal).not.toHaveBeenCalled();
  });

  it('shows stop while running and kill for external processes', () => {
    const props = noopProps();
    props.worktree = { ...worktree, process: { ...worktree.process, status: 'running' } } as any;
    const { unmount } = render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(props.onStop).toHaveBeenCalledWith(props.worktree);
    unmount();

    const ext = noopProps();
    ext.worktree = { ...worktree, process: { ...worktree.process, status: 'running', external: true, pid: 42 } } as any;
    render(<WorktreeRow {...ext} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kill external process' }));
    expect(ext.onKillExternal).toHaveBeenCalledWith(ext.worktree);
  });

  it('clicking the row opens the shell terminal (no dedicated terminal button)', () => {
    const props = noopProps();
    render(<WorktreeRow {...props} />);
    expect(screen.queryByRole('button', { name: /open terminal/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('unlinked')); // plain row area
    expect(props.onOpenShellTerminal).toHaveBeenCalledWith(worktree);
  });

  it('shows the unlinked warning when node_modules are missing', () => {
    render(<WorktreeRow {...noopProps()} />);
    expect(screen.getByTitle(/node_modules missing/i)).toHaveTextContent('unlinked');
  });

  it('hides the unlinked warning when deps are linked', () => {
    const props = noopProps();
    props.worktree = { ...worktree, nodeModules: { status: 'symlink', source: '/src/node_modules' } } as any;
    render(<WorktreeRow {...props} />);
    expect(screen.queryByText('unlinked')).not.toBeInTheDocument();
  });

  it('clicks on interactive children do not trigger the row click', () => {
    const props = noopProps();
    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /diff & commit/i }));
    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(props.onOpenShellTerminal).not.toHaveBeenCalled();
  });

  it('reflects the current workflow status', () => {
    const props = noopProps();
    props.worktree = { ...worktree, meta: { ...worktree.meta, workflowStatus: 'verified' } } as any;
    render(<WorktreeRow {...props} />);
    expect((screen.getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('verified');
  });

  it('calls onSetWorkflowStatus when the status select changes', () => {
    const props = noopProps();
    render(<WorktreeRow {...props} />);
    fireEvent.change(screen.getByLabelText('Workflow status'), { target: { value: 'done' } });
    expect(props.onSetWorkflowStatus).toHaveBeenCalledWith(props.worktree, 'done');
  });

  it('shows the add-note affordance and calls onOpenNote when clicked', () => {
    const props = noopProps();
    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(props.onOpenNote).toHaveBeenCalledWith(props.worktree);
  });

  it('shows the edit-note affordance when a note exists', () => {
    const props = noopProps();
    props.worktree = { ...worktree, meta: { ...worktree.meta, note: 'do X' } } as any;
    render(<WorktreeRow {...props} />);
    expect(screen.getByRole('button', { name: /edit note/i })).toBeInTheDocument();
  });

  it('renders no drag grip by default', () => {
    render(<WorktreeRow {...noopProps()} />);
    expect(screen.queryByLabelText('Drag to reorder')).not.toBeInTheDocument();
  });

  it('renders a draggable grip when reorderable and sets the reorder path on dragstart', () => {
    const props = noopProps();
    render(<WorktreeRow {...props} reorderable />);
    const grip = screen.getByLabelText('Drag to reorder');
    expect(grip).toBeInTheDocument();
    const setData = vi.fn();
    fireEvent.dragStart(grip, { dataTransfer: { setData, setDragImage: vi.fn() } });
    expect(setData).toHaveBeenCalledWith('text/reorder-path', props.worktree.path);
  });

  it('grip dragstart stops propagation and sets the reorder path', () => {
    const props = noopProps();
    render(<WorktreeRow {...props} reorderable />);
    const grip = screen.getByLabelText('Drag to reorder');
    const setData = vi.fn();
    const evt = createEvent.dragStart(grip, { dataTransfer: { setData, setDragImage: vi.fn() } as any });
    evt.stopPropagation = vi.fn();
    fireEvent(grip, evt);
    expect(evt.stopPropagation).toHaveBeenCalled();
    expect(setData).toHaveBeenCalledWith('text/reorder-path', props.worktree.path);
  });

  it('shows a Jira dot with a hover card and links the ticket to the configured base url', () => {
    publishTickets({
      jiraBaseUrl: 'https://org.atlassian.net',
      issues: {
        'jira:FD-1': {
          key: 'FD-1', summary: 'Ticket', status: 'In Progress', category: 'indeterminate',
          assignee: 'Kamlesh', priority: 'High', estimate: '2d', timeSpent: '1d', remaining: '4h', timeSpentSeconds: 28800, remainingSeconds: 14400,
          provider: 'jira', url: 'https://org.atlassian.net/browse/FD-1',
        },
      },
    });
    render(<WorktreeRow {...noopProps()} />);
    const link = screen.getByRole('link', { name: 'FD-1' });
    expect(link).toHaveAttribute('href', 'https://org.atlassian.net/browse/FD-1');
    // badge is a neutral identifier — status color lives in the STATUS chip
    expect(link.className).toContain('bg-zinc-800');
    // original estimate rides in the time cell
    expect(screen.getByTitle('Original estimate')).toHaveTextContent('2d');

    fireEvent.mouseEnter(screen.getByLabelText('Jira: In Progress'));
    const card = screen.getByRole('tooltip');
    expect(card).toHaveTextContent('Ticket');
    expect(card).toHaveTextContent('Kamlesh');
    expect(card).toHaveTextContent('High');
    expect(card).toHaveTextContent('1d logged');
    expect(card).toHaveTextContent('4h remaining');
    expect(card).toHaveTextContent('original estimate');
    expect(card).toHaveTextContent('2d');
    fireEvent.mouseLeave(screen.getByLabelText('Jira: In Progress'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows tracked active time in the Time spent cell', () => {
    const props = noopProps();
    props.worktree = { ...worktree, activitySeconds: 3900 } as any;
    render(<WorktreeRow {...props} />);
    expect(screen.getByTitle(/active time in this worktree/i)).toHaveTextContent('1h 5m');
  });

  it('formatActiveTime hides sub-minute noise and never rolls hours into days', () => {
    expect(formatActiveTime(undefined)).toBeNull();
    expect(formatActiveTime(0)).toBeNull();
    expect(formatActiveTime(59)).toBeNull();
    expect(formatActiveTime(60)).toBe('1m');
    expect(formatActiveTime(45 * 60)).toBe('45m');
    expect(formatActiveTime(2 * 3600)).toBe('2h');
    expect(formatActiveTime(26 * 3600 + 600)).toBe('26h 10m');
  });

  it('renders a plain badge (no link) for tickets confirmed missing in Jira', () => {
    publishTickets({ missing: ['jira:FD-1'] });
    render(<WorktreeRow {...noopProps()} />);
    expect(screen.queryByRole('link', { name: 'FD-1' })).not.toBeInTheDocument();
    expect(screen.getByTitle('Not tracked in Jira')).toHaveTextContent('FD-1');
  });
});

function mrFixture(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    number: 42, title: 'Add thing', state: 'open', webUrl: 'https://github.com/o/r/pull/42',
    pipeline: null, approvals: null, sourceBranch: 'b', updatedAt: '2026-07-25T00:00:00Z',
    provider: 'github', ...over,
  };
}

describe('MR chip', () => {
  it('renders nothing without the mr prop', () => {
    render(<WorktreeRow {...noopProps()} />);
    expect(screen.queryByTestId('mr-chip')).not.toBeInTheDocument();
  });

  it('renders #N linking to the PR for github', () => {
    render(<WorktreeRow {...noopProps()} mr={mrFixture()} />);
    const chip = screen.getByTestId('mr-chip');
    expect(chip).toHaveTextContent('#42');
    expect(chip).toHaveAttribute('href', 'https://github.com/o/r/pull/42');
    expect(chip).toHaveAttribute('target', '_blank');
  });

  it('renders !N for gitlab', () => {
    render(<WorktreeRow {...noopProps()} mr={mrFixture({ provider: 'gitlab', number: 7 })} />);
    expect(screen.getByTestId('mr-chip')).toHaveTextContent('!7');
  });

  it('shows a CI glyph when a pipeline exists', () => {
    render(<WorktreeRow {...noopProps()} mr={mrFixture({ pipeline: 'failed' })} />);
    expect(screen.getByTestId('mr-chip')).toHaveTextContent('✗');
  });

  it('describes state and CI in the tooltip', () => {
    render(<WorktreeRow {...noopProps()} mr={mrFixture({ state: 'merged', pipeline: 'success' })} />);
    expect(screen.getByTestId('mr-chip')).toHaveAttribute('title', 'Add thing — merged, CI success');
  });

  it('opens the in-app review instead of navigating when onOpenMr is provided', () => {
    const onOpenMr = vi.fn();
    const props = noopProps();
    const mr = mrFixture();
    render(<WorktreeRow {...props} mr={mr} onOpenMr={onOpenMr} />);
    const click = fireEvent.click(screen.getByTestId('mr-chip'));
    expect(onOpenMr).toHaveBeenCalledWith(props.worktree, mr);
    expect(click).toBe(false); // preventDefault fired — no navigation
  });
});
