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
vi.mock('../api', () => ({
  api: {
    tickets: {
      myIssues: (...a: unknown[]) => ticketsMyIssues(...a),
    },
  },
}));

beforeEach(() => {
  ticketsMyIssues.mockReset().mockResolvedValue([]);
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

  it('never shows a From Jira button — the ticket picker fills the form instead', async () => {
    publishTickets({ configured: ['jira'] });
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={vi.fn()} />);
    await vi.waitFor(() => expect(ticketsMyIssues).toHaveBeenCalledWith('jira'));
    expect(screen.queryByRole('button', { name: /from jira/i })).not.toBeInTheDocument();
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

    expect(await screen.findByText('Fix maps')).toBeInTheDocument();
    expect(screen.getByText('Ship linear')).toBeInTheDocument();
    // one badge dot per row now that two providers are connected
    expect(screen.getByTitle('Jira')).toBeInTheDocument();
    expect(screen.getByTitle('Linear')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: /ship linear/i }));
    expect(screen.getByLabelText(/^ticket \(optional\)$/i)).toHaveValue('ENG-9');
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
    expect(await screen.findByText('Ship linear')).toBeInTheDocument();
  });

  it('submits valid payload', () => {
    const onSubmit = vi.fn();
    render(<NewWorktreeDialog repos={repos} worktrees={[]} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/ticket/i), { target: { value: 'FD-1' } });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Thing' } });
    fireEvent.change(screen.getByLabelText(/source branch/i), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'r', ticketId: 'FD-1', title: 'Thing', sourceBranch: 'main' }),
    );
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
  });
});
