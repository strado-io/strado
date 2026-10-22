import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StationDto } from '../../api';
import { useMissionBox, type MissionBoxDeps } from './useMissionBox';

const st = (over: Partial<StationDto> = {}): StationDto => ({
  agentId: 'codex-2@x', alias: null, name: 'codex-2', mode: 'codex', worktreePath: '/wt/a', worktreeName: 'a', sessionId: '2',
  lifecycle: 'working', live: true, calls: [], lastActivityAt: null, activity: { text: 'Bash: npm test', at: Date.now() }, ...over,
});
const deps = (over: Partial<MissionBoxDeps> = {}): MissionBoxDeps => ({
  wsId: 'w1',
  stations: [st()],
  selectedAgentId: 'codex-2@x',
  onSelect: vi.fn(),
  openAgent: vi.fn(),
  message: vi.fn(async () => ({ delivered: 'queued' })),
  interrupt: vi.fn(async () => ({ ok: true })),
  recap: vi.fn(async () => ({ text: 'It is running the tests.' })),
  answerApproval: vi.fn(async () => ({ ok: true })),
  dismissCall: vi.fn(async () => ({})),
  answerCall: vi.fn(async () => ({})),
  shell: { risk: vi.fn(() => null), run: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) },
  ...over,
});
let api: ReturnType<typeof useMissionBox>;
function Harness({ d }: { d: MissionBoxDeps }) {
  api = useMissionBox(d);
  return <div>{api.approvals}{api.line}</div>;
}

