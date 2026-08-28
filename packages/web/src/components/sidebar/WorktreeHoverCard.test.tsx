import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeHoverCard, sortSessions, useHoverCard } from './WorktreeHoverCard';
import type { SessionChip } from '../../hooks/sessions';
import type { MergeRequest, Worktree } from '../../types';

const anchor = { top: 80, bottom: 96, left: 260, right: 276 } as DOMRect;

const worktree = (over: Partial<Worktree> = {}): Worktree =>
  ({
    path: '/r1/FD-1',
    repoId: 'r1',
    branch: 'FD-1_add_hover_card',
    meta: { ticketId: 'FD-1', title: 'add-hover-card', workflowStatus: 'in_progress' },
    diffStats: { additions: 12, deletions: 3, files: 2 },
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false },
    ...over,
  } as Worktree);

const chip = (over: Partial<SessionChip> & Pick<SessionChip, 'mode' | 'sessionId'>): SessionChip => ({
  path: '/r1/FD-1',
  modeLabel: over.mode,
  label: 'FD-1',
  title: null,
  ...over,
} as SessionChip);

const mr: MergeRequest = {
  number: 42,
  title: 'Ship the hover card',
  state: 'open',
  webUrl: 'https://example.test/pull/42',
  pipeline: 'success',
  approvals: null,
  sourceBranch: 'FD-1_add_hover_card',
  targetBranch: 'main',
  updatedAt: '2026-08-27T00:00:00Z',
  provider: 'github',
};

const props = () => ({
  worktree: worktree(),
  chips: [] as SessionChip[],
  mr: null as MergeRequest | null,
  anchor,
  onOpenSession: vi.fn(),
  onOpenMr: vi.fn(),
  onOpenDiff: vi.fn(),
  onOpenShell: vi.fn(),
  onOpenSettings: vi.fn(),
  onClose: vi.fn(),
});

describe('sortSessions', () => {
  it('floats working sessions over waiting ones, and both over idle', () => {
    const sorted = sortSessions([
      chip({ mode: 'shell', sessionId: '1' }),
      chip({ mode: 'claude', sessionId: '1', claudeStatus: 'idle' }),
      chip({ mode: 'codex', sessionId: '1', codexStatus: 'waiting' }),
      chip({ mode: 'claude', sessionId: '2', claudeStatus: 'working' }),
    ]);
    expect(sorted.map((c) => `${c.mode}:${c.sessionId}`)).toEqual([
      'claude:2', 'codex:1', 'claude:1', 'shell:1',
    ]);
  });

  it('keeps the original order among sessions of equal urgency', () => {
    const sorted = sortSessions([
      chip({ mode: 'shell', sessionId: '2' }),
      chip({ mode: 'vscode', sessionId: '1' }),
      chip({ mode: 'shell', sessionId: '1' }),
    ]);
    expect(sorted.map((c) => `${c.mode}:${c.sessionId}`)).toEqual(['shell:2', 'vscode:1', 'shell:1']);
  });
});

