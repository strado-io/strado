import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StationDto } from '../../api';
import { StationLights } from './StationLights';

const st = (over: Partial<StationDto> = {}): StationDto => ({
  agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/wt/a', worktreeName: 'a', sessionId: '1',
  lifecycle: 'idle', live: true, calls: [], lastActivityAt: null, ...over,
});
const call = { id: 'e1', title: 'Which DB?', body: '', createdAt: 1 };

describe('StationLights', () => {
  const stations = [
    st(),
    st({ agentId: 'claude-2@app', name: 'claude-2', alias: 'reviewer', sessionId: '2', calls: [call] }),
    st({ agentId: 'shell-1@app', name: 'shell-1', mode: 'shell', lifecycle: 'working' }),
    st({ agentId: 'claude-1@api', worktreePath: '/wt/b', worktreeName: 'b' }),
    st({ agentId: 'codex-1@api', name: 'codex-1', mode: 'codex', worktreePath: '/wt/b', worktreeName: 'b', live: false }),
  ];

  it('one light per tab in this worktree, named in plain words; the rest is "+N"', () => {
    render(<StationLights stations={stations} worktreePath="/wt/a" onOpenStation={vi.fn()} onOpenLine={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'reviewer — calling you' })).toHaveAttribute('data-light', 'calling');
    expect(screen.getByRole('button', { name: 'claude-1 — idle' })).toHaveAttribute('data-light', 'idle');
    expect(screen.getByRole('button', { name: 'shell-1 — working' })).toHaveAttribute('data-light', 'working');
    expect(screen.getByRole('button', { name: '2 stations in other worktrees' })).toHaveTextContent('+2');
  });

  it('a click opens that station; "+N" opens the line', () => {
    const onOpenStation = vi.fn();
    const onOpenLine = vi.fn();
    render(<StationLights stations={stations} worktreePath="/wt/a" onOpenStation={onOpenStation} onOpenLine={onOpenLine} />);
    fireEvent.click(screen.getByRole('button', { name: 'reviewer — calling you' }));
    expect(onOpenStation).toHaveBeenCalledWith('claude-2@app');
    fireEvent.click(screen.getByRole('button', { name: '2 stations in other worktrees' }));
    expect(onOpenLine).toHaveBeenCalled();
  });

  it('a call in another worktree flags the count, never opens anything by itself', () => {
    const away = [st(), st({ agentId: 'claude-1@api', worktreePath: '/wt/b', worktreeName: 'b', calls: [call] })];
    render(<StationLights stations={away} worktreePath="/wt/a" onOpenStation={vi.fn()} onOpenLine={vi.fn()} />);
    const count = screen.getByRole('button', { name: '1 station in other worktrees, 1 calling you' });
    expect(count).toHaveAttribute('data-calling', 'true');
  });

  it('nothing in other worktrees: no count', () => {
    render(<StationLights stations={[st()]} worktreePath="/wt/a" onOpenStation={vi.fn()} onOpenLine={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /other worktrees/ })).not.toBeInTheDocument();
  });
});
