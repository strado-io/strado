import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarToolbar } from './SidebarToolbar';

describe('SidebarToolbar', () => {
  it('shows the pill it is given, then Search and New worktree', () => {
    const p = { onSearch: vi.fn(), onNewWorktree: vi.fn() };
    render(<SidebarToolbar {...p} leading={<span>pill</span>} />);
    expect(screen.getByText('pill')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(p.onSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(p.onNewWorktree).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('title', 'Search (⌘K)');
    expect(screen.queryByRole('button', { name: 'Add repo' })).toBeNull();
  });
});
