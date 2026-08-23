import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionList } from './SessionList';
import type { Worktree } from '../types';

function wt(path: string, opts: Partial<Worktree> = {}): Worktree {
  return { path, meta: { ticketId: path.split('/').pop() } as any, ...opts } as unknown as Worktree;
}

describe('SessionList', () => {
  it('renders a chip per session and calls onOpen with path + mode', () => {
    const onOpen = vi.fn();
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/wt/FD-1', { hasClaudeSession: true }), wt('/wt/FD-2', { hasShellSession: true })]}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /FD-1.*claude/i }));
    expect(onOpen).toHaveBeenCalledWith('/wt/FD-1', 'claude', '1');
    fireEvent.click(screen.getByRole('button', { name: /FD-2.*shell/i }));
    expect(onOpen).toHaveBeenCalledWith('/wt/FD-2', 'shell', '1');
  });

  it('shows empty text when there are no sessions', () => {
    render(<SessionList wsId="w1" worktrees={[wt('/wt/x')]} onOpen={() => {}} emptyText="No sessions" />);
    expect(screen.getByText('No sessions')).toBeInTheDocument();
  });

  it('collapses a worktree group behind its header and always shows the session count', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/wt/FD-1', { hasClaudeSession: true, hasShellSession: true })]}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /FD-1 claude/i })).toBeInTheDocument();

    const header = screen.getByRole('button', { name: 'FD-1 sessions' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    // Count badge now lives beside the header (not inside its accessible
    // name) and stays visible whether the group is expanded or collapsed.
    expect(screen.getByText('2')).toBeInTheDocument();
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /FD-1 claude/i })).not.toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // still visible collapsed

    fireEvent.click(header);
    expect(screen.getByRole('button', { name: /FD-1 claude/i })).toBeInTheDocument();
  });

  it('badges a remote worktree group with its machine label and leaves local unbadged', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[
          wt('/w/FD-1', { hasClaudeSession: true }),
          wt('/w/FD-9', { hasClaudeSession: true }),
        ]}
        onOpen={() => {}}
        machineLabel={(p) => (p === '/w/FD-9' ? 'runner-dev' : null)}
      />,
    );
    expect(screen.getByText('runner-dev')).toBeInTheDocument();
    // local group carries no badge
    const local = screen.getByRole('button', { name: 'FD-1 sessions' });
    expect(local).not.toHaveTextContent('runner-dev');
  });

  it('renders a distinct opencode icon for an opencode session, not the generic shell icon', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/wt/FD-3', { hasOpencodeSession: true })]}
        onOpen={() => {}}
      />,
    );
    const chip = screen.getByRole('button', { name: /FD-3.*opencode/i });
    expect(chip).toBeInTheDocument();
    // OpencodeIcon uses a 240x300 viewBox; ShellIcon (the fallthrough this
    // guards against) uses 16x16 — presence/absence distinguishes them.
    expect(chip.querySelector('svg[viewBox="0 0 240 300"]')).toBeInTheDocument();
    expect(chip.querySelector('svg[viewBox="0 0 16 16"]')).not.toBeInTheDocument();
  });

  it('shows a session count badge per group and filters by query', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/w/FD-1', { hasClaudeSession: true, hasShellSession: true }), wt('/w/FD-9', { hasClaudeSession: true })]}
        onOpen={() => {}}
        filter="fd-9"
      />,
    );
    // FD-9 group present, FD-1 filtered out
    expect(screen.getByText('FD-9')).toBeInTheDocument();
    expect(screen.queryByText('FD-1')).toBeNull();
  });

  it('shows "No matching sessions" when the filter matches nothing', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/w/FD-1', { hasClaudeSession: true })]}
        onOpen={() => {}}
        filter="zzz-no-match"
        emptyText="No sessions"
      />,
    );
    expect(screen.getByText('No matching sessions')).toBeInTheDocument();
  });

  it('renders a process dot for a LOCAL running worktree, not a remote one', () => {
    const local = { ...wt('/w/FD-1', { hasClaudeSession: true }), process: { status: 'running', pid: 1, startedAt: null, port: 5173, detectedUrl: null, exitCode: null } };
    const remote = { ...wt('/w/FD-2', { hasClaudeSession: true }), remote: { runnerId: 'r', runnerName: 'runner-dev', wsBase: 'x', wsId: 'y' }, process: { status: 'running', pid: 1, startedAt: null, port: 5173, detectedUrl: null, exitCode: null } };
    render(<SessionList wsId="w1" worktrees={[local as never, remote as never]} onOpen={() => {}} machineLabel={(p) => (p === '/w/FD-2' ? 'runner-dev' : null)} />);
    expect(screen.getByTestId('proc-dot-/w/FD-1')).toBeInTheDocument();
    expect(screen.queryByTestId('proc-dot-/w/FD-2')).toBeNull();
  });

  it('keeps the process dot visible for a LOCAL stopped worktree so Start stays reachable', () => {
    const stopped = { ...wt('/w/FD-1', { hasClaudeSession: true }), process: { status: 'stopped', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: 0 } };
    render(<SessionList wsId="w1" worktrees={[stopped as never]} onOpen={() => {}} />);
    expect(screen.getByTestId('proc-dot-/w/FD-1')).toBeInTheDocument();
  });

  it('hides the process dot for a LOCAL idle worktree (never started)', () => {
    const idle = { ...wt('/w/FD-1', { hasClaudeSession: true }), process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null } };
    render(<SessionList wsId="w1" worktrees={[idle as never]} onOpen={() => {}} />);
    expect(screen.queryByTestId('proc-dot-/w/FD-1')).toBeNull();
  });

  it('hides the process dot for a REMOTE worktree even when its process is running', () => {
    const remoteRunning = {
      ...wt('/w/FD-2', { hasClaudeSession: true }),
      remote: { runnerId: 'r', runnerName: 'runner-dev', wsBase: 'x', wsId: 'y' },
      process: { status: 'running', pid: 1, startedAt: null, port: 5173, detectedUrl: null, exitCode: null },
    };
    render(<SessionList wsId="w1" worktrees={[remoteRunning as never]} onOpen={() => {}} machineLabel={() => 'runner-dev'} />);
    expect(screen.queryByTestId('proc-dot-/w/FD-2')).toBeNull();
  });

  it('groups worktrees of the same repo under a collapsible repo header (total count)', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[
          wt('/wt/FD-1', { repoId: 'r-app', hasClaudeSession: true }),
          wt('/wt/FD-2', { repoId: 'r-app', hasShellSession: true }),
        ]}
        onOpen={() => {}}
        repoName={new Map([['r-app', 'AI Uploader']])}
      />,
    );
    const repoHeader = screen.getByRole('button', { name: 'AI Uploader repository' });
    expect(repoHeader).toHaveAttribute('aria-expanded', 'true');
    // Both worktree groups nest under the repo.
    expect(screen.getByRole('button', { name: 'FD-1 sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'FD-2 sessions' })).toBeInTheDocument();
    // Collapsing the repo hides every worktree beneath it.
    fireEvent.click(repoHeader);
    expect(repoHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'FD-1 sessions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'FD-2 sessions' })).toBeNull();
  });

  it('merges a single-worktree repo into one line and drops the branch subtitle when it repeats the repo name', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/wt/strado', { repoId: 'r-strado', hasClaudeSession: true, hasShellSession: true })]}
        onOpen={() => {}}
        repoName={new Map([['r-strado', 'strado']])}
      />,
    );
    // One merged header named by the repo — no separate repository super-header,
    // no duplicate worktree header.
    expect(screen.getByRole('button', { name: 'strado sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /repository/i })).toBeNull();
    expect(screen.getByText('2')).toBeInTheDocument(); // session count still shown
  });

  it('keeps the branch subtitle on a single-worktree repo when it differs from the repo name', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/wt/FD-1', { repoId: 'r-app', hasClaudeSession: true })]}
        onOpen={() => {}}
        repoName={new Map([['r-app', 'AI Uploader']])}
      />,
    );
    expect(screen.getByRole('button', { name: 'AI Uploader sessions' })).toBeInTheDocument();
    expect(screen.getByText('FD-1')).toBeInTheDocument(); // branch rides along as subtitle
  });

  it('marks the active session chip with aria-current and leaves the others unmarked', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/wt/FD-1', { hasClaudeSession: true, hasShellSession: true })]}
        onOpen={() => {}}
        activeTab={{ path: '/wt/FD-1', mode: 'shell', id: '1' }}
      />,
    );
    expect(screen.getByRole('button', { name: 'FD-1 Shell' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'FD-1 Claude' })).not.toHaveAttribute('aria-current');
  });

  it('renders a worktree flat (no repo header) when its repo cannot be resolved', () => {
    render(
      <SessionList
        wsId="w1"
        worktrees={[wt('/wt/FD-1', { repoId: 'r-unknown', hasClaudeSession: true })]}
        onOpen={() => {}}
        repoName={new Map([['r-app', 'AI Uploader']])}
      />,
    );
    expect(screen.queryByRole('button', { name: /repository/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'FD-1 sessions' })).toBeInTheDocument();
  });
});
