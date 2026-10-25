import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ChatEntry, JarvisMeta } from '../../types';
import { ChatEntryView } from './ChatEntryView';
import { TabCard } from './TabCard';
import { ApprovalCard } from './ApprovalCard';
import { JarvisComposer } from './JarvisComposer';
import { JarvisSidebarCard, latestLine } from './JarvisSidebarCard';
import { FocusJarvisView, displayOrder } from './FocusJarvisView';

const at = '2026-10-26T10:00:00Z';
const meta: JarvisMeta = { focusId: 'f1', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 0, running: false };
const approval = (over: Partial<Extract<ChatEntry, { type: 'approval' }>> = {}): Extract<ChatEntry, { type: 'approval' }> =>
  ({ id: 'a1', at, type: 'approval', turnId: 't1', action: 'run.stop', args: {}, summary: 'Stop dev in fleetx-api', state: 'pending', ...over });
const noop = () => {};

describe('ChatEntryView', () => {
  it('renders the user bubble and the jarvis text', () => {
    render(<>
      <ChatEntryView entry={{ id: 'u1', at, type: 'user', text: 'open claude', windowId: 'w' }} resolve={() => ({ open: false })} onOpenCard={noop} onApprove={noop} />
      <ChatEntryView entry={{ id: 'j1', at, type: 'jarvis', turnId: 't1', text: 'Opened **Claude**.', done: true }} resolve={() => ({ open: false })} onOpenCard={noop} onApprove={noop} />
    </>);
    expect(screen.getByTestId('jarvis-user')).toHaveTextContent('open claude');
    expect(screen.getByTestId('jarvis-answer')).toHaveTextContent('Opened Claude.');
  });
  it('a failed turn says why and the fix', () => {
    render(<ChatEntryView entry={{ id: 'x', at, type: 'turn', turnId: 't1', state: 'failed', error: 'Claude is not signed in', fix: 'Run claude login' }}
      resolve={() => ({ open: false })} onOpenCard={noop} onApprove={noop} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Claude is not signed in');
    expect(screen.getByRole('alert')).toHaveTextContent('Run claude login');
  });
});

describe('TabCard', () => {
  it('open on a card selects its worktree and tab', () => {
    const onOpen = vi.fn();
    render(<TabCard card={{ kind: 'claude', worktree: 'fleetx-api', tab: 'claude-1' }} resolved={{ open: true, worktreePath: '/w/api', mode: 'claude', sessionId: '1', busy: false, status: 'idle' }} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(onOpen).toHaveBeenCalledWith({ open: true, worktreePath: '/w/api', mode: 'claude', sessionId: '1', busy: false, status: 'idle' });
  });
  it('a closed tab card is greyed and says closed', () => {
    render(<TabCard card={{ kind: 'shell', worktree: 'web', tab: 'shell-2' }} resolved={{ open: false }} onOpen={noop} />);
    const card = screen.getByTestId('tab-card');
    expect(card).toHaveAttribute('data-closed', 'true');
    expect(card).toHaveTextContent('closed');
    expect(within(card).queryByRole('button', { name: /open/i })).toBeNull();
  });
});

describe('ApprovalCard', () => {
  it('posts approve and no', () => {
    const onApprove = vi.fn();
    render(<ApprovalCard entry={approval()} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onApprove.mock.calls).toEqual([['a1', true], ['a1', false]]);
  });
  it('is red when dangerous, and settled once decided', () => {
    const { rerender } = render(<ApprovalCard entry={approval({ danger: 'Deletes the worktree' })} onApprove={noop} />);
    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-danger', 'true');
    expect(screen.getByText('Deletes the worktree')).toBeInTheDocument();
    rerender(<ApprovalCard entry={approval({ state: 'approved', result: 'Stopped' })} onApprove={noop} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByTestId('approval-card')).toHaveTextContent(/approved/i);
  });
});

describe('JarvisComposer', () => {
  const props = { running: false, agent: 'claude' as const, onSend: vi.fn(), onStop: vi.fn(), agents: [{ label: 'claude-1', agentId: 'claude-1@a' }], worktrees: [] };
  it('enter sends, shift-enter makes a newline', () => {
    const onSend = vi.fn();
    render(<JarvisComposer {...props} onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: /message jarvis/i });
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('line one');
    expect(box).toHaveValue('');
  });
  it('@ offers agents and sends the picked one exactly', () => {
    const onSend = vi.fn();
    render(<JarvisComposer {...props} onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: /message jarvis/i }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'ask @cl', selectionStart: 7 } });
    fireEvent.click(screen.getByRole('option', { name: /claude-1/ }));
    expect(box.value).toBe('ask @claude-1 ');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('ask @{claude-1@a}');
  });
  it('shows stop while running; other agents are coming soon', () => {
    const onStop = vi.fn();
    render(<JarvisComposer {...props} running onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /agent: claude/i }));
    expect(screen.getByRole('menuitem', { name: /codex.*coming soon/i })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('JarvisSidebarCard', () => {
  it('shows needs approval and the latest line', () => {
    render(<JarvisSidebarCard meta={{ ...meta, pendingApprovals: 1 }} latest="Stop dev?" active={false} onOpen={noop} />);
    expect(screen.getByText('needs approval')).toBeInTheDocument();
    expect(screen.getByTestId('jarvis-card')).toHaveTextContent('Claude · Stop dev?');
  });
  it('latestLine is the last reply or user line, one line', () => {
    expect(latestLine([{ id: '1', at, type: 'user', text: 'hi', windowId: 'w' }, { id: '2', at, type: 'jarvis', turnId: 't', text: 'Done.\nMore', done: true }])).toBe('Done.');
    expect(latestLine([])).toBe('');
  });
});

describe('FocusJarvisView', () => {
  it('a blank Focus shows only Jarvis, ready for a message', () => {
    render(<FocusJarvisView focusName="Billing" entries={[]} meta={meta} hasOlder={false} resolve={() => ({ open: false })}
      onOpenCard={noop} onApprove={noop} onSend={noop} onStop={noop} onLoadOlder={noop} agents={[]} worktrees={[]} />);
    expect(screen.getByRole('region', { name: /jarvis/i })).toHaveTextContent(/what should we do in billing/i);
    expect(screen.getByRole('textbox', { name: /message jarvis/i })).toBeInTheDocument();
  });
});

describe('displayOrder', () => {
  it('within a turn, Jarvis\'s text comes before its approvals, actions and cards; turns and messages keep their places', () => {
    const e = (id: string, type: string, turnId?: string) => ({ id, at, type, ...(turnId ? { turnId } : {}) }) as unknown as ChatEntry;
    const order = displayOrder([
      e('u1', 'user'), e('t1', 'turn', 'A'), e('ap', 'approval', 'A'), e('j1', 'jarvis', 'A'), e('ac', 'action', 'A'),
      e('t2', 'turn', 'B'), e('ac2', 'action', 'B'), e('j2', 'jarvis', 'B'), e('u2', 'user'), e('ac3', 'action', 'A'),
    ]).map((x) => x.id);
    expect(order).toEqual(['u1', 'j1', 't1', 'ap', 'ac', 'j2', 't2', 'ac2', 'u2', 'ac3']);
  });
});

describe('TabCard status', () => {
  it('says what the tab is doing', () => {
    const { rerender } = render(<TabCard card={{ kind: 'claude', worktree: 'api', tab: 'claude-1' }} resolved={{ open: true, worktreePath: '/w', mode: 'claude', sessionId: '1', busy: false, status: 'starting' }} onOpen={noop} />);
    expect(screen.getByTestId('tab-card')).toHaveTextContent('api · starting');
    rerender(<TabCard card={{ kind: 'claude', worktree: 'api', tab: 'claude-1' }} resolved={{ open: true, worktreePath: '/w', mode: 'claude', sessionId: '1', busy: true, status: 'working' }} onOpen={noop} />);
    expect(screen.getByTestId('tab-card')).toHaveTextContent('api · working');
    rerender(<TabCard card={{ kind: 'claude', worktree: 'api', tab: 'claude-1' }} resolved={{ open: true, worktreePath: '/w', mode: 'claude', sessionId: '1', busy: false, status: 'needs you' }} onOpen={noop} />);
    expect(screen.getByTestId('tab-card')).toHaveTextContent('api · needs you');
  });
});
