import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PeerDto } from '../../api';
import { FileAskDialog, askContextItems } from './FileAskDialog';

const ctx = { worktreePath: '/w/app', path: 'src/a.ts', from: 3, to: 5, snippet: 'const a = 1;\nconst b = 2;\nconst c = 3;' };
const peer = (agentId: string, worktreePath: string, extra: Partial<PeerDto> = {}): PeerDto => ({
  agentId, alias: null, mode: 'claude', worktreePath, sessionId: '1', lifecycle: 'idle', live: true, ...extra,
});

function open(peers: PeerDto[], send: (agentId: string, question: string, context: unknown[]) => Promise<void> = vi.fn(async () => {})) {
  const onClose = vi.fn();
  render(<FileAskDialog ctx={ctx} peers={peers} send={send} onClose={onClose} />);
  return { send, onClose };
}

describe('askContextItems', () => {
  it('the file with its lines (absolute, so an agent elsewhere finds it) and the snippet', () => {
    expect(askContextItems(ctx)).toEqual([
      { kind: 'file', value: '/w/app/src/a.ts:3-5', label: 'src/a.ts:3-5' },
      { kind: 'text', value: ctx.snippet, label: 'selected lines' },
    ]);
    expect(askContextItems({ ...ctx, to: 3 })[0]).toEqual({ kind: 'file', value: '/w/app/src/a.ts:3', label: 'src/a.ts:3' });
  });
});

describe('FileAskDialog', () => {
  it('this worktree\'s agent comes first and is picked; shells and stopped agents are not offered', () => {
    open([peer('codex-1@other', '/w/other', { mode: 'codex' }), peer('claude-2@app', '/w/app'), peer('shell-1@app', '/w/app', { mode: 'shell' }), peer('pi-1@app', '/w/app', { mode: 'pi', live: false })]);
    const options = screen.getAllByRole('radio');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['claude-2@app', 'codex-1@other']);
    expect(options[0]).toBeChecked();
    expect(screen.getByText('src/a.ts:3-5')).toBeInTheDocument();
  });

  it('⌘Enter sends the question as an ask with the context, then closes', async () => {
    const { send, onClose } = open([peer('claude-2@app', '/w/app')]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'why 2?' } });
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: 'Question' }), { key: 'Enter', metaKey: true }); });
    expect(send).toHaveBeenCalledWith('claude-2@app', 'why 2?', askContextItems(ctx));
    expect(onClose).toHaveBeenCalled();
  });

  it('Send is off until there is a question; a failure shows a fixed message and keeps the dialog', async () => {
    const send = vi.fn(async () => { throw new Error('server said <x>'); });
    const { onClose } = open([peer('claude-2@app', '/w/app')], send);
    const button = screen.getByRole('button', { name: 'Ask' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'hm' } });
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't send — is the agent still running?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it('no running agent: says so, nothing to send', () => {
    open([peer('shell-1@app', '/w/app', { mode: 'shell' })]);
    expect(screen.getByText(/No agent is running/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
  });

  it('Escape closes', () => {
    const { onClose } = open([peer('claude-2@app', '/w/app')]);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
