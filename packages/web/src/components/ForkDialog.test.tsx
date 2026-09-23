import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ForkDialog } from './ForkDialog';

const source = { agentId: 'claude-1@repo', mode: 'claude' as const, worktreePath: '/w/repo', alias: null };
const peers = [
  { agentId: 'claude-1@repo', alias: null, mode: 'claude' as const, worktreePath: '/w/repo', sessionId: '1', lifecycle: 'idle', live: true },
  { agentId: 'shell-1@repo', alias: 'bob', mode: 'shell' as const, worktreePath: '/w/repo', sessionId: '1', lifecycle: 'idle', live: true },
  { agentId: 'codex-1@other', alias: null, mode: 'codex' as const, worktreePath: '/w/other', sessionId: '1', lifecycle: 'idle', live: false },
];
const tasks = [
  { id: 'T1', scopeId: 'default', title: 'write tests', body: '', ticketKey: null, worktreePath: null, dependsOn: [], status: 'open' as const, createdBy: { agentId: 'human' }, claimedBy: null, createdAt: 1, updatedAt: 1, claimedAt: null, doneAt: null },
  { id: 'T2', scopeId: 'default', title: 'done one', body: '', ticketKey: null, worktreePath: null, dependsOn: [], status: 'done' as const, createdBy: { agentId: 'human' }, claimedBy: null, createdAt: 1, updatedAt: 1, claimedAt: null, doneAt: 2 },
];
const setup = (over: Partial<Parameters<typeof ForkDialog>[0]> = {}) => {
  const onSubmit = vi.fn(); const onCancel = vi.fn();
  render(<ForkDialog source={source} peers={peers} tasks={tasks} busy={false} error={null} onSubmit={onSubmit} onCancel={onCancel} {...over} />);
  return { onSubmit, onCancel };
};

describe('ForkDialog', () => {
  it('lists live peers except the source, defaults to the first, and submits to=<peer> with notes and task', () => {
    const { onSubmit } = setup();
    const peer = screen.getByRole('combobox', { name: 'Peer' });
    expect(Array.from((peer as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['bob (shell · repo)']);
    fireEvent.change(screen.getByRole('textbox', { name: /notes for the target/i }), { target: { value: 'migrate DB' } });
    const task = screen.getByRole('combobox', { name: 'Task' });
    expect(Array.from((task as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['No task', 'write tests']);
    fireEvent.change(task, { target: { value: 'T1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    expect(onSubmit).toHaveBeenCalledWith({ source: 'claude-1@repo', to: 'shell-1@repo', notes: 'migrate DB', taskId: 'T1' });
  });
  it('New tab defaults to the source mode, shows the fixed worktree, and submits newTab.mode', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'New tab' }));
    expect(screen.getByRole('button', { name: 'Claude' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Opens in repo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    expect(onSubmit).toHaveBeenCalledWith({ source: 'claude-1@repo', newTab: { mode: 'codex' }, notes: '' });
  });
  it('with no other live peer the Live peer radio is disabled and New tab is preselected', () => {
    setup({ peers: [peers[0]!, peers[2]!] });
    expect(screen.getByRole('radio', { name: 'Live peer' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'New tab' })).toBeChecked();
    expect(screen.getByText('No other live agents in this workspace')).toBeInTheDocument();
  });
  it('notes over 4096 bytes disable Fork and show the byte count', () => {
    setup();
    fireEvent.change(screen.getByRole('textbox', { name: /notes for the target/i }), { target: { value: 'é'.repeat(2049) } }); // 4098 bytes
    expect(screen.getByText('4098 / 4096 bytes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fork' })).toBeDisabled();
  });
  it('busy disables both buttons and blocks Escape; error is announced', () => {
    const { onCancel } = setup({ busy: true, error: 'target gone' });
    expect(screen.getByRole('button', { name: 'Forking…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('target gone');
  });
  it('Escape cancels when idle', () => {
    const { onCancel } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
  it('autofocuses the notes textarea on open, so keyboard/screen-reader users land inside the dialog', () => {
    setup();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Notes for the target' }));
  });
  it('reconciles selectedPeer when the live peer list changes under the dialog', () => {
    const pi = { agentId: 'pi-1@repo', alias: 'pia', mode: 'pi' as const, worktreePath: '/w/repo', sessionId: '1', lifecycle: 'idle', live: true };
    const twoLive = [peers[0]!, peers[1]!, pi];
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ForkDialog source={source} peers={twoLive} tasks={tasks} busy={false} error={null} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    expect((screen.getByRole('combobox', { name: 'Peer' }) as HTMLSelectElement).value).toBe('shell-1@repo');
    // The previously-selected peer (bob) drops out of the live list.
    rerender(
      <ForkDialog source={source} peers={[peers[0]!, pi]} tasks={tasks} busy={false} error={null} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    const select = screen.getByRole('combobox', { name: 'Peer' }) as HTMLSelectElement;
    expect(select.value).toBe('pi-1@repo');
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ to: 'pi-1@repo' }));
  });
  it('disables Fork in peer mode once the live peer list becomes empty', () => {
    const { rerender } = render(
      <ForkDialog source={source} peers={peers} tasks={tasks} busy={false} error={null} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    rerender(
      <ForkDialog source={source} peers={[peers[0]!]} tasks={tasks} busy={false} error={null} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Fork' })).toBeDisabled();
  });
});
