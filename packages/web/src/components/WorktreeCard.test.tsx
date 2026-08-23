import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorktreeCard } from './WorktreeCard';
import type { Worktree } from '../types';

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: '/x',
    repoId: 'r',
    branch: 'feature-x',
    head: 'abc',
    prunable: false,
    tracked: true,
    meta: {
      repoId: 'r',
      ticketId: 'FD-1',
      title: 'Thing',
      linkedFrom: '/main',
      linkedAt: null,
      port: 8080,
      env: {},
      lastStartedAt: null,
    },
    process: {
      status: 'idle',
      pid: null,
      startedAt: null,
      port: null,
      detectedUrl: null,
      exitCode: null,
    },
    ...overrides,
  };
}

describe('WorktreeCard', () => {
  it('shows ticket id, title, and branch', () => {
    render(<WorktreeCard worktree={makeWorktree()} onStart={() => {}} onStop={() => {}} onOpenEditor={() => {}} onMenu={() => {}} onShowLogs={() => {}} />);
    expect(screen.getByText('FD-1')).toBeInTheDocument();
    expect(screen.getByText('Thing')).toBeInTheDocument();
    expect(screen.getByText('feature-x')).toBeInTheDocument();
  });

  it('shows Stop button when running', () => {
    render(
      <WorktreeCard
        worktree={makeWorktree({ process: { status: 'running', pid: 1, startedAt: 's', port: 8080, detectedUrl: 'http://localhost:8080', exitCode: null } })}
        onStart={() => {}}
        onStop={() => {}}
        onOpenEditor={() => {}}
        onMenu={() => {}}
        onShowLogs={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('fires onStart when start clicked', () => {
    const onStart = vi.fn();
    render(<WorktreeCard worktree={makeWorktree()} onStart={onStart} onStop={() => {}} onOpenEditor={() => {}} onMenu={() => {}} onShowLogs={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(onStart).toHaveBeenCalled();
  });

  it('renders "untracked" badge when tracked=false', () => {
    render(
      <WorktreeCard
        worktree={makeWorktree({ tracked: false, meta: null })}
        onStart={() => {}}
        onStop={() => {}}
        onOpenEditor={() => {}}
        onMenu={() => {}}
        onShowLogs={() => {}}
      />,
    );
    expect(screen.getByText(/untracked/i)).toBeInTheDocument();
  });
});
