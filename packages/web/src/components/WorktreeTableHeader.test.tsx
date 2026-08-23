import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeTableHeader } from './WorktreeTableHeader';

describe('WorktreeTableHeader', () => {
  it('renders all column labels', () => {
    render(<WorktreeTableHeader gridTemplate="1fr" onStartResize={vi.fn()} />);
    for (const label of ['Ticket', 'Time spent', 'Status', 'Branch', 'Changes']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // link/env/actions columns are gone — those actions live in the hub
    expect(screen.queryByText('Link')).not.toBeInTheDocument();
    expect(screen.queryByText('Env')).not.toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });

  it('fires onStartResize with the branch column id when its handle is dragged', () => {
    const onStartResize = vi.fn();
    render(<WorktreeTableHeader gridTemplate="1fr" onStartResize={onStartResize} />);
    fireEvent.mouseDown(screen.getByLabelText('Resize branch'));
    expect(onStartResize).toHaveBeenCalledWith('branch', expect.anything());
  });
});