describe('WorktreeHoverCard', () => {
  it('opens the exact session that was clicked', () => {
    const p = props();
    render(
      <WorktreeHoverCard
        {...p}
        chips={[chip({ mode: 'claude', sessionId: '1' }), chip({ mode: 'shell', sessionId: '2' })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Shell 2/ }));
    expect(p.onOpenSession).toHaveBeenCalledWith('shell', '2');
    expect(p.onOpenSession).toHaveBeenCalledTimes(1);
  });

  it('marks a working session so the running one is obvious at a glance', () => {
    render(
      <WorktreeHoverCard
        {...props()}
        chips={[chip({ mode: 'claude', sessionId: '1', claudeStatus: 'working' })]}
      />,
    );
    const row = screen.getByRole('button', { name: /Claude/ });
    expect(row).toHaveTextContent('working');
    expect(within(row).getByTestId('session-live-dot')).toBeInTheDocument();
  });

  it('says so when a worktree has no sessions yet', () => {
    render(<WorktreeHoverCard {...props()} />);
    expect(screen.getByText('No open sessions')).toBeInTheDocument();
  });

  it('shows the PR number, state, checks, title and branches, and opens the review', () => {
    const p = props();
    render(<WorktreeHoverCard {...p} mr={mr} />);
    const pr = screen.getByRole('button', { name: /Open PR 42/ });
    expect(pr).toHaveTextContent('#42');
    expect(pr).toHaveTextContent('Open');
    expect(pr).toHaveTextContent('Checks passed');
    expect(pr).toHaveTextContent('Ship the hover card');
    expect(pr).toHaveTextContent('FD-1_add_hover_card → main');
    fireEvent.click(pr);
    expect(p.onOpenMr).toHaveBeenCalledTimes(1);
  });

  it('drops the PR block for a worktree without one', () => {
    render(<WorktreeHoverCard {...props()} />);
    expect(screen.queryByRole('button', { name: /Open PR/ })).not.toBeInTheDocument();
  });

  it('heads the card with the ticket, title, status and branch', () => {
    render(<WorktreeHoverCard {...props()} />);
    const card = screen.getByRole('dialog');
    expect(card).toHaveTextContent('FD-1');
    expect(card).toHaveTextContent('add hover card');
    expect(card).toHaveTextContent('IN PROGRESS');
    expect(card).toHaveTextContent('FD-1_add_hover_card');
  });

  it('reports uncommitted work and a running dev server with its port', () => {
    render(
      <WorktreeHoverCard
        {...props()}
        worktree={worktree({
          process: { status: 'running', pid: 42, startedAt: null, port: 3001, detectedUrl: 'http://localhost:3001', exitCode: null, external: false },
        })}
      />,
    );
    const footer = screen.getByTestId('hover-card-footer');
    expect(footer).toHaveTextContent('2 files');
    expect(footer).toHaveTextContent('+12');
    expect(footer).toHaveTextContent('-3');
    expect(footer).toHaveTextContent('running :3001');
  });

  it('keeps the footer honest on a clean, stopped worktree', () => {
    render(
      <WorktreeHoverCard {...props()} worktree={worktree({ diffStats: null })} />,
    );
    const footer = screen.getByTestId('hover-card-footer');
    expect(footer).toHaveTextContent('No uncommitted changes');
    expect(footer).not.toHaveTextContent('running');
  });

  it('offers changes, a new shell and settings as quick actions', () => {
    const p = props();
    render(<WorktreeHoverCard {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'New shell' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(p.onOpenDiff).toHaveBeenCalledTimes(1);
    expect(p.onOpenShell).toHaveBeenCalledTimes(1);
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('drops quick actions the caller has no handler for', () => {
    const p = props();
    render(
      <WorktreeHoverCard {...p} onOpenDiff={undefined} onOpenSettings={undefined} />,
    );
    // A worktree on a runner has no local diff or settings — a dead button
    // reads as a broken one.
    expect(screen.queryByRole('button', { name: 'Changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New shell' })).toBeInTheDocument();
  });

  it('names the machine for a session that lives on a runner', () => {
    render(<WorktreeHoverCard {...props()} runnerName="runner-dev" />);
    expect(screen.getByRole('dialog')).toHaveTextContent('on runner-dev');
  });

  it('sits beside the sidebar, and flips to its left when the viewport is too narrow', () => {
    const { rerender } = render(<WorktreeHoverCard {...props()} sidebarRight={300} />);
    expect(screen.getByRole('dialog')).toHaveStyle({ left: '308px' });

    window.innerWidth = 420;
    rerender(<WorktreeHoverCard {...props()} sidebarRight={300} sidebarLeft={0} />);
    expect(screen.getByRole('dialog')).toHaveStyle({ left: '8px' });
  });

  it('closes on Escape', () => {
    const p = props();
    render(<WorktreeHoverCard {...p} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('useHoverCard', () => {
  function Harness({ openDelay = 250, closeDelay = 120 }: { openDelay?: number; closeDelay?: number }) {
    const hover = useHoverCard({ openDelay, closeDelay });
    return (
      <>
        <div data-testid="row" {...hover.triggerProps}>row</div>
        {hover.open && <div data-testid="card" {...hover.cardProps}>card</div>}
      </>
    );
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits out the open delay before showing the card', () => {
    render(<Harness />);
    fireEvent.pointerEnter(screen.getByTestId('row'));
    act(() => { vi.advanceTimersByTime(249); });
    expect(screen.queryByTestId('card')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('card')).toBeInTheDocument();
  });

  it('never opens for a cursor that only passes over the row', () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    fireEvent.pointerEnter(row);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.pointerLeave(row);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByTestId('card')).not.toBeInTheDocument();
  });

  it('stays open while the cursor travels from the row into the card', () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    fireEvent.pointerEnter(row);
    act(() => { vi.advanceTimersByTime(250); });
    fireEvent.pointerLeave(row);
    act(() => { vi.advanceTimersByTime(60); });
    fireEvent.pointerEnter(screen.getByTestId('card'));
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByTestId('card')).toBeInTheDocument();
  });

  it('opens at once for a keyboard user focusing the row', () => {
    render(<Harness />);
    fireEvent.focus(screen.getByTestId('row'));
    expect(screen.getByTestId('card')).toBeInTheDocument();
  });

  it('stays open while focus moves into the card, and closes when it leaves', () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    fireEvent.focus(row);
    const card = screen.getByTestId('card');
    fireEvent.blur(row);
    fireEvent.focus(card);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId('card')).toBeInTheDocument();

    fireEvent.blur(card);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId('card')).not.toBeInTheDocument();
  });

  it('closes once the cursor leaves the card too', () => {
    render(<Harness />);
    const row = screen.getByTestId('row');
    fireEvent.pointerEnter(row);
    act(() => { vi.advanceTimersByTime(250); });
    fireEvent.pointerLeave(row);
    fireEvent.pointerEnter(screen.getByTestId('card'));
    fireEvent.pointerLeave(screen.getByTestId('card'));
    act(() => { vi.advanceTimersByTime(120); });
    expect(screen.queryByTestId('card')).not.toBeInTheDocument();
  });
});
