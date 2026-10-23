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

describe('WorktreeRowItem: each row is a card, like a tab', () => {
  const row = (active?: boolean) => render(
    <WorktreeRowItem worktree={w} chips={[]} mr={null} onOpen={vi.fn()} className="extra" active={active}>
      <span>row</span>
    </WorktreeRowItem>,
  ).container.firstElementChild as HTMLElement;

  it('the open worktree is the raised pill (the tab bar\'s .tab-pill); the rest are flat with a faint hover', () => {
    const on = row(true);
    expect(on).toHaveClass('tab-pill', 'rounded-[11px]', 'extra');
    expect(on).toHaveAttribute('data-active', 'true');
    const off = row(false);
    expect(off).not.toHaveClass('tab-pill');
    expect(off).toHaveClass('hover:bg-white/[0.04]', 'rounded-[11px]', 'border-transparent');
  });

  it('without `active` it leaves the look to the caller (className only)', () => {
    const el = row(undefined);
    expect(el).toHaveClass('extra');
    expect(el).not.toHaveClass('tab-pill', 'rounded-[11px]');
  });
});
