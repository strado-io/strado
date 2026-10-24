import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepoAvatar, WorktreeCard, repoAccent } from './WorktreeCard';

describe('WorktreeCard', () => {
  it('two lines: the name with its time; then repo · branch with the meta slot; opens on click anywhere', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <WorktreeCard
        repo={{ id: 'r1', name: 'Fleetx Dashboard' }}
        title="Clarify unexplained request"
        subtitle="master"
        time="5h"
        active={false}
        onOpen={onOpen}
        label="FD-1"
        agents={<span data-testid="agents">●</span>}
        meta={<span data-testid="meta">+3 -1</span>}
      />,
    );
    const [line1, line2] = Array.from(container.firstElementChild!.children) as HTMLElement[];
    expect(line1).toHaveTextContent(/^Clarify unexplained request●5h$/);
    expect(line2).toHaveTextContent(/^Fleetx Dashboard·master\+3 -1$/);
    expect(container.querySelector('[data-card-subtitle]')).toHaveClass('font-mono');
    // No letter tile on the card any more: the repo's colour is a dot before its name.
    expect(container.querySelector('[data-testid="repo-tile"]')).toBeNull();
    expect(screen.getByTestId('card-repo-dot')).toHaveClass(repoAccent('r1'), 'rounded-full');
    expect(screen.queryByText('FD')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'FD-1' }));
    fireEvent.click(screen.getByText('master'));
    fireEvent.click(screen.getByText('Fleetx Dashboard'));
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('only 13px and 11px type: the name 13px medium, everything else 11px', () => {
    const { container } = render(
      <WorktreeCard repo={{ id: 'r1', name: 'repo' }} title="Fix login" subtitle="FD-12" time="2h" active={false} onOpen={() => {}} label="x" />,
    );
    expect(screen.getByText('Fix login')).toHaveClass('text-[13px]', 'font-medium');
    expect(screen.getByText('2h')).toHaveClass('text-[11px]', 'text-zinc-500');
    expect(container.querySelector('[data-card-repo]')!.parentElement).toHaveClass('text-[11px]');
    expect(container.innerHTML).not.toMatch(/text-\[(9|10)px\]/);
  });

  it('omits the repo and the branch when absent, and softens a muted card', () => {
    const { container } = render(
      <WorktreeCard title="feat/x" subtitle="" time="" active={false} muted onOpen={() => {}} label="feat/x" />,
    );
    expect(screen.queryByText('·')).toBeNull();
    expect(container.querySelector('[data-card-repo]')).toBeNull();
    expect(container.querySelector('[data-card-subtitle]')).toBeNull();
    expect(screen.getByText('feat/x')).toHaveClass('text-zinc-500');
  });

  it('the name: zinc-200 at rest, zinc-100 on the open worktree', () => {
    const { rerender } = render(<WorktreeCard title="master" subtitle="" time="" active={false} onOpen={() => {}} label="master" />);
    expect(screen.getByText('master')).toHaveClass('text-zinc-200');
    rerender(<WorktreeCard title="master" subtitle="" time="" active onOpen={() => {}} label="master" />);
    expect(screen.getByText('master')).toHaveClass('text-zinc-100');
  });

  it('the branch only when it says something the name does not', () => {
    const { container, rerender } = render(<WorktreeCard repo={{ id: 'r', name: 'repo' }} title="main" subtitle="main" time="" active={false} onOpen={() => {}} label="main" />);
    expect(container.querySelector('[data-card-subtitle]')).toBeNull();
    expect(screen.queryByText('·')).toBeNull();
    rerender(<WorktreeCard title="Main " subtitle=" main" time="" active={false} onOpen={() => {}} label="main" />);
    expect(container.querySelector('[data-card-subtitle]')).toBeNull();
    rerender(<WorktreeCard title="Fix login" subtitle="FD-12-login" time="" active={false} onOpen={() => {}} label="x" />);
    expect(container.querySelector('[data-card-subtitle]')).toHaveTextContent('FD-12-login');
  });

  it('tells assistive tech when an agent works or waits', () => {
    const { rerender } = render(<WorktreeCard title="x" subtitle="" time="" active={false} onOpen={() => {}} label="x" agentState="working" />);
    expect(screen.getByRole('status', { name: 'agent working' })).toHaveClass('sr-only');
    rerender(<WorktreeCard title="x" subtitle="" time="" active={false} onOpen={() => {}} label="x" agentState="waiting" />);
    expect(screen.getByRole('status', { name: 'agent waiting' })).toBeInTheDocument();
    rerender(<WorktreeCard title="x" subtitle="" time="" active={false} onOpen={() => {}} label="x" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a repo keeps one accent colour, the same hue as its avatar', () => {
    expect(repoAccent('r1')).toBe(repoAccent('r1'));
    expect(repoAccent('r1')).toMatch(/^bg-\w+-400$/);
    const tile = render(<RepoAvatar id="r1" name="x" />).container.firstElementChild!;
    expect(tile.className).toContain(repoAccent('r1').replace('bg-', '').replace('-400', ''));
  });

  it('gives a repo a stable two-letter avatar coloured by its id', () => {
    const a = render(<RepoAvatar id="r1" name="Fleetx Dashboard" />).container.firstElementChild!;
    const b = render(<RepoAvatar id="r1" name="Fleetx Dashboard" />).container.firstElementChild!;
    const c = render(<RepoAvatar id="strado-website" name="strado" />).container.firstElementChild!;
    expect(a.textContent).toBe('FD');
    expect(c.textContent).toBe('ST');
    expect(a.className).toBe(b.className);
    expect(a.className).not.toBe(c.className);
  });

  it('the repo avatar is a tab-style tile: 20px, rounded 6px, tinted, an inset ring', () => {
    const tile = render(<RepoAvatar id="r1" name="Fleetx Dashboard" />).container.firstElementChild!;
    expect(tile).toHaveAttribute('data-testid', 'repo-tile');
    expect(tile).toHaveClass('h-5', 'w-5', 'rounded-[6px]', 'ring-1', 'ring-inset');
  });
});
