import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingChecklist } from './OnboardingChecklist';
import type { RepoConfig, Worktree } from '../types';

const repo = { id: 'r', name: 'R' } as RepoConfig;

function wt(over: Partial<Worktree> = {}): Worktree {
  return {
    path: '/wt/a', repoId: 'r', branch: 'b', head: 'h', prunable: false, tracked: true,
    meta: { ticketId: 'FD-1', title: 'T', repoId: 'r', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
    ...over,
  } as Worktree;
}

function props(over: Partial<Parameters<typeof OnboardingChecklist>[0]> = {}) {
  return {
    repos: [repo],
    worktrees: [] as Worktree[],
    jiraOn: false,
    onNewWorktree: vi.fn(),
    onOpenJiraSettings: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
}

beforeEach(() => localStorage.clear());

describe('OnboardingChecklist', () => {
  it('checks off steps from real state, not clicks', () => {
    render(<OnboardingChecklist {...props()} />);
    // repo done (1 repo), worktree/session/jira pending → 1/4
    expect(screen.getByText(/1\/4/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a worktree' })).toBeInTheDocument();
  });

  it('pending steps with actions trigger the right handlers', () => {
    const p = props();
    render(<OnboardingChecklist {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a worktree' }));
    expect(p.onNewWorktree).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jira' }));
    expect(p.onOpenJiraSettings).toHaveBeenCalled();
  });

  it('a live session (or tracked time) completes the session step and persists', () => {
    const { unmount } = render(
      <OnboardingChecklist {...props({ worktrees: [wt({ hasShellSession: true })] })} />,
    );
    expect(screen.getByText(/3\/4/)).toBeInTheDocument();
    unmount();
    // session died — the step stays checked via the persisted flag
    render(<OnboardingChecklist {...props({ worktrees: [wt()] })} />);
    expect(screen.getByText(/3\/4/)).toBeInTheDocument();
  });

  it('renders nothing when everything including Jira is done', () => {
    const { container } = render(
      <OnboardingChecklist {...props({ jiraOn: true, worktrees: [wt({ activitySeconds: 60 })] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('dismiss calls the handler', () => {
    const p = props();
    render(<OnboardingChecklist {...p} />);
    fireEvent.click(screen.getByLabelText('Dismiss setup checklist'));
    expect(p.onDismiss).toHaveBeenCalled();
  });
});
