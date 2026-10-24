import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Worktree } from '../../types';
import { agentMark } from './rowBits';
import { WorktreeRowItem } from './WorktreeRowItem';

const w = { path: '/r/wt', name: 'wt', branch: 'wt', process: { status: 'idle' } } as unknown as Worktree;

describe('agentMark: waiting is a quiet amber dot, not a flag', () => {
  it('waiting → a small amber dot with the same accessible name; working → the spinner', () => {
    const waiting = { ...w, claudeStatus: 'waiting', hasClaudeSession: true, claudeSessions: ['1'] } as unknown as Worktree;
    render(<>{agentMark(waiting)}</>);
    const dot = screen.getByRole('status', { name: 'agent waiting' });
    expect(dot).toHaveAttribute('title', 'Waiting on you');
    expect(dot).not.toHaveTextContent('⚑');
    expect(dot).toHaveClass('rounded-full', 'bg-amber-400');
  });
});

describe('WorktreeRowItem: each row is a glass card', () => {
  const row = (active?: boolean, extra: { waiting?: boolean } = {}) => render(
    <WorktreeRowItem worktree={w} chips={[]} mr={null} onOpen={vi.fn()} className="extra" active={active} {...extra}>
      <span>row</span>
    </WorktreeRowItem>,
  ).container.firstElementChild as HTMLElement;

  it('resting cards are the pane glass with a hover edge; the open one is the raised glass pill, with no bar', () => {
    const off = row(false);
    expect(off).toHaveClass('glass', 'pane-card', 'rounded-xl', 'border', 'extra');
    expect(off.className).toContain('hover:border-[rgb(var(--pane-edge)/0.12)]');
    expect(off).not.toHaveClass('glass-pill');
    expect(off.querySelector('[data-testid="card-accent"]')).toBeNull();
    const on = row(true);
    expect(on).toHaveClass('glass-pill', 'rounded-xl');
    expect(on).not.toHaveClass('pane-card');
    expect(on).toHaveAttribute('data-active', 'true');
    expect(on.querySelector('[data-testid="card-accent"]')).toBeNull();
  });

  it('a waiting card keeps its normal edge (the amber is on its agent ring)', () => {
    const el = row(false, { waiting: true });
    expect(el).toHaveAttribute('data-waiting', 'true');
    expect(el.className).not.toMatch(/amber/);
  });

  it('theme colours only: no raw hex in the card classes', () => {
    expect(row(true, { waiting: true }).className).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('without `active` it leaves the look to the caller (className only)', () => {
    const el = row(undefined);
    expect(el).toHaveClass('extra');
    expect(el).not.toHaveClass('glass', 'glass-pill');
  });
});
