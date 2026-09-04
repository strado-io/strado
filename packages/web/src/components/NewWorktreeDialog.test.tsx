import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewWorktreeDialog, dominantProjectKey } from './NewWorktreeDialog';
import { publishTickets } from '../hooks/tickets';

type JobHandler = (evt: { type: 'progress' | 'done' | 'error'; data: unknown }) => void;
let jobHandler: JobHandler | null = null;
vi.mock('../eventStream', () => ({
  subscribeJob: (_id: string, handler: JobHandler) => {
    jobHandler = handler;
    return () => { jobHandler = null; };
  },
}));

const ticketsMyIssues = vi.fn();
const gitBranches = vi.fn();
vi.mock('../api', () => ({
  api: {
    tickets: {
      myIssues: (...a: unknown[]) => ticketsMyIssues(...a),
    },
    worktrees: {
      git: {
        branches: (...a: unknown[]) => gitBranches(...a),
      },
    },
  },
}));

beforeEach(() => {
  ticketsMyIssues.mockReset().mockResolvedValue([]);
  gitBranches.mockReset().mockResolvedValue({ branches: ['main'], current: 'main' });
  publishTickets({ configured: [] });
  jobHandler = null;
});

const repos = [
  {
    id: 'r',
    name: 'r',
    path: '/main',
    projectSubdir: null,
    startCommand: 'npm start',
    defaultPort: 8080,
    editor: 'code' as const,
    cloneUrl: 'https://github.com/acme/r.git',
  },
];

describe('dominantProjectKey', () => {
  it('ignores Linear tickets when picking the dominant Jira project', () => {
    const worktrees = [
      { meta: { ticketId: 'ENG-1', ticketProvider: 'linear' } },
      { meta: { ticketId: 'ENG-2', ticketProvider: 'linear' } },
      { meta: { ticketId: 'ENG-3', ticketProvider: 'linear' } },
      { meta: { ticketId: 'FD-9', ticketProvider: 'jira' } },
    ] as any;
    expect(dominantProjectKey(worktrees)).toBe('FD');
  });
});

