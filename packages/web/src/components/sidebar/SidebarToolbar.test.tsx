import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarToolbar } from './SidebarToolbar';

describe('SidebarToolbar', () => {
  it('shows the pill it is given, then New worktree; no Search or Add repo', () => {
    const p = { onNewWorktree: vi.fn() };
    render(<SidebarToolbar {...p} leading={<span>pill</span>} />);
    expect(screen.getByText('pill')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(p.onNewWorktree).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add repo' })).toBeNull();
  });
});
