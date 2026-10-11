import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepoAvatar, WorktreeCard } from './WorktreeCard';

describe('WorktreeCard', () => {
  it('shows repo, title, subtitle, time and the trailing slot, and opens on click', () => {
    const onOpen = vi.fn();
    render(
      <WorktreeCard
        repo={{ id: 'r1', name: 'Fleetx Dashboard' }}
        title="Clarify unexplained request"
        subtitle="master"
        time="5h"
        active={false}
        onOpen={onOpen}
        label="FD-1"
        trailing={<span data-testid="trail">✦</span>}
      />,
    );
    expect(screen.getByText('Fleetx Dashboard')).toBeInTheDocument();
    expect(screen.getByText('FD')).toBeInTheDocument(); // avatar initials
    expect(screen.getByText('Clarify unexplained request')).toBeInTheDocument();
    expect(screen.getByText('master')).toBeInTheDocument();
    expect(screen.getByText('5h')).toBeInTheDocument();
    expect(screen.getByTestId('trail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'FD-1' }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('omits the repo line and the subtitle when absent, and softens a muted card', () => {
    const { container } = render(
      <WorktreeCard title="feat/x" subtitle="" time="" active={false} muted onOpen={() => {}} label="feat/x" />,
    );
    expect(screen.queryByText('·')).toBeNull();
    expect(container.querySelector('[data-card-repo]')).toBeNull();
    expect(container.querySelector('[data-card-subtitle]')).toBeNull();
    expect(screen.getByText('feat/x')).toHaveClass('text-zinc-500');
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
});
