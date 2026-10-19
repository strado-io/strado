import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StationDto } from '../../api';
import { StationCard } from './StationCard';

const st = (over: Partial<StationDto> = {}): StationDto => ({
  agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/wt/a', worktreeName: 'a', sessionId: '1',
  lifecycle: 'idle', live: true, calls: [], lastActivityAt: null, ...over,
});
const call = { id: 'e1', title: 'Which database?', body: 'Postgres or SQLite for the cache?', createdAt: 1 };

function setup(station: StationDto, recent?: { id: string; from: string; to: string; body: string; at: number }[]) {
  const on = {
    answer: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined),
    talk: vi.fn().mockResolvedValue(undefined), openTab: vi.fn(), close: vi.fn(),
  };
  const el = (s: StationDto) => <StationCard station={s} recent={recent} onAnswer={on.answer} onDismiss={on.dismiss} onTalk={on.talk} onOpenTab={on.openTab} onClose={on.close} />;
  const { rerender } = render(el(station));
  return { ...on, rerender: (s: StationDto) => rerender(el(s)) };
}

describe('StationCard', () => {
  it('header: name · worktree · status in plain words', () => {
    setup(st({ alias: 'reviewer', lifecycle: 'working' }));
    expect(screen.getByRole('dialog', { name: 'reviewer' })).toHaveTextContent('reviewer');
    expect(screen.getByRole('dialog')).toHaveTextContent('a');
    expect(screen.getByRole('dialog')).toHaveTextContent('working');
  });

  it('a call: shows the question; ⏎ answers it (resolve) and closes', async () => {
    const on = setup(st({ calls: [call] }));
    expect(screen.getByText('Which database?')).toBeInTheDocument();
    expect(screen.getByText('Postgres or SQLite for the cache?')).toBeInTheDocument();
    const reply = screen.getByLabelText('Answer claude-1');
    expect(document.activeElement).toBe(reply);
    fireEvent.change(reply, { target: { value: 'postgres' } });
    fireEvent.keyDown(reply, { key: 'Enter' });
    await waitFor(() => expect(on.answer).toHaveBeenCalledWith('e1', 'postgres'));
    await waitFor(() => expect(on.close).toHaveBeenCalled());
  });

  it('"Hang up" dismisses the call', async () => {
    const on = setup(st({ calls: [call] }));
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    await waitFor(() => expect(on.dismiss).toHaveBeenCalledWith('e1'));
  });

  it('not calling: a talk line; ⏎ talks (typed into its prompt) and closes', async () => {
    const on = setup(st());
    const talk = screen.getByLabelText('Talk to claude-1');
    fireEvent.change(talk, { target: { value: 'run the tests' } });
    fireEvent.keyDown(talk, { key: 'Enter' });
    await waitFor(() => expect(on.talk).toHaveBeenCalledWith('run the tests'));
    await waitFor(() => expect(on.close).toHaveBeenCalled());
  });

  it('a permission prompt is a call with no question: it says so, and ⌘⏎ opens the tab', () => {
    const on = setup(st({ lifecycle: 'needs_input', needsYou: true }));
    expect(screen.getByText(/waiting for permission/i)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', metaKey: true });
    expect(on.openTab).toHaveBeenCalled();
  });

  it('⌘⏎ from the talk line opens its tab instead of talking; Esc closes the card', () => {
    const on = setup(st());
    const talk = screen.getByLabelText('Talk to claude-1');
    fireEvent.keyDown(talk, { key: 'Enter', metaKey: true });
    expect(on.openTab).toHaveBeenCalled();
    expect(on.talk).not.toHaveBeenCalled();
    fireEvent.keyDown(talk, { key: 'Escape' });
    expect(on.close).toHaveBeenCalled();
  });

  it('a failed answer keeps the card and the text, and says why', async () => {
    const on = setup(st({ calls: [call] }));
    on.answer.mockRejectedValueOnce(new Error('That call was already answered'));
    const reply = screen.getByLabelText('Answer claude-1');
    fireEvent.change(reply, { target: { value: 'postgres' } });
    await act(async () => { fireEvent.keyDown(reply, { key: 'Enter' }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('That call was already answered');
    expect(reply).toHaveValue('postgres');
    expect(on.close).not.toHaveBeenCalled();
  });

  it('recent messages (listen), when there are any', () => {
    setup(st(), [{ id: 'm1', from: 'claude-2@app', to: 'claude-1@app', body: 'can you rebase?', at: 1 }]);
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText(/can you rebase\?/)).toBeInTheDocument();
  });

  it('the call is pinned when the card opens: if it ends and another comes, Enter resolves nothing', async () => {
    const on = setup(st({ calls: [call] }));
    const reply = screen.getByLabelText('Answer claude-1');
    fireEvent.change(reply, { target: { value: 'postgres' } });
    on.rerender(st({ calls: [{ ...call, id: 'e2', title: 'Deploy to prod?' }] }));
    expect(screen.getByText('That call ended')).toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' }); });
    fireEvent.keyDown(reply, { key: 'Enter' });
    expect(on.answer).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Hang up' })).not.toBeInTheDocument();
  });

  it('a shell station has no talk line (nothing reads its inbox): Open tab only', () => {
    setup(st({ agentId: 'shell-1@app', name: 'shell-1', mode: 'shell' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open tab ⌘⏎' })).toBeInTheDocument();
  });
});
