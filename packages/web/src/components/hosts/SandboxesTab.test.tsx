import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '../../eventStream';
import type { SandboxRow } from '../../types';

const jobs = vi.hoisted(() => ({ handlers: new Map<string, (e: JobEvent) => void>() }));
vi.mock('../../eventStream', () => ({
  subscribeJob: (id: string, h: (e: JobEvent) => void) => { jobs.handlers.set(id, h); return () => jobs.handlers.delete(id); },
}));
const sbx = vi.hoisted(() => ({ list: vi.fn(), action: vi.fn() }));
vi.mock('../../api', () => ({ api: { runners: { sandboxes: sbx } } }));

import { SandboxesTab, bytes, staleText, uptime } from './SandboxesTab';

const NOW = Date.now();
const r = (slug: string, over: Partial<SandboxRow> = {}): SandboxRow => ({
  slug, worktreePath: `/wt/${slug}`, repoName: 'strado', worktreeName: slug, status: 'running', image: 'strado-sandbox:0.1.30',
  createdAt: NOW - 3 * 3_600_000, startedAt: NOW - (2 * 60 + 5) * 60_000, cpuPercent: 12.4, memBytes: 512 * 1024 ** 2, memLimitBytes: 2 * 1024 ** 3,
  staleLogins: [], ...over,
});
const LIST = { runtime: 'podman' as const, sandboxes: [
  r('feat-a', { staleLogins: ['claude'] }),
  r('feat-b', { status: 'stopped', startedAt: null, cpuPercent: null, memBytes: null, memLimitBytes: null }),
  r('stray', { worktreePath: null, repoName: null, worktreeName: null }),
] };
const item = (slug: string) => screen.getByTestId(`sandbox-${slug}`);

