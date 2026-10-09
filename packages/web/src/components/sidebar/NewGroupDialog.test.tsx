import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishTickets } from '../../hooks/tickets';
import { NewGroupDialog } from './NewGroupDialog';

const myIssues = vi.fn();
vi.mock('../../api', () => ({ api: { tickets: { myIssues: (...a: unknown[]) => myIssues(...a) } } }));

const candidates = [
  { pinId: 'local:/api/a', label: 'fx-412', repoName: 'api' },
  { pinId: 'local:/web/b', label: 'billing', repoName: 'web' },
];

beforeEach(() => {
  myIssues.mockReset().mockResolvedValue([]);
  publishTickets({ configured: [] });
});

describe('NewGroupDialog', () => {
  it('creates a group with a custom name and the worktrees ticked', () => {
    const onCreate = vi.fn();
    render(<NewGroupDialog candidates={candidates} onCreate={onCreate} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Group name' }), { target: { value: '  Payments revamp ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'web billing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    expect(onCreate).toHaveBeenCalledWith('Payments revamp', ['local:/web/b']);
  });

  it('needs a name', () => {
    render(<NewGroupDialog candidates={candidates} onCreate={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
  });

  it('names the group after a picked ticket', async () => {
    publishTickets({ configured: ['jira'] });
    myIssues.mockResolvedValue([{ key: 'FD-123', summary: 'Fix login', status: 'To Do', provider: 'jira', url: '' }]);
    render(<NewGroupDialog candidates={candidates} onCreate={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add ticket' }));
    fireEvent.click(await screen.findByRole('option', { name: /FD-123/ }));
    expect(screen.getByRole('textbox', { name: 'Group name' })).toHaveValue('FD-123 Fix login');
  });

  it('filters the worktree list', () => {
    render(<NewGroupDialog candidates={candidates} onCreate={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter worktrees' }), { target: { value: 'bill' } });
    expect(screen.queryByRole('checkbox', { name: 'api fx-412' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'web billing' })).toBeInTheDocument();
  });
});
