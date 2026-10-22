import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPanel, type PendingApproval } from './ApprovalPanel';

const a = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: 'ap1', agentId: 'claude-1@x', agentName: 'claude-1', kind: 'command', title: 'Bash', detail: 'rm -rf dist', createdAt: 1, ...over,
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ApprovalPanel', () => {
  it('nothing pending: renders nothing', () => {
    const { container } = render(<ApprovalPanel approvals={[]} onDecide={vi.fn()} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('header from the kind, the title, and the detail in monospace (at most 4 lines)', () => {
    render(<ApprovalPanel approvals={[a({ detail: 'l1\nl2\nl3\nl4\nl5\nl6' })]} onDecide={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'claude-1 wants to run a command' })).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    const detail = screen.getByTestId('approval-detail');
    expect(detail.tagName).toBe('PRE');
    expect(detail.textContent).toBe('l1\nl2\nl3\nl4…');
  });

  it.each([
    ['command', 'run a command'], ['file-change', 'change files'], ['file-read', 'read a file'], ['web', 'fetch from the web'], ['tool', 'use a tool'],
  ] as const)('%s → "wants to %s"', (kind, verb) => {
    render(<ApprovalPanel approvals={[a({ kind })]} onDecide={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByRole('group', { name: `claude-1 wants to ${verb}` })).toBeInTheDocument();
  });

  it('Approve and Deny send the decision for that approval id (human clicks only)', async () => {
    const onDecide = vi.fn(async () => 'ok' as const);
    render(<ApprovalPanel approvals={[a(), a({ id: 'ap2', agentName: 'codex-2', agentId: 'codex-2@x' })]} onDecide={onDecide} onOpen={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); });
    expect(onDecide).toHaveBeenCalledWith('ap1', 'allow');
    // The answered one goes; the next is shown.
    expect(screen.getByRole('group', { name: 'codex-2 wants to run a command' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deny' })); });
    expect(onDecide).toHaveBeenLastCalledWith('ap2', 'deny');
  });

  it('1/N with ← / → (buttons and keys)', () => {
    render(<ApprovalPanel approvals={[a(), a({ id: 'ap2', agentName: 'codex-2' }), a({ id: 'ap3', agentName: 'pi-1' })]} onDecide={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('1/3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next approval' }));
    expect(screen.getByText('2/3')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /codex-2/ })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('group', { name: /codex-2/ }), { key: 'ArrowRight' });
    expect(screen.getByText('3/3')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('group', { name: /pi-1/ }), { key: 'ArrowLeft' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous approval' }));
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('no counter for a single approval', () => {
    render(<ApprovalPanel approvals={[a()]} onDecide={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByText('1/1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next approval' })).not.toBeInTheDocument();
  });

  it('answered in the tab first (gone): "answered in the tab ✓" briefly, then it closes', async () => {
    const onDecide = vi.fn(async () => 'gone' as const);
    const { container } = render(<ApprovalPanel approvals={[a()]} onDecide={onDecide} onOpen={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); });
    expect(screen.getByText('answered in the tab ✓')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(container).toBeEmptyDOMElement();
  });

  it('an approval that disappears from the feed while shown (tab answered) also closes', () => {
    const { rerender, container } = render(<ApprovalPanel approvals={[a()]} onDecide={vi.fn()} onOpen={vi.fn()} />);
    rerender(<ApprovalPanel approvals={[]} onDecide={vi.fn()} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a failed decision says so and keeps the buttons', async () => {
    const onDecide = vi.fn(async () => { throw new Error('Server unreachable'); });
    render(<ApprovalPanel approvals={[a()]} onDecide={onDecide} onOpen={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Server unreachable');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('buttons are disabled while a decision is in flight (no double answers)', async () => {
    let done: (v: 'ok') => void = () => {};
    const onDecide = vi.fn(() => new Promise<'ok'>((r) => { done = r; }));
    render(<ApprovalPanel approvals={[a()]} onDecide={onDecide} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    await act(async () => { done('ok'); });
  });

  it('"Open tab ↗" opens that agent\'s tab', () => {
    const onOpen = vi.fn();
    render(<ApprovalPanel approvals={[a()]} onDecide={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open tab ↗' }));
    expect(onOpen).toHaveBeenCalledWith('claude-1@x');
  });
});
