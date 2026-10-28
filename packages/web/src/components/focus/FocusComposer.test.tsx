import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, Worktree } from '../../types';
import { api } from '../../api';
import { publishTickets } from '../../hooks/tickets';
import { FocusComposer } from './FocusComposer';
import { __resetMyTickets } from './myTickets';

vi.mock('../../api', () => ({ api: {
  tickets: { myIssues: vi.fn() },
  worktrees: { create: vi.fn(), git: { branches: vi.fn() } },
} }));
type JobHandler = (evt: { type: 'progress' | 'done' | 'error'; data: unknown }) => void;
let jobHandler: JobHandler | null = null;
vi.mock('../../eventStream', () => ({
  subscribeJob: (_id: string, handler: JobHandler) => { jobHandler = handler; return () => { jobHandler = null; }; },
}));

const r1 = { id: 'r1', name: 'api', path: '/r1' } as RepoConfig;
const r2 = { id: 'r2', name: 'web', path: '/r2' } as RepoConfig;
const wt = (path: string, repoId: string, branch: string, ticketId?: string): Worktree => ({
  path, repoId, branch, meta: ticketId ? { ticketId, ticketProvider: 'jira' } : null, diffStats: null,
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, external: false },
} as Worktree);
const worktrees = [wt('/r1/a', 'r1', 'FD-412_api', 'FD-412'), wt('/r2/b', 'r2', 'FD-412_web', 'FD-412'), wt('/r2/c', 'r2', 'feat/other')];
const issue = (key: string, summary: string) => ({ key, summary, provider: 'jira' as const, url: '', status: 'Open', category: 'new' as const, assignee: null, priority: null, estimate: null, timeSpent: null, remaining: null, timeSpentSeconds: null, remainingSeconds: null });

function mount(over: Partial<React.ComponentProps<typeof FocusComposer>> = {}) {
  const onCreate = vi.fn(async () => {}); const onClose = vi.fn(); const onStartAgent = vi.fn();
  render(<FocusComposer repos={[r1, r2]} worktrees={worktrees} remoteWorktrees={[]} onCreate={onCreate} onStartAgent={onStartAgent} onClose={onClose} {...over} />);
  return { onCreate, onClose, onStartAgent, dialog: () => screen.getByRole('dialog', { name: 'New focus' }) };
}
const box = () => screen.getByRole('textbox', { name: 'What are you working on?' });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const enter = () => fireEvent.keyDown(box(), { key: 'Enter' });
const pick = (menu: string, item: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: menu }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: item }));
};

beforeEach(() => {
  __resetMyTickets();
  vi.mocked(api.tickets.myIssues).mockReset().mockResolvedValue([issue('FD-412', 'Fix login redirect'), issue('FD-418', 'Rate limit the API')]);
  publishTickets({ configured: ['jira'] });
  vi.mocked(api.worktrees.create).mockReset().mockResolvedValue({ jobId: 'job-1' } as never);
  vi.mocked(api.worktrees.git.branches).mockReset().mockResolvedValue({ branches: ['main', 'develop'], current: 'main' } as never);
  jobHandler = null;
});

describe('FocusComposer', () => {
  it('one box: type, Enter — the first line names a Focus with nothing in it; Shift+Enter is a new line', async () => {
    const { onCreate, onClose, onStartAgent } = mount();
    expect(document.activeElement).toBe(box());
    expect(screen.queryByRole('tab')).toBeNull();
    type('Fix the flaky login test\nIt fails one run in ten');
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(onCreate).not.toHaveBeenCalled();
    enter();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Fix the flaky login test', [], undefined));
    expect(onStartAgent).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('nothing typed: nothing to create', () => {
    const { onCreate } = mount();
    expect(screen.getByRole('button', { name: 'Create focus' })).toBeDisabled();
    enter();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('a project makes a new worktree named from the first line, then the Focus with it, and the agent starts there with the task', async () => {
    const { onCreate, onStartAgent } = mount({ workspaceId: 'ws' });
    type('Login Redirect\nkeep the return url');
    pick('Agent', /Claude/);
    pick('Project', 'web');
    expect(screen.getByRole('button', { name: 'Worktree' })).toHaveTextContent('New worktree');
    enter();
    await waitFor(() => expect(api.worktrees.create).toHaveBeenCalledWith('ws', expect.objectContaining({ repoId: 'r2', title: 'login-redirect', sourceWorktree: '/r2' })));
    // r2's checkout isn't in the list, so no branch is guessed: the server reads the repo's own.
    expect(vi.mocked(api.worktrees.create).mock.calls[0]?.[1]?.sourceBranch).toBeUndefined();
    expect(onCreate).not.toHaveBeenCalled();
    await waitFor(() => expect(jobHandler).not.toBeNull());
    jobHandler!({ type: 'done', data: { result: { path: '/r2/login-redirect' } } });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Login Redirect', ['local:/r2/login-redirect'], undefined));
    expect(onStartAgent).toHaveBeenCalledWith('/r2/login-redirect', 'claude', 'Login Redirect\nkeep the return url');
  });

  it('a project\'s existing worktree joins instead of a new one', async () => {
    const { onCreate } = mount({ workspaceId: 'ws' });
    type('Other work');
    pick('Project', 'web');
    pick('Worktree', 'feat/other');
    enter();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Other work', ['local:/r2/c'], undefined));
    expect(api.worktrees.create).not.toHaveBeenCalled();
  });

  it('an agent with nowhere to run says so and waits', () => {
    const { onCreate } = mount();
    type('Explain the repo');
    pick('Agent', /Codex/);
    expect(screen.getByText(/Pick a project or a worktree for Codex/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create focus' })).toBeDisabled();
    enter();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('🎫 links a ticket: it names the Focus and brings the worktrees already on it', async () => {
    const { onCreate } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Link a ticket' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /FD-412/ }));
    expect(box()).toHaveValue('FD-412: Fix login redirect');
    expect(screen.getByRole('button', { name: 'Unlink FD-412' })).toBeInTheDocument();
    enter();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('FD-412: Fix login redirect', ['local:/r1/a', 'local:/r2/b'], { provider: 'jira', key: 'FD-412' }));
  });

  it('⑂ adds existing worktrees as chips; × takes one off', async () => {
    const { onCreate } = mount();
    type('Both sides');
    fireEvent.click(screen.getByRole('button', { name: 'Add worktrees' }));
    const picker = screen.getAllByRole('menu').at(-1)!;
    fireEvent.click(within(picker).getAllByRole('checkbox')[0]!);
    fireEvent.click(within(picker).getAllByRole('checkbox')[2]!);
    fireEvent.keyDown(window, { key: 'Escape' });
    const removes = screen.getAllByRole('button', { name: /^Remove / });
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[1]!);
    enter();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Both sides', [expect.stringMatching(/^local:/)], undefined));
  });

  it('a seed worktree arrives as a chip and names the Focus', async () => {
    const { onCreate } = mount({ seedPinId: 'local:/r2/c' });
    expect(box()).toHaveValue('feat/other');
    expect(screen.getByRole('button', { name: 'Remove feat/other' })).toBeInTheDocument();
    enter();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('feat/other', ['local:/r2/c'], undefined));
  });

  it('Esc closes (a menu first)', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
