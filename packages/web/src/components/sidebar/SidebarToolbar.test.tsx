import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarToolbar } from './SidebarToolbar';

describe('SidebarToolbar', () => {
  it('offers Search and the three create actions', () => {
    const p = { onSearch: vi.fn(), onAddRepo: vi.fn(), onNewGroup: vi.fn(), onNewWorktree: vi.fn() };
    render(<SidebarToolbar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(p.onSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    expect(p.onNewGroup).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(p.onNewWorktree).toHaveBeenCalled();
    // Add repo anchors its popover to the button it came from.
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    expect(p.onAddRepo).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number), right: expect.any(Number), bottom: expect.any(Number) }));
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('title', 'Search (⌘K)');
  });
});