describe('NewWorktreeDialog', () => {
  it('accepts a free-form (non-Jira) ticket id', () => {
    const onSubmit = vi.fn();
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add ticket' }));
    fireEvent.change(screen.getByLabelText(/^ticket \(optional\)$/i), { target: { value: 'spike-thing' } });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Thing' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 'spike-thing', title: 'Thing' }),
    );
  });

  it('creates with a blank ticket (title only)', () => {
    const onSubmit = vi.fn();
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Quick fix' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: '', title: 'Quick fix' }),
    );
  });

  it('does not load tickets until the ticket picker is opened', async () => {
    publishTickets({ configured: ['jira'] });
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={vi.fn()} />);

    expect(ticketsMyIssues).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'My open tickets' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add ticket' }));
    await vi.waitFor(() => expect(ticketsMyIssues).toHaveBeenCalledWith('jira'));
    expect(screen.getByRole('listbox', { name: 'My open tickets' })).toBeInTheDocument();
  });

  it('merges my open issues from every connected tracker, badge-tagged, and picking fills the form', async () => {
    publishTickets({ configured: ['jira', 'linear'] });
    ticketsMyIssues.mockImplementation((provider: string) =>
      Promise.resolve(
        provider === 'jira'
          ? [{ key: 'FD-7', summary: 'Fix maps', status: 'In Progress', category: 'indeterminate', provider: 'jira' }]
          : [{ key: 'ENG-9', summary: 'Ship linear', status: 'Todo', category: 'new', provider: 'linear' }],
      ),
    );
    const onSubmit = vi.fn();
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add ticket' }));

    expect(await screen.findByText('Fix maps')).toBeInTheDocument();
    expect(screen.getByText('Ship linear')).toBeInTheDocument();
    // one badge dot per row now that two providers are connected
    expect(screen.getByTitle('Jira')).toBeInTheDocument();
    expect(screen.getByTitle('Linear')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: /ship linear/i }));
    expect(screen.getByRole('button', { name: 'Ticket: ENG-9' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^title$/i)).toHaveValue('Ship linear');

    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 'ENG-9', ticketProvider: 'linear', title: 'Ship linear' }),
    );
  });

  it('one provider failing to load leaves the other tickets on the picker', async () => {
    publishTickets({ configured: ['jira', 'linear'] });
    ticketsMyIssues.mockImplementation((provider: string) =>
      provider === 'jira'
        ? Promise.reject(new Error('jira unreachable'))
        : Promise.resolve([{ key: 'ENG-9', summary: 'Ship linear', status: 'Todo', category: 'new', provider: 'linear' }]),
    );
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add ticket' }));
    expect(await screen.findByText('Ship linear')).toBeInTheDocument();
  });

  it('submits valid payload', () => {
    const onSubmit = vi.fn();
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add ticket' }));
    fireEvent.change(screen.getByLabelText(/^ticket \(optional\)$/i), { target: { value: 'FD-1' } });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Thing' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'r', ticketId: 'FD-1', title: 'Thing', sourceBranch: 'main' }),
    );
  });

  it('loads Git branches into a source branch dropdown', async () => {
    gitBranches.mockResolvedValue({ branches: ['main', 'release/next', 'origin/main'], current: 'main' });
    const onSubmit = vi.fn();
    render(
      <NewWorktreeDialog
        repos={repos}
        worktrees={[]}
        workspaceId="workspace-1"
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );

    const branch = screen.getByRole('button', { name: 'Source branch' });
    await vi.waitFor(() => expect(gitBranches).toHaveBeenCalledWith('workspace-1', '/main'));
    fireEvent.click(branch);
    fireEvent.click(await screen.findByRole('button', { name: 'release/next' }));
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Release work' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ sourceBranch: 'release/next' }));
  });

  it('keeps manual ticket entry usable when every connected provider is unavailable', async () => {
    publishTickets({ configured: ['linear'] });
    ticketsMyIssues.mockRejectedValue(new Error('tracker unavailable'));
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add ticket' }));
    expect(await screen.findByText('No open tickets found. You can still enter an ID above.')).toBeInTheDocument();
    expect(screen.queryByText(/could not load tickets/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^ticket \(optional\)$/i)).toBeEnabled();
  });

  it('hides the node_modules choice and uses the repo main worktree as its default', () => {
    const onSubmit = vi.fn();
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={onSubmit} />);

    expect(screen.queryByLabelText(/link node_modules from/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Simpler creation' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ sourceWorktree: '/main' }));
  });

  it('uses the shared picker for the creation machine and keeps offline runners disabled', () => {
    const onSubmit = vi.fn();
    render(
      <NewWorktreeDialog
        repos={repos}
        worktrees={[]}
        runners={[
          { runnerId: 'runner-dev-id', name: 'runner-dev', online: true },
          { runnerId: 'runner-offline-id', name: 'runner-offline', online: false },
        ]}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    expect(screen.getByRole('button', { name: 'runner-offline (offline)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'runner-dev' }));
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Remote work' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ runnerId: 'runner-dev-id' }));
  });

  it('disables remote runners when the selected repository has no clone URL', () => {
    render(
      <NewWorktreeDialog
        repos={[{ ...repos[0]!, cloneUrl: null }]}
        worktrees={[]}
        runners={[{ runnerId: 'runner-dev-id', name: 'runner-dev', online: true }]}
        onCancel={() => {}}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    expect(screen.getByRole('button', { name: 'runner-dev (repo has no remote)' })).toBeDisabled();
  });

  // A spinner for a multi-minute clone on a runner is indistinguishable from a
  // hang, and its failure used to arrive as a generic message.
  describe('job progress', () => {
    const STEPS = [
      { id: 'runner', label: 'Checking runner-dev' },
      { id: 'clone', label: 'Cloning r on runner-dev' },
      { id: 'worktree', label: 'Creating git worktree' },
    ];

    async function startRemoteCreate() {
      const view = render(
        <NewWorktreeDialog
          repos={repos}
          worktrees={[]}
          runners={[{ runnerId: 'runner-dev-wq3p', name: 'runner-dev', online: true }]}
          onCancel={() => {}}
          onSubmit={async () => ({ jobId: 'job-1' })}
          onDone={onDone}
        />,
      );
      fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Thing' } });
      fireEvent.click(screen.getByRole('button', { name: 'Where' }));
      fireEvent.click(screen.getByRole('button', { name: 'runner-dev' }));
      fireEvent.click(screen.getByRole('button', { name: /create/i }));
      await vi.waitFor(() => expect(jobHandler).not.toBeNull());
      return view;
    }

    const onDone = vi.fn();

    it('draws the whole plan from the first event, and marks progress', async () => {
      onDone.mockClear();
      await startRemoteCreate();
      jobHandler!({ type: 'progress', data: { message: 'Checking runner-dev', data: { step: 'runner', steps: STEPS } } });
      expect(await screen.findByText('Checking runner-dev')).toBeInTheDocument();
      // Later steps are visible up front — that is what makes the wait legible.
      expect(screen.getByText('Cloning r on runner-dev')).toBeInTheDocument();
      expect(screen.getByText('Creating git worktree')).toBeInTheDocument();
    });

    it('switches from the setup form to the focused runner progress view', async () => {
      onDone.mockClear();
      await startRemoteCreate();
      jobHandler!({ type: 'progress', data: { message: 'Checking runner-dev', data: { step: 'runner', steps: STEPS } } });

      expect(await screen.findByRole('heading', { name: 'Create worktree' })).toBeInTheDocument();
      expect(screen.getByLabelText(/^title$/i)).not.toBeVisible();
      expect(screen.getByTestId('creation-summary')).toHaveTextContent('r / Thing');
      expect(screen.getByTestId('creation-summary')).toHaveTextContent('source: main');
      expect(screen.getByText(/^on runner-dev$/i)).toBeVisible();
      expect(screen.getByText('0:00')).toBeVisible();
    });

    it('shows sub-detail under the step in flight', async () => {
      onDone.mockClear();
      await startRemoteCreate();
      jobHandler!({ type: 'progress', data: { message: 'Cloning', data: { step: 'clone', steps: STEPS } } });
      jobHandler!({ type: 'progress', data: { message: 'x', data: { step: 'clone', detail: 'already on this runner' } } });
      expect(await screen.findByText('already on this runner')).toBeInTheDocument();
    });

    it('closes only when the job finishes', async () => {
      onDone.mockClear();
      await startRemoteCreate();
      jobHandler!({ type: 'progress', data: { message: 'Cloning', data: { step: 'clone', steps: STEPS } } });
      expect(onDone).not.toHaveBeenCalled();
      jobHandler!({ type: 'done', data: {} });
      await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    });

    it('keeps the step list on failure and reports the real error', async () => {
      onDone.mockClear();
      await startRemoteCreate();
      jobHandler!({ type: 'progress', data: { message: 'Cloning', data: { step: 'clone', steps: STEPS } } });
      jobHandler!({ type: 'error', data: { message: 'runner-dev has no credentials for git@github.com:o/r.git' } });
      expect(await screen.findByText(/no credentials/)).toBeInTheDocument();
      // The list survives, so the failure is attributable to a step.
      expect(screen.getByText('Cloning r on runner-dev')).toBeInTheDocument();
      expect(onDone).not.toHaveBeenCalled();
    });

    it('shows a fast failure even when no progress frame was observed', async () => {
      onDone.mockClear();
      await startRemoteCreate();
      jobHandler!({ type: 'error', data: { message: 'runner failed before declaring steps' } });

      expect(await screen.findByText('runner failed before declaring steps')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
      expect(onDone).not.toHaveBeenCalled();
    });
  });
});
