import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImportTicketsDialog } from './ImportTicketsDialog';
import { publishTickets } from '../hooks/tickets';
import type { RepoConfig, Worktree } from '../types';

const ticketsSprints = vi.fn();
const ticketsSprintIssues = vi.fn();
const wtCreate = vi.fn();
vi.mock('../api', () => ({
  api: {
    tickets: {
      sprints: (...a: unknown[]) => ticketsSprints(...a),
      sprintIssues: (...a: unknown[]) => ticketsSprintIssues(...a),
    },
    worktrees: {
      create: (...a: unknown[]) => wtCreate(...a),
    },
  },
}));
vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'default' } }),
}));

const repos = [
  { id: 'rapp', name: 'Acme React App', path: '/main/rapp' },
  { id: 'napp', name: 'Acme Node App', path: '/main/napp' },
] as unknown as RepoConfig[];

const existingWt = {
  path: '/wt/FD-1',
  meta: { ticketId: 'FD-1' },
} as unknown as Worktree;

beforeEach(() => {
  publishTickets({ configured: ['jira'] });
  ticketsSprints.mockReset().mockResolvedValue([
    { id: '99', name: 'FMS 36', state: 'active', startDate: '2026-07-20', endDate: '2026-07-31' },
  ]);
  ticketsSprintIssues.mockReset().mockResolvedValue([
    { key: 'FD-1', summary: 'Existing thing', status: 'In Progress', category: 'indeterminate', provider: 'jira' },
    { key: 'FD-2', summary: 'New thing', status: 'To Do', category: 'new', provider: 'jira' },
  ]);
  wtCreate.mockReset().mockResolvedValue({ jobId: 'j1' });
});

describe('ImportTicketsDialog', () => {
  it('marks tickets already on the board and scaffolds only the new ones', async () => {
    render(
      <ImportTicketsDialog
        repos={repos}
        worktrees={[existingWt]}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // rows resolved: FD-1 matched (✓, "on board"), FD-2 new (checkbox on)
    expect(await screen.findByText('Existing thing')).toBeInTheDocument();
    expect(screen.getByText('on board')).toBeInTheDocument();
    expect(screen.getByLabelText('Create worktree for FD-2')).toBeChecked();
    expect(ticketsSprintIssues).toHaveBeenCalledWith('jira', '99', true);

    fireEvent.click(screen.getByRole('button', { name: /import \(\+1 worktree\)/i }));

    expect(await screen.findByText(/1 worktree being created/)).toBeInTheDocument();
    expect(wtCreate).toHaveBeenCalledTimes(1);
    expect(wtCreate).toHaveBeenCalledWith('default', {
      repoId: 'rapp',
      ticketId: 'FD-2',
      title: 'New thing',
      sourceBranch: 'master',
      sourceWorktree: '/main/rapp',
      ticketProvider: 'jira',
    });
  });

  it('disables Import when every new ticket is unticked', async () => {
    render(
      <ImportTicketsDialog
        repos={repos}
        worktrees={[existingWt]}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('New thing');
    fireEvent.click(screen.getByLabelText('Create worktree for FD-2')); // untick

    expect(screen.getByRole('button', { name: /^import$/i })).toBeDisabled();
    expect(wtCreate).not.toHaveBeenCalled();
  });

  it('the header checkbox unselects every creatable ticket, then selects them back', async () => {
    render(
      <ImportTicketsDialog
        repos={repos}
        worktrees={[existingWt]}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('New thing');
    const box = () => screen.getByLabelText('Create worktree for FD-2') as HTMLInputElement;
    const master = () => screen.getByLabelText('Select all tickets') as HTMLInputElement;
    expect(box().checked).toBe(true);
    expect(master().checked).toBe(true);
    fireEvent.click(master());
    expect(box().checked).toBe(false);
    expect(master().checked).toBe(false);
    fireEvent.click(master());
    expect(box().checked).toBe(true);
  });

  it('single connected provider: no tracker select', async () => {
    render(
      <ImportTicketsDialog
        repos={repos}
        worktrees={[existingWt]}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('New thing');
    expect(screen.queryByLabelText(/tracker/i)).not.toBeInTheDocument();
    // single provider connected — no source badges either
    expect(screen.queryByTitle('Jira')).not.toBeInTheDocument();
  });

  it('a Jira worktree with the same key never marks a same-keyed Linear issue as already on the board', async () => {
    publishTickets({ configured: ['jira', 'linear'] });
    ticketsSprints.mockImplementation((provider: string) =>
      provider === 'jira'
        ? Promise.resolve([{ id: '99', name: 'FMS 36', state: 'active', startDate: null, endDate: null }])
        : Promise.resolve([{ id: 'cyc-1', name: 'Cycle 12', state: 'active', startDate: null, endDate: null }]),
    );
    ticketsSprintIssues.mockImplementation((provider: string) =>
      provider === 'linear'
        ? Promise.resolve([{ key: 'ENG-45', summary: 'Ship linear', status: 'Todo', category: 'new', provider: 'linear' }])
        : Promise.resolve([]),
    );
    // a Jira worktree whose ticketId happens to collide with the Linear key
    const jiraWt = { path: '/wt/ENG-45', meta: { ticketId: 'ENG-45', ticketProvider: 'jira' } } as unknown as Worktree;

    render(
      <ImportTicketsDialog
        repos={repos}
        worktrees={[jiraWt]}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(await screen.findByLabelText(/tracker/i), { target: { value: 'linear' } });

    expect(await screen.findByText('Ship linear')).toBeInTheDocument();
    expect(screen.queryByText('on board')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Create worktree for ENG-45')).toBeChecked();
  });

  it('two connected providers: shows a tracker select; switching to Linear asks for cycles without a project', async () => {
    publishTickets({ configured: ['jira', 'linear'] });
    ticketsSprints.mockImplementation((provider: string) =>
      provider === 'jira'
        ? Promise.resolve([{ id: '99', name: 'FMS 36', state: 'active', startDate: null, endDate: null }])
        : Promise.resolve([{ id: 'cyc-1', name: 'Cycle 12', state: 'active', startDate: null, endDate: null }]),
    );
    ticketsSprintIssues.mockImplementation((provider: string) =>
      provider === 'jira'
        ? Promise.resolve([{ key: 'FD-2', summary: 'New thing', status: 'To Do', category: 'new', provider: 'jira' }])
        : Promise.resolve([{ key: 'ENG-9', summary: 'Ship linear', status: 'Todo', category: 'new', provider: 'linear' }]),
    );

    render(
      <ImportTicketsDialog
        repos={repos}
        worktrees={[existingWt]}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const tracker = await screen.findByLabelText(/tracker/i);
    expect(await screen.findByText('Sprint')).toBeInTheDocument();
    expect(ticketsSprints).toHaveBeenCalledWith('jira', 'FD');

    fireEvent.change(tracker, { target: { value: 'linear' } });

    expect(await screen.findByText('Cycle')).toBeInTheDocument();
    await vi.waitFor(() => expect(ticketsSprints).toHaveBeenCalledWith('linear'));
    expect(await screen.findByText('Ship linear')).toBeInTheDocument();
    // badges are visible once more than one provider is connected
    expect(screen.getByTitle('Linear')).toBeInTheDocument();
  });
});
