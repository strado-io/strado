import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ctx = vi.hoisted(() => ({ value: null as unknown as Record<string, unknown> }));
vi.mock('../contexts/IntercomContext', () => ({ useIntercom: () => ctx.value }));
import { IntercomPanel } from './IntercomPanel';

const peers = [{ agentId: 'claude-1@repo', alias: null, mode: 'claude', worktreePath: '/w/repo', sessionId: '1', lifecycle: 'idle', live: true }, { agentId: 'shell-1@repo', alias: 'bob', mode: 'shell', worktreePath: '/w/repo', sessionId: '1', lifecycle: 'idle', live: true }];
const esc = { id: 'E1', scopeId: 'default', from: { agentId: 'claude-1@repo', executionId: 'x' }, to: 'human', title: 'db?', body: 'pg or sqlite', context: [{ kind: 'url', value: 'https://example.com/x', label: 'docs' }], taskId: null, status: 'open', resolution: null, resolvedBy: null, createdAt: 1, resolvedAt: null, expiresAt: null };
const done = { ...esc, id: 'E0', status: 'resolved', resolution: 'sqlite', resolvedBy: 'human', resolvedAt: 2 };
const task = { id: 'T1', scopeId: 'default', title: 'write tests', body: '', ticketKey: 'FLT-1', worktreePath: null, dependsOn: [], status: 'open', createdBy: { agentId: 'human' }, claimedBy: null, createdAt: 1, updatedAt: 1, claimedAt: null, doneAt: null };
const claimed = { ...task, id: 'T2', title: 'fix bug', status: 'claimed', claimedBy: { agentId: 'shell-1@repo' } };
const forkQ = { id: 'F1', scopeId: 'default', from: { agentId: 'human', executionId: 'human' }, source: { agentId: 'claude-1@repo', worktreePath: '/w/repo', mode: 'claude', sessionId: '1' }, target: { kind: 'peer', agentId: 'shell-1@repo' }, notes: 'migrate DB', taskId: null, summarySource: null, summary: null, status: 'queued', summaryMessageId: null, messageId: null, packageBytes: null, error: null, createdAt: 5, summaryDeadline: null, deliveredAt: null, acceptedAt: null };
const forkFailed = { ...forkQ, id: 'F2', status: 'failed', error: 'target gone', target: { kind: 'new', mode: 'codex', worktreePath: '/w/repo', agentId: null }, createdAt: 4 };
const forkDone = { ...forkQ, id: 'F3', status: 'accepted', summarySource: 'agent', acceptedAt: 9, createdAt: 3 };
const fns = () => ({ resolve: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined), createTask: vi.fn().mockResolvedValue(undefined), assignTask: vi.fn().mockResolvedValue(undefined), releaseTask: vi.fn().mockResolvedValue(undefined), doneTask: vi.fn().mockResolvedValue(undefined), cancelTask: vi.fn().mockResolvedValue(undefined), createFork: vi.fn(), cancelFork: vi.fn(), refresh: vi.fn() });

beforeEach(() => { ctx.value = { escalations: [esc, done], tasks: [task, claimed], forks: [forkQ, forkFailed, forkDone], peers, loaded: true, error: null, ...fns() }; });

