import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, Worktree } from '../../types';
import { api } from '../../api';
import { publishTickets } from '../../hooks/tickets';
import { FocusComposer } from './FocusComposer';
import { __resetMyTickets } from './myTickets';

vi.mock('../../api', () => ({ api: { tickets: { myIssues: vi.fn() } } }));

const r1 = { id: 'r1', name: 'api', path: '/r1' } as RepoConfig;
const r2 = { id: 'r2', name: 'web', path: '/r2' } as RepoConfig;
const wt = (path: string, repoId: string, branch: string, ticketId?: string): Worktree => ({
  path, repoId, branch, meta: ticketId ? { ticketId, ticketProvider: 'jira' } : null, diffStats: null,
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false },
} as Worktree);
const worktrees = [wt('/r1/a', 'r1', 'FD-412_api', 'FD-412'), wt('/r2/b', 'r2', 'FD-412_web', 'FD-412'), wt('/r2/c', 'r2', 'feat/other')];
const issue = (key: string, summary: string) => ({ key, summary, provider: 'jira' as const, url: '', status: 'Open', category: 'new' as const, assignee: null, priority: null, estimate: null, timeSpent: null, remaining: null, timeSpentSeconds: null, remainingSeconds: null });

function mount(over: Partial<React.ComponentProps<typeof FocusComposer>> = {}) {
  const onCreate = vi.fn(); const onClose = vi.fn();
  render(<FocusComposer repos={[r1, r2]} worktrees={worktrees} remoteWorktrees={[]} onCreate={onCreate} onClose={onClose} {...over} />);
  return { onCreate, onClose, dialog: () => screen.getByRole('dialog', { name: 'New focus' }) };
}

beforeEach(() => {
  __resetMyTickets();
  vi.mocked(api.tickets.myIssues).mockReset().mockResolvedValue([issue('FD-412', 'Fix login redirect'), issue('FD-418', 'Rate limit the API')]);
  publishTickets({ configured: ['jira'] });
});

describe('FocusComposer', () => {
  it('From ticket: picking a ticket names the Focus, links it, and pre-checks its worktrees', async () => {
    const { onCreate, onClose, dialog } = mount();
    expect(within(dialog()).getByRole('tab', { name: 'From ticket' })).toHaveAttribute('aria-selected', 'true');
    const row = await within(dialog()).findByRole('option', { name: /FD-412/ });
    expect(row).toHaveTextContent('2 worktrees');
    fireEvent.click(row);
    expect(within(dialog()).getByLabelText('Focus name')).toHaveValue('FD-412 · Fix login redirect');
    expect(within(dialog()).getByText('2 worktrees selected')).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create & switch' }));
    expect(onCreate).toHaveBeenCalledWith('FD-412 · Fix login redirect', ['local:/r1/a', 'local:/r2/b'], { provider: 'jira', key: 'FD-412' });
    expect(onClose).toHaveBeenCalled();
  });

  it('From ticket: filters, and offers a typed key that is not listed; a name you typed is kept', async () => {
    const { onCreate, dialog } = mount();
    await within(dialog()).findByRole('option', { name: /FD-412/ });
    const search = within(dialog()).getByLabelText('Search tickets');
    fireEvent.change(search, { target: { value: 'rate' } });
    expect(within(dialog()).queryByRole('option', { name: /FD-412/ })).toBeNull();
    fireEvent.change(within(dialog()).getByLabelText('Focus name'), { target: { value: 'My name' } });
    fireEvent.change(search, { target: { value: 'fd-999' } });
    fireEvent.click(within(dialog()).getByRole('option', { name: /FD-999/ }));
    expect(within(dialog()).getByLabelText('Focus name')).toHaveValue('My name');
    fireEvent.keyDown(within(dialog()).getByLabelText('Focus name'), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('My name', [], { provider: 'jira', key: 'FD-999' });
  });

  it('From worktrees: a searchable checklist by repo; the name is required', () => {
    const { onCreate, dialog } = mount();
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'From worktrees' }));
    expect(within(dialog()).getByRole('button', { name: 'Create & switch' })).toBeDisabled();
    fireEvent.click(within(within(dialog()).getByRole('group', { name: 'web' })).getByRole('checkbox', { name: 'feat/other' }));
    fireEvent.change(within(dialog()).getByLabelText('Search worktrees'), { target: { value: 'FD-412' } });
    expect(within(dialog()).queryByRole('checkbox', { name: 'feat/other' })).toBeNull();
    fireEvent.click(within(within(dialog()).getByRole('group', { name: 'api' })).getByRole('checkbox', { name: 'FD-412' }));
    fireEvent.change(within(dialog()).getByLabelText('Focus name'), { target: { value: 'Mixed' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create & switch' }));
    expect(onCreate).toHaveBeenCalledWith('Mixed', expect.arrayContaining(['local:/r2/c', 'local:/r1/a']), undefined);
  });

  it('a seed worktree starts on From worktrees, checked, with its label as the name and its ticket linked', () => {
    const { onCreate, dialog } = mount({ seedPinId: 'local:/r1/a' });
    expect(within(dialog()).getByRole('tab', { name: 'From worktrees' })).toHaveAttribute('aria-selected', 'true');
    expect(within(within(dialog()).getByRole('group', { name: 'api' })).getByRole('checkbox', { name: 'FD-412' })).toBeChecked();
    expect(within(within(dialog()).getByRole('group', { name: 'web' })).getByRole('checkbox', { name: 'FD-412' })).not.toBeChecked();
    expect(within(dialog()).getByLabelText('Focus name')).toHaveValue('FD-412');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create & switch' }));
    expect(onCreate).toHaveBeenCalledWith('FD-412', ['local:/r1/a'], { provider: 'jira', key: 'FD-412' });
  });

  it('without a ticket provider there is no ticket tab, Blank is the default, and Escape closes', async () => {
    publishTickets({ configured: [] });
    const { onClose, dialog } = mount();
    expect(within(dialog()).queryByRole('tab', { name: 'From ticket' })).toBeNull();
    expect(within(dialog()).getByRole('tab', { name: 'Blank' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
