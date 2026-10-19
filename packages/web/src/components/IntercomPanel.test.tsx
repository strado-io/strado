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
const fns = () => ({ resolve: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined), createTask: vi.fn().mockResolvedValue(undefined), assignTask: vi.fn().mockResolvedValue(undefined), releaseTask: vi.fn().mockResolvedValue(undefined), doneTask: vi.fn().mockResolvedValue(undefined), cancelTask: vi.fn().mockResolvedValue(undefined), refresh: vi.fn() });

beforeEach(() => { ctx.value = { escalations: [esc, done], tasks: [task, claimed], peers, loaded: true, error: null, ...fns() }; });

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
    expect(ctx.value.dismiss).not.toHaveBeenCalled();
    await userEvent.click(within(row).getByRole('button', { name: 'Confirm dismiss' }));
    expect(ctx.value.dismiss).toHaveBeenCalledWith('E1');
  });
  it('Dismiss asks first; Keep cancels and leaves the typed answer in place', async () => {
    render(<IntercomPanel initialTab="escalations" onClose={vi.fn()} />);
    const row = screen.getByTestId('escalation-E1');
    const box = within(row).getByRole('textbox', { name: /your answer/i });
    await userEvent.type(box, 'half an answer');
    await userEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
    expect(within(row).getByText(/dismiss without answering/i)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Keep' }));
    expect(ctx.value.dismiss).not.toHaveBeenCalled();
    expect(box).toHaveValue('half an answer');
    expect(within(row).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
  it('a retargeted peer ask says it timed out waiting on a peer; a plain escalation does not', () => {
    const retargeted = { ...esc, id: 'E3', from: { agentId: 'gone-1@repo', executionId: 'y' }, askMessageId: 'M1', createdAt: 2 };
    ctx.value = { ...ctx.value, escalations: [esc, retargeted] };
    render(<IntercomPanel initialTab="escalations" onClose={vi.fn()} />);
    expect(within(screen.getByTestId('escalation-E3')).getByText(/peer ask timed out/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('escalation-E1')).queryByText(/peer ask timed out/i)).not.toBeInTheDocument();
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
    await userEvent.click(within(row).getByRole('button', { name: 'Confirm dismiss' }));
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
  it('focusId highlights the matching escalation row', () => {
    render(<IntercomPanel initialTab="escalations" focusId="E1" onClose={vi.fn()} />);
    expect(screen.getByTestId('escalation-E1').className).toMatch(/ring-amber-500/);
  });
});