beforeEach(() => {
  jobs.handlers.clear();
  sbx.list.mockReset().mockResolvedValue(LIST);
  sbx.action.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('SandboxesTab', () => {
  it('formats uptime, memory and stale-login text', () => {
    expect(uptime(NOW - 30_000, NOW)).toBe('up <1m');
    expect(uptime(NOW - 125 * 60_000, NOW)).toBe('up 2h 5m');
    expect(uptime(NOW - 26 * 3_600_000, NOW)).toBe('up 1d 2h');
    expect(bytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(bytes(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(staleText(['claude'])).toBe('Created before Claude was connected');
    expect(staleText(['claude', 'codex', 'pi'])).toBe('Created before Claude, Codex and Pi were connected');
  });

  it('one row per container: repo/worktree, status in words, image, CPU/mem, uptime', async () => {
    render(<SandboxesTab runnerId="r1" online visible />);
    await screen.findByTestId('sandbox-feat-a');
    expect(sbx.list).toHaveBeenCalledWith('r1');
    expect(screen.getByTestId('sandboxes-tab')).toHaveTextContent('Sandboxes on podman');
    expect(item('feat-a')).toHaveTextContent('strado / feat-a');
    expect(item('feat-a')).toHaveTextContent('Running');
    expect(item('feat-a')).toHaveTextContent('strado-sandbox:0.1.30');
    expect(item('feat-a')).toHaveTextContent('CPU 12% · 512 MB / 2.0 GB · up 2h 5m');
    expect(item('feat-b')).toHaveTextContent('Stopped');
    expect(item('feat-b')).not.toHaveTextContent('CPU');
  });

  it('actions follow the status; a container that isn\'t ours is greyed with none', async () => {
    render(<SandboxesTab runnerId="r1" online visible />);
    await screen.findByTestId('sandbox-feat-a');
    const names = (slug: string) => within(item(slug)).queryAllByRole('button').map((b) => b.textContent);
    expect(names('feat-a')).toEqual(['Restart', 'Stop', 'Rebuild', 'Remove', 'Rebuild']);
    expect(names('feat-b')).toEqual(['Start', 'Rebuild', 'Remove']);
    expect(names('stray')).toEqual([]);
    expect(item('stray').className).toMatch(/opacity-50/);
    expect(item('stray')).toHaveTextContent('Not a Strado sandbox');
  });

  it('a stale-login badge offers Rebuild', async () => {
    sbx.action.mockResolvedValue({ jobId: 'job-1' });
    render(<SandboxesTab runnerId="r1" online visible />);
    const badge = await screen.findByTestId('sandbox-stale');
    expect(badge).toHaveTextContent(/^Created before Claude was connected\s*·\s*Rebuild$/);
    fireEvent.click(within(badge).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(sbx.action).toHaveBeenCalledWith('r1', 'feat-a', 'rebuild'));
  });

  it('Restart/Stop/Start answer at once and refresh the list', async () => {
    render(<SandboxesTab runnerId="r1" online visible />);
    await screen.findByTestId('sandbox-feat-b');
    fireEvent.click(within(item('feat-b')).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(sbx.action).toHaveBeenCalledWith('r1', 'feat-b', 'start'));
    await waitFor(() => expect(sbx.list).toHaveBeenCalledTimes(2));
  });

  it('Rebuild shows the job\'s progress inline, then refreshes; a failure is said in the row', async () => {
    sbx.action.mockResolvedValue({ jobId: 'job-1' });
    render(<SandboxesTab runnerId="r1" online visible />);
    await screen.findByTestId('sandbox-feat-b');
    fireEvent.click(within(item('feat-b')).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(jobs.handlers.has('job-1')).toBe(true));
    expect(within(item('feat-b')).getByTestId('sandbox-busy')).toHaveTextContent('Rebuild…');
    act(() => jobs.handlers.get('job-1')!({ type: 'progress', data: { message: 'Pulling image…' } }));
    expect(within(item('feat-b')).getByTestId('sandbox-busy')).toHaveTextContent('Pulling image…');
    expect(within(item('feat-b')).queryByRole('button')).toBeNull();
    act(() => jobs.handlers.get('job-1')!({ type: 'error', data: { message: 'rebuild failed on the runner' } }));
    expect(within(item('feat-b')).getByRole('alert')).toHaveTextContent('rebuild failed on the runner');
    await waitFor(() => expect(sbx.list).toHaveBeenCalledTimes(2));
  });

  it('Remove confirms first that it ends the terminals', async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<SandboxesTab runnerId="r1" online visible />);
    await screen.findByTestId('sandbox-feat-a');
    fireEvent.click(within(item('feat-a')).getByRole('button', { name: 'Remove' }));
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("Removing ends this sandbox's terminals"));
    expect(sbx.action).not.toHaveBeenCalled();
    fireEvent.click(within(item('feat-a')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sbx.action).toHaveBeenCalledWith('r1', 'feat-a', 'remove'));
  });

  it('refreshes every 10s only while visible; Refresh asks at once', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<SandboxesTab runnerId="r1" online visible />);
    await act(async () => { await Promise.resolve(); });
    expect(sbx.list).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(sbx.list).toHaveBeenCalledTimes(2);
    rerender(<SandboxesTab runnerId="r1" online visible={false} />);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(sbx.list).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(sbx.list).toHaveBeenCalledTimes(3);
  });

  it('runner offline: a banner, no fetching, and every action disabled', async () => {
    const { rerender } = render(<SandboxesTab runnerId="r1" online visible />);
    await screen.findByTestId('sandbox-feat-a');
    rerender(<SandboxesTab runnerId="r1" online={false} visible />);
    expect(screen.getByTestId('sandboxes-offline')).toHaveTextContent('Runner offline');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    for (const b of within(item('feat-a')).getAllByRole('button')) expect(b).toBeDisabled();
  });

  it('a list that fails to load says so', async () => {
    sbx.list.mockRejectedValue(new Error('runner unreachable'));
    render(<SandboxesTab runnerId="r1" online visible />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load sandboxes: runner unreachable');
  });
});