describe('useMissionBox', () => {
  it('a selected agent: one line for the strip, never a card box', () => {
    render(<Harness d={deps()} />);
    expect(screen.getByTestId('agent-line')).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(api).not.toHaveProperty('card');
  });

  it('nothing selected and nothing pending: nothing above, no keys taken', () => {
    render(<Harness d={deps({ selectedAgentId: null })} />);
    expect(api.line).toBeNull();
    expect(api.approvals).toBeNull();
    expect(api.agentKey).toBeUndefined();
  });

  it('↵ queues the text as a message; ⌘↵ interrupts, then sends', async () => {
    const d = deps();
    render(<Harness d={d} />);
    await act(async () => { expect(api.agentKey!('send', 'also run lint')).toBe(true); });
    expect(d.message).toHaveBeenCalledWith('codex-2@x', 'also run lint');
    expect(d.interrupt).not.toHaveBeenCalled();
    await act(async () => { api.agentKey!('steer', 'stop, use pnpm'); });
    expect(d.interrupt).toHaveBeenCalledWith('codex-2@x');
    expect(d.message).toHaveBeenLastCalledWith('codex-2@x', 'stop, use pnpm');
    expect((d.interrupt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!)
      .toBeLessThan((d.message as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]!);
  });

  it('steer: when the interrupt fails, the message is not sent', async () => {
    const d = deps({ interrupt: vi.fn(async () => { throw new Error('not running'); }) });
    render(<Harness d={d} />);
    await act(async () => { api.agentKey!('steer', 'use pnpm'); });
    expect(d.message).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent("Couldn't steer: not running");
  });
  it('an older server\'s "typed" reads as sent', async () => {
    render(<Harness d={deps({ message: vi.fn(async () => ({ delivered: 'typed' })) })} />);
    await act(async () => { api.agentKey!('send', 'hi'); });
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent('sent: hi');
  });
  it('a queued message says so on the line', async () => {
    render(<Harness d={deps()} />);
    await act(async () => { api.agentKey!('send', 'also run lint'); });
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent('queued: also run lint');
  });

  it('⌃C interrupts; ⌘O opens the tab', async () => {
    const d = deps();
    render(<Harness d={d} />);
    await act(async () => { api.agentKey!('interrupt', ''); });
    expect(d.interrupt).toHaveBeenCalledWith('codex-2@x');
    act(() => { api.agentKey!('open', ''); });
    expect(d.openAgent).toHaveBeenCalledWith('codex-2@x');
  });

  it('a failure shows on the line, not as a toast', async () => {
    render(<Harness d={deps({ message: vi.fn(async () => { throw new Error('codex-2 is offline'); }) })} />);
    await act(async () => { api.agentKey!('send', 'hi'); });
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent("Couldn't send: codex-2 is offline");
  });

  it('Recap puts the answer on the line', async () => {
    const d = deps();
    render(<Harness d={d} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Summarize' })); });
    expect(d.recap).toHaveBeenCalledWith(['codex-2@x']);
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent('It is running the tests.');
  });

  it('a selected agent that left the feed: no line', () => {
    render(<Harness d={deps({ stations: [] })} />);
    expect(api.line).toBeNull();
  });

  it('Dismiss on a needs-you line dismisses its calls through the escalation route', async () => {
    const d = deps({ stations: [st({ lifecycle: 'idle', activity: null, calls: [{ id: 'e1', title: 'FYI', body: '', createdAt: 1 }] })] });
    render(<Harness d={d} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss call' })); });
    expect(d.dismissCall).toHaveBeenCalledWith('w1', 'e1');
  });

  it('typing to an agent with an open call answers that call (↵ or ⌘↵), not a new message', async () => {
    const d = deps({ stations: [st({ lifecycle: 'idle', activity: null, calls: [{ id: 'e1', title: 'Which DB?', body: '', createdAt: 1 }] })] });
    render(<Harness d={d} />);
    await act(async () => { expect(api.agentKey!('send', 'postgres')).toBe(true); });
    expect(d.answerCall).toHaveBeenCalledWith('w1', 'e1', 'postgres');
    expect(d.message).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent('replied: postgres');
    await act(async () => { api.agentKey!('steer', 'sqlite after all'); });
    expect(d.answerCall).toHaveBeenLastCalledWith('w1', 'e1', 'sqlite after all');
    expect(d.interrupt).not.toHaveBeenCalled();
    expect(d.message).not.toHaveBeenCalled();
  });

  it('a failed reply says so on the line', async () => {
    const d = deps({ answerCall: vi.fn(async () => { throw new Error('already answered'); }), stations: [st({ lifecycle: 'idle', activity: null, calls: [{ id: 'e1', title: 'Which DB?', body: '', createdAt: 1 }] })] });
    render(<Harness d={d} />);
    await act(async () => { api.agentKey!('send', 'postgres'); });
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent("Couldn't reply: already answered");
  });

  it('approvals from the given stations show above the input, even with nobody selected; a click answers by id', async () => {
    const d = deps({ selectedAgentId: null, stations: [st({ approvals: [{ id: 'ap1', kind: 'command', title: 'Bash', detail: 'rm -rf dist', createdAt: 1 }] })] });
    render(<Harness d={d} />);
    expect(screen.getByRole('group', { name: 'codex-2 wants to run a command' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); });
    expect(d.answerApproval).toHaveBeenCalledWith('w1', 'ap1', 'allow');
  });

  describe('a selected shell', () => {
    const sh = st({ agentId: 'shell-1@x', name: 'shell-1', mode: 'shell', lifecycle: 'idle', activity: null });
    it('↵ runs the text in that shell (the box\'s shell-run step), never as a message', async () => {
      const d = deps({ stations: [sh], selectedAgentId: 'shell-1@x' });
      render(<Harness d={d} />);
      await act(async () => { expect(api.agentKey!('send', 'ls -la')).toBe(true); });
      expect(d.shell.run).toHaveBeenCalledWith('shell-1@x', 'ls -la');
      expect(d.message).not.toHaveBeenCalled();
      expect(screen.getByTestId('agent-line-note')).toHaveTextContent('ran: ls -la');
    });
    it('⌘↵ does nothing for a shell (no steer)', async () => {
      const d = deps({ stations: [sh], selectedAgentId: 'shell-1@x' });
      render(<Harness d={d} />);
      await act(async () => { expect(api.agentKey!('steer', 'ls')).toBe(false); });
      expect(d.shell.run).not.toHaveBeenCalled();
      expect(d.interrupt).not.toHaveBeenCalled();
    });
    it('a destructive command asks first: the reason on the line, ↵ again (same text) runs it', async () => {
      const d = deps({ stations: [sh], selectedAgentId: 'shell-1@x', shell: { risk: vi.fn((_id: string, t: string) => (t.startsWith('rm') ? 'deletes files' : null)), run: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) } });
      render(<Harness d={d} />);
      await act(async () => { expect(api.agentKey!('send', 'rm -rf build')).toBe(false); });
      expect(d.shell.run).not.toHaveBeenCalled();
      expect(screen.getByTestId('agent-line-note')).toHaveTextContent('rm -rf build deletes files — ↵ again to run it');
      await act(async () => { expect(api.agentKey!('send', 'rm -rf build')).toBe(true); });
      expect(d.shell.run).toHaveBeenCalledWith('shell-1@x', 'rm -rf build');
    });
    it('⌃C sends Ctrl-C to the shell (the tab interrupt), not the agent interrupt', async () => {
      const d = deps({ stations: [sh], selectedAgentId: 'shell-1@x' });
      render(<Harness d={d} />);
      await act(async () => { api.agentKey!('interrupt', ''); });
      expect(d.shell.interrupt).toHaveBeenCalledWith('shell-1@x');
      expect(d.interrupt).not.toHaveBeenCalled();
    });
  });
});