describe('IntercomPanel', () => {
  it('lists open escalations first with agent, title, body and context links; resolve sends the typed text', async () => {
    const onClose = vi.fn();
    render(<IntercomPanel initialTab="escalations" onClose={onClose} />);
    const row = screen.getByTestId('escalation-E1');
    expect(within(row).getByText('db?')).toBeInTheDocument();
    expect(within(row).getByText('pg or sqlite')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.com/x');
    await userEvent.type(within(row).getByRole('textbox', { name: /your answer/i }), 'sqlite');
    await userEvent.click(within(row).getByRole('button', { name: 'Resolve' }));
    expect(ctx.value.resolve).toHaveBeenCalledWith('E1', 'sqlite');
    expect(screen.getByText(/resolved/i)).toBeInTheDocument(); // collapsed section header
  });
  it('Resolve is disabled while the answer is empty; Dismiss works without text', async () => {
    render(<IntercomPanel initialTab="escalations" onClose={vi.fn()} />);
    const row = screen.getByTestId('escalation-E1');
    expect(within(row).getByRole('button', { name: 'Resolve' })).toBeDisabled();
    await userEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
    expect(ctx.value.dismiss).toHaveBeenCalledWith('E1');
  });
  it('tasks tab groups open / claimed / done, creates a task from the inline form, and offers row actions', async () => {
    render(<IntercomPanel initialTab="tasks" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /open/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /claimed/i })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: /new task title/i }), 'triage');
    await userEvent.click(screen.getByRole('button', { name: /add task/i }));
    expect(ctx.value.createTask).toHaveBeenCalledWith({ title: 'triage' });
    const claimedRow = screen.getByTestId('task-T2');
    expect(within(claimedRow).getByText('bob')).toBeInTheDocument();
    await userEvent.click(within(claimedRow).getByRole('button', { name: 'Mark done' }));
    expect(ctx.value.doneTask).toHaveBeenCalledWith('T2');
    await userEvent.click(within(claimedRow).getByRole('button', { name: 'Release' }));
    expect(ctx.value.releaseTask).toHaveBeenCalledWith('T2');
    const openRow = screen.getByTestId('task-T1');
    await userEvent.selectOptions(within(openRow).getByRole('combobox', { name: /assign to/i }), 'shell-1@repo');
    expect(ctx.value.assignTask).toHaveBeenCalledWith('T1', 'shell-1@repo');
    await userEvent.click(within(openRow).getByRole('button', { name: 'Cancel task' }));
    expect(ctx.value.cancelTask).toHaveBeenCalledWith('T1');
  });
  it('the Resolved section is the human\'s history only — a resolved agent-to-agent ask stays out', () => {
    const peerAsk = { ...esc, id: 'E2', to: 'shell-1@repo', title: 'peer ask', status: 'resolved', resolution: 'yes', resolvedBy: 'shell-1@repo', resolvedAt: 3 };
    ctx.value = { ...ctx.value, escalations: [esc, done, peerAsk] };
    render(<IntercomPanel initialTab="escalations" onClose={vi.fn()} />);
    expect(screen.getByText('Resolved (1)')).toBeInTheDocument();
    expect(screen.queryByTestId('escalation-E2')).not.toBeInTheDocument();
    expect(screen.queryByText('peer ask')).not.toBeInTheDocument();
  });
  it('Dismiss clears the row draft, so a reopened ask does not carry stale text', async () => {
    render(<IntercomPanel initialTab="escalations" onClose={vi.fn()} />);
    const row = screen.getByTestId('escalation-E1');
    const box = within(row).getByRole('textbox', { name: /your answer/i });
    await userEvent.type(box, 'never mind');
    expect(box).toHaveValue('never mind');
    await userEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
    expect(ctx.value.dismiss).toHaveBeenCalledWith('E1');
    expect(box).toHaveValue('');
  });
  it('empty states and close', async () => {
    ctx.value = { ...ctx.value, escalations: [], tasks: [] };
    const onClose = vi.fn();
    render(<IntercomPanel initialTab="escalations" onClose={onClose} />);
    expect(screen.getByText('No open escalations')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /tasks/i }));
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
  it('Forks tab lists in-flight forks with status, source → target and label; Cancel only while summarising/queued; Open jumps to the target tab', async () => {
    const onOpenTab = vi.fn();
    render(<IntercomPanel initialTab="forks" onClose={vi.fn()} onOpenTab={onOpenTab} />);
    expect(screen.getByRole('button', { name: 'Forks (1)' })).toHaveAttribute('aria-pressed', 'true');
    const row = screen.getByTestId('fork-F1');
    expect(within(row).getByText('queued')).toBeInTheDocument();
    expect(within(row).getByText('migrate DB')).toBeInTheDocument();
    expect(within(row).getAllByText('bob').length).toBeGreaterThan(0); // target alias
    await userEvent.click(within(row).getByRole('button', { name: 'Open' }));
    expect(onOpenTab).toHaveBeenCalledWith('/w/repo', 'shell', '1');
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel fork' }));
    expect(ctx.value.cancelFork).toHaveBeenCalledWith('F1');
    expect(screen.queryByTestId('fork-F2')).not.toBeInTheDocument(); // settled are collapsed
    await userEvent.click(screen.getByText('Settled (2)'));
    const failed = screen.getByTestId('fork-F2');
    expect(within(failed).getByText('target gone')).toBeInTheDocument();
    expect(within(failed).queryByRole('button', { name: 'Cancel fork' })).not.toBeInTheDocument();
    expect(within(failed).queryByRole('button', { name: 'Open' })).not.toBeInTheDocument(); // new-tab target never spawned
    expect(within(screen.getByTestId('fork-F3')).getByText('summary: agent')).toBeInTheDocument();
  });
  it('focusId highlights the matching fork row', () => {
    render(<IntercomPanel initialTab="forks" focusId="F1" onClose={vi.fn()} />);
    expect(screen.getByTestId('fork-F1').className).toMatch(/ring-sky-700/);
  });
  it('focusId naming a settled fork opens the Settled section on the initial render', () => {
    render(<IntercomPanel initialTab="forks" focusId="F2" onClose={vi.fn()} />);
    expect(screen.getByTestId('fork-F2').className).toMatch(/ring-sky-700/);
  });
  it('rerendering with a new focusId moves the ring to the new row', () => {
    const { rerender } = render(<IntercomPanel initialTab="forks" focusId="F1" onClose={vi.fn()} />);
    expect(screen.getByTestId('fork-F1').className).toMatch(/ring-sky-700/);
    rerender(<IntercomPanel initialTab="forks" focusId="F3" onClose={vi.fn()} />);
    expect(screen.getByTestId('fork-F1').className).not.toMatch(/ring-sky-700/);
    expect(screen.getByTestId('fork-F3').className).toMatch(/ring-sky-700/);
  });
});
