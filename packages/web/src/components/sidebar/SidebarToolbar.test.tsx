import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarToolbar } from './SidebarToolbar';

describe('SidebarToolbar', () => {
  it('offers Search, Add repo and New worktree', () => {
    const p = { onSearch: vi.fn(), onAddRepo: vi.fn(), onNewWorktree: vi.fn(), focus: true, onToggleFocus: vi.fn() };
    render(<SidebarToolbar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(p.onSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(p.onNewWorktree).toHaveBeenCalled();
    // Add repo anchors its popover to the button it came from.
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    expect(p.onAddRepo).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number), right: expect.any(Number), bottom: expect.any(Number) }));
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('title', 'Search (⌘K)');
  });

  it('shows the Focus switch as pressed when on, and toggles it', () => {
    const p = { onSearch: vi.fn(), onAddRepo: vi.fn(), onNewWorktree: vi.fn(), focus: true, onToggleFocus: vi.fn() };
    const { rerender } = render(<SidebarToolbar {...p} />);
    expect(screen.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(p.onToggleFocus).toHaveBeenCalled();
    rerender(<SidebarToolbar {...p} focus={false} />);
    expect(screen.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false');
  });
});
