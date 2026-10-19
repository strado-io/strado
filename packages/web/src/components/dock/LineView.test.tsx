import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IntercomTaskDto, StationDto } from '../../api';
import { LineView } from './LineView';

const st = (over: Partial<StationDto> = {}): StationDto => ({
  agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/wt/a', worktreeName: 'a', sessionId: '1',
  lifecycle: 'idle', live: true, calls: [], lastActivityAt: null, ...over,
});
const task = (over: Partial<IntercomTaskDto> = {}): IntercomTaskDto => ({
  id: 't1', scopeId: 's', title: 'Fix the login test', body: '', ticketKey: null, worktreePath: null, dependsOn: [], status: 'open',
  createdBy: { agentId: 'human' }, claimedBy: null, createdAt: 1, updatedAt: 1, claimedAt: null, doneAt: null, ...over,
});

const stations = [
  st({ agentId: 'claude-1@api', worktreePath: '/wt/b', worktreeName: 'b' }),
  st(),
  st({ agentId: 'claude-2@app', name: 'claude-2', sessionId: '2', calls: [{ id: 'e1', title: 'Which DB?', body: '', createdAt: 1 }] }),
];

function setup(extra: Partial<Parameters<typeof LineView>[0]> = {}) {
  const on = { openStation: vi.fn(), openDetails: vi.fn(), close: vi.fn() };
  render(<LineView stations={stations} worktreePath="/wt/a" tasks={[]} onOpenStation={on.openStation} onOpenDetails={on.openDetails} onClose={on.close} {...extra} />);
  return on;
}

describe('LineView', () => {
  it('every station, grouped by worktree (this one first), each with its light', () => {
    setup();
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['a', 'b']);
    expect(within(groups[0]!).getByRole('button', { name: 'claude-2 — calling you' })).toBeInTheDocument();
    expect(within(groups[1]!).getByRole('button', { name: 'claude-1 — idle' })).toBeInTheDocument();
  });

  it('a station opens its card', () => {
    const on = setup();
    fireEvent.click(screen.getByRole('button', { name: 'claude-2 — calling you' }));
    expect(on.openStation).toHaveBeenCalledWith('claude-2@app');
  });

  it('the board lists open and claimed tasks, not finished ones', () => {
    setup({ tasks: [task(), task({ id: 't2', title: 'Ship it', status: 'claimed', claimedBy: { agentId: 'claude-2@app' } }), task({ id: 't3', title: 'Old', status: 'done' })] });
    const board = screen.getByRole('region', { name: 'Board' });
    expect(board).toHaveTextContent('Fix the login test');
    expect(board).toHaveTextContent('Ship it');
    expect(board).toHaveTextContent('claude-2');
    expect(board).not.toHaveTextContent('Old');
  });

  it('the live feed, when there is one', () => {
    setup({ feed: [{ id: 'm1', from: 'claude-2@app', to: 'claude-1@app', body: 'can you rebase?', at: 1 }] });
    expect(screen.getByRole('region', { name: 'Live' })).toHaveTextContent('claude-2 → claude-1: can you rebase?');
  });

  it('"Details" opens the full intercom panel; Esc closes the view', () => {
    const on = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(on.openDetails).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Line' }), { key: 'Escape' });
    expect(on.close).toHaveBeenCalled();
  });
});
