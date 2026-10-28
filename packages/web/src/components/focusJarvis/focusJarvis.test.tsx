import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import type { ChatEntry, JarvisMeta } from '../../types';
import { ChatEntryView } from './ChatEntryView';
import { TabCard } from './TabCard';
import { ApprovalCard } from './ApprovalCard';
import { JarvisComposer } from './JarvisComposer';
import { FocusJarvisView, displayOrder } from './FocusJarvisView';

const at = '2026-10-26T10:00:00Z';
const meta: JarvisMeta = { focusId: 'f1', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 0, running: false, model: null, effort: null };
const approval = (over: Partial<Extract<ChatEntry, { type: 'approval' }>> = {}): Extract<ChatEntry, { type: 'approval' }> =>
  ({ id: 'a1', at, type: 'approval', turnId: 't1', action: 'run.stop', args: {}, summary: 'Stop dev in fleetx-api', state: 'pending', ...over });
const noop = () => {};
const later = async () => {};

describe('ChatEntryView', () => {
  it('renders the user bubble and the jarvis text', () => {
    render(<>
      <ChatEntryView entry={{ id: 'u1', at, type: 'user', text: 'open claude', windowId: 'w' }} resolve={() => ({ open: false })} onOpenCard={noop} onApprove={later} />
      <ChatEntryView entry={{ id: 'j1', at, type: 'jarvis', turnId: 't1', text: 'Opened **Claude**.', done: true }} resolve={() => ({ open: false })} onOpenCard={noop} onApprove={later} />
    </>);
    expect(screen.getByTestId('jarvis-user')).toHaveTextContent('open claude');
    expect(screen.getByTestId('jarvis-answer')).toHaveTextContent('Opened Claude.');
  });
  it('a failed turn says why and the fix', () => {
    render(<ChatEntryView entry={{ id: 'x', at, type: 'turn', turnId: 't1', state: 'failed', error: 'Claude is not signed in', fix: 'Run claude login' }}
      resolve={() => ({ open: false })} onOpenCard={noop} onApprove={later} />);
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
  it('posts approve or no, one answer in flight at a time; a failed one can be retried', async () => {
    let fail: (e: Error) => void = () => {};
    const onApprove = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    render(<ApprovalCard entry={approval()} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onApprove.mock.calls).toEqual([['a1', true]]);
    expect(screen.getByRole('button', { name: 'No' })).toBeDisabled();
    await act(async () => { fail(new Error('409')); });
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onApprove.mock.calls).toEqual([['a1', true], ['a1', false]]);
  });
  it('is red when dangerous, and settled once decided', () => {
    const { rerender } = render(<ApprovalCard entry={approval({ danger: 'Deletes the worktree' })} onApprove={later} />);
    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-danger', 'true');
    expect(screen.getByText('Deletes the worktree')).toBeInTheDocument();
    rerender(<ApprovalCard entry={approval({ state: 'approved', result: 'Stopped' })} onApprove={later} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByTestId('approval-card')).toHaveTextContent(/approved/i);
  });
});

describe('JarvisComposer', () => {
  const props = { running: false, agent: 'claude' as const, model: null, effort: null, onSettings: vi.fn(), onSend: vi.fn(async () => {}), onStop: vi.fn(), agents: [{ label: 'claude-1', agentId: 'claude-1@a' }], worktrees: [] };
  describe('hold to speak', () => {
    type Ev = { type: 'partial'; text: string } | { type: 'final'; text: string } | { type: 'level'; rms: number };
    let emit: (e: Ev) => void = () => {};
    const voice = { available: true, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), onEvent: (fn: (e: Ev) => void) => { emit = fn; return () => {}; } };
    beforeEach(() => { (window as { strado?: unknown }).strado = { voice }; vi.clearAllMocks(); });
    afterEach(() => { delete (window as { strado?: unknown }).strado; });

    it('the mic: hold to listen, words land after what was typed, release stops; nothing is sent', async () => {
      const onSend = vi.fn(async () => {});
      render(<JarvisComposer {...props} agents={[{ label: 'claude-1', agentId: 'c' }]} onSend={onSend} />);
      const box = screen.getByRole('textbox', { name: /message jarvis/i });
      fireEvent.change(box, { target: { value: 'please' } });
      fireEvent.pointerDown(await screen.findByRole('button', { name: 'Hold to speak' }));
      expect(voice.start).toHaveBeenCalledWith(['claude-1']);
      act(() => emit({ type: 'partial', text: 'open a shell' }));
      expect(box).toHaveValue('please open a shell');
      fireEvent.pointerUp(screen.getByRole('button', { name: /listening/i }));
      expect(voice.stop).toHaveBeenCalled();
      act(() => emit({ type: 'final', text: 'open a shell in api' }));
      expect(box).toHaveValue('please open a shell in api');
      expect(onSend).not.toHaveBeenCalled();
    });

    it('Escape while listening throws the words away', async () => {
      render(<JarvisComposer {...props} />);
      const box = screen.getByRole('textbox', { name: /message jarvis/i });
      fireEvent.pointerDown(await screen.findByRole('button', { name: 'Hold to speak' }));
      act(() => emit({ type: 'partial', text: 'never mind' }));
      fireEvent.keyDown(box, { key: 'Escape' });
      expect(voice.cancel).toHaveBeenCalled();
      expect(box).toHaveValue('');
    });

    it('Space held in the box turns into hold-to-speak; a tap just types', async () => {
      vi.useFakeTimers();
      try {
        render(<JarvisComposer {...props} />);
        const box = screen.getByRole('textbox', { name: /message jarvis/i });
        await act(async () => {}); // the bridge says it's available
        fireEvent.keyDown(box, { key: ' ' });
        fireEvent.keyUp(box, { key: ' ' });
        act(() => { vi.advanceTimersByTime(400); });
        expect(voice.start).not.toHaveBeenCalled();
        fireEvent.keyDown(box, { key: ' ' });
        act(() => { vi.advanceTimersByTime(400); });
        expect(voice.start).toHaveBeenCalled();
        fireEvent.keyUp(box, { key: ' ' });
        expect(voice.stop).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('enter sends, shift-enter makes a newline', async () => {
    const onSend = vi.fn(async () => {});
    render(<JarvisComposer {...props} onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: /message jarvis/i });
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(onSend).toHaveBeenCalledWith('line one');
    expect(box).toHaveValue('');
  });

  it('W7: the draft stays until the send succeeds, and is kept when it fails', async () => {
    let fail: (e: Error) => void = () => {};
    const onSend = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    render(<JarvisComposer {...props} onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: /message jarvis/i });
    fireEvent.change(box, { target: { value: 'deploy it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box).toHaveValue('deploy it'); // in flight: still there
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1); // no double send
    await act(async () => { fail(new Error('down')); });
    expect(box).toHaveValue('deploy it');
  });
  it('@ offers agents and sends the picked one exactly', async () => {
    const onSend = vi.fn(async () => {});
    render(<JarvisComposer {...props} onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: /message jarvis/i }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'ask @cl', selectionStart: 7 } });
    fireEvent.click(screen.getByRole('option', { name: /claude-1/ }));
    expect(box.value).toBe('ask @claude-1 ');
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(onSend).toHaveBeenCalledWith('ask @{claude-1@a}');
  });
  it('shows stop while running; other agents are coming soon', () => {
    const onStop = vi.fn();
    render(<JarvisComposer {...props} running onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^model:/i }));
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Agents' })).getByRole('tab', { name: 'Codex' }));
    expect(screen.getByRole('dialog', { name: 'Choose a model' })).toHaveTextContent("Codex can't run Jarvis yet");
  });
  it('the buttons say the model (with its agent) and the effort when it is not the default', () => {
    const { rerender } = render(<JarvisComposer {...props} />);
    expect(screen.getByRole('button', { name: 'Model: Claude default' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Effort: Default' })).not.toHaveTextContent('Default');
    rerender(<JarvisComposer {...props} model="opus" effort="high" />);
    expect(screen.getByRole('button', { name: 'Model: Claude Opus' })).toHaveTextContent('Claude Opus');
    expect(screen.getByRole('button', { name: 'Effort: High' })).toHaveTextContent('High');
    // A full model id the list doesn't name is said as it is.
    rerender(<JarvisComposer {...props} model="claude-sonnet-4-5" />);
    expect(screen.getByRole('button', { name: /^model:/i })).toHaveTextContent('Claude claude-sonnet-4-5');
  });
  it('the picker: the agent\'s models, the current one ticked; search narrows; a click or ⌘n picks and closes', () => {
    const onSettings = vi.fn();
    render(<JarvisComposer {...props} model="sonnet" effort={null} onSettings={onSettings} />);
    fireEvent.click(screen.getByRole('button', { name: /^model:/i }));
    const options = () => screen.getAllByRole('option');
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'true', 'false']);
    expect(options()[3]).toHaveTextContent('Claude Sonnet');
    expect(options()[3]).toHaveTextContent('⌘4');
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'op' } });
    expect(options()).toHaveLength(1);
    fireEvent.click(options()[0]!);
    expect(onSettings).toHaveBeenLastCalledWith({ model: 'opus' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^model:/i }));
    fireEvent.keyDown(screen.getByLabelText('Search models'), { key: '3', metaKey: true });
    expect(onSettings).toHaveBeenLastCalledWith({ model: 'opus' });
    fireEvent.click(screen.getByRole('button', { name: /^model:/i }));
    fireEvent.keyDown(screen.getByLabelText('Search models'), { key: '1', ctrlKey: true });
    expect(onSettings).toHaveBeenLastCalledWith({ model: null });
  });
  it('a starred model shows under the star; effort: Default sends null, the current one nothing', () => {
    localStorage.removeItem('strado:jarvis-model-favs');
    const onSettings = vi.fn();
    render(<JarvisComposer {...props} model="opus" effort="max" onSettings={onSettings} />);
    fireEvent.click(screen.getByRole('button', { name: /^model:/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Star Claude Haiku' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Starred' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Claude Haiku')]);
    fireEvent.click(screen.getByRole('button', { name: 'Effort: Max' }));
    expect(screen.getByRole('menuitemradio', { name: 'Max' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }));
    expect(onSettings).toHaveBeenLastCalledWith({ effort: null });
    fireEvent.click(screen.getByRole('button', { name: 'Effort: Max' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Max' }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});

describe('FocusJarvisView', () => {
  it('a blank Focus shows only Jarvis, ready for a message', () => {
    render(<FocusJarvisView focusName="Billing" entries={[]} meta={meta} hasOlder={false} resolve={() => ({ open: false })}
      onOpenCard={noop} onApprove={later} onSend={later} onStop={noop} onSettings={noop} onLoadOlder={noop} agents={[]} worktrees={[]} />);
    expect(screen.getByRole('region', { name: /jarvis/i })).toHaveTextContent(/what should we do in billing/i);
    expect(screen.getByRole('textbox', { name: /message jarvis/i })).toBeInTheDocument();
  });
});

describe('steps as lines', () => {
  type Action = Extract<ChatEntry, { type: 'action' }>;
  const step = (over: Partial<Action> = {}): Action =>
    ({ id: 's1', at, type: 'action', turnId: 'T', action: 'agent.recap', summary: 'Recap api/claude-1', ok: true, ...over });
  const view = (entries: ChatEntry[], running: boolean) => render(
    <FocusJarvisView focusName="Billing" entries={entries} meta={{ ...meta, running }} hasOlder={false} resolve={() => ({ open: false })}
      onOpenCard={noop} onApprove={later} onSend={later} onStop={noop} onSettings={noop} onLoadOlder={noop} agents={[]} worktrees={[]} />);

  it('a running step spins; with nothing spinning, the turn says Thinking…', () => {
    const { rerender } = view([step({ state: 'running' })], true);
    const line = screen.getByTestId('jarvis-action');
    expect(line).toHaveAttribute('data-state', 'running');
    expect(within(line).getByRole('status', { name: 'running' })).toBeInTheDocument();
    expect(line).toHaveTextContent('Recap api/claude-1');
    expect(screen.queryByText('Thinking…')).toBeNull();
    rerender(<FocusJarvisView focusName="Billing" entries={[step({ detail: 'It fixed the login test.' })]} meta={{ ...meta, running: true }} hasOlder={false}
      resolve={() => ({ open: false })} onOpenCard={noop} onApprove={later} onSend={later} onStop={noop} onSettings={noop} onLoadOlder={noop} agents={[]} worktrees={[]} />);
    expect(screen.getByTestId('jarvis-action')).toHaveAttribute('data-state', 'done');
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
  });

  it('a done step opens to what it gave back; a failed one says Failed and why', () => {
    view([step({ detail: 'It fixed the login test.' }), step({ id: 's2', summary: 'Run npm test in api', action: 'shell.run', ok: false, error: 'no such tab' })], false);
    const [done, failed] = screen.getAllByTestId('jarvis-action');
    expect(screen.getByTestId('jarvis-steps')).toContainElement(done!);
    expect(screen.queryByText('It fixed the login test.')).toBeNull();
    fireEvent.click(within(done!).getByRole('button'));
    expect(screen.getByText('It fixed the login test.')).toBeInTheDocument();
    expect(failed).toHaveAttribute('data-state', 'failed');
    expect(failed).toHaveTextContent('Failed');
    fireEvent.click(within(failed!).getByRole('button'));
    expect(screen.getByText('no such tab')).toBeInTheDocument();
  });

  it('an agent\'s report is one line; its answer opens rendered, not as raw markdown', () => {
    view([{ id: 'e1', at, type: 'event', text: 'claude-1 finished: The file is **LoginComponent.tsx**' }], false);
    const line = screen.getByTestId('jarvis-event');
    expect(line).toHaveTextContent('claude-1 finished');
    expect(line).not.toHaveTextContent('LoginComponent');
    fireEvent.click(within(line).getByRole('button'));
    expect(screen.getByText('LoginComponent.tsx').tagName).toBe('STRONG');
  });

  it('a decided approval is one line saying how it went; a pending one keeps its buttons', () => {
    view([
      approval({ id: 'a1', state: 'approved', result: 'It failed: No tab "browser-1"' }),
      approval({ id: 'a2', state: 'pending', summary: 'Close api/shell-1' }),
    ], false);
    const [done, pending] = screen.getAllByTestId('approval-card');
    expect(done).toHaveAttribute('data-state', 'approved');
    expect(done).toHaveTextContent('Approved · failed');
    expect(within(done!).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(pending!).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('a step left running by a turn that ended reads Stopped, not a spinner forever', () => {
    view([step({ state: 'running' })], false);
    expect(screen.getByTestId('jarvis-action')).toHaveAttribute('data-state', 'stopped');
    expect(screen.queryByRole('status', { name: 'running' })).toBeNull();
    expect(screen.queryByText('Thinking…')).toBeNull();
  });
});

describe('displayOrder', () => {
  it('within a turn, the steps come first (as agents show tool calls), then the answer, then approvals and how it ended; turns and messages keep their places', () => {
    const e = (id: string, type: string, turnId?: string) => ({ id, at, type, ...(turnId ? { turnId } : {}) }) as unknown as ChatEntry;
    const order = displayOrder([
      e('u1', 'user'), e('t1', 'turn', 'A'), e('ap', 'approval', 'A'), e('j1', 'jarvis', 'A'), e('ac', 'action', 'A'),
      e('t2', 'turn', 'B'), e('ac2', 'action', 'B'), e('j2', 'jarvis', 'B'), e('u2', 'user'), e('ac3', 'action', 'A'),
    ]).map((x) => x.id);
    expect(order).toEqual(['u1', 'ac', 'j1', 't1', 'ap', 'ac2', 'j2', 't2', 'u2', 'ac3']);
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
