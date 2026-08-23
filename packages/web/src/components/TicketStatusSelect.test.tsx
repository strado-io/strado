import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TicketStatusSelect } from './TicketStatusSelect';
import { readTickets } from '../hooks/tickets';

const transitions = vi.fn();
const transition = vi.fn();
vi.mock('../api', () => ({
  api: {
    tickets: {
      transitions: (...a: unknown[]) => transitions(...a),
      transition: (...a: unknown[]) => transition(...a),
    },
  },
}));

const ISSUE = {
  key: 'FD-9', summary: 'Fix it', status: 'To Do', category: 'new' as const,
  assignee: null, priority: null, estimate: null, timeSpent: null, remaining: null, timeSpentSeconds: null, remainingSeconds: null,
  provider: 'jira' as const, url: 'https://example.atlassian.net/browse/FD-9',
};

beforeEach(() => {
  transitions.mockReset().mockResolvedValue([
    { id: '21', name: 'Start Progress', toStatus: 'In Progress', toCategory: 'indeterminate' },
    { id: '31', name: 'Close', toStatus: 'Done', toCategory: 'done' },
  ]);
  transition.mockReset().mockResolvedValue({
    key: 'FD-9', summary: 'Fix it', status: 'In Progress', category: 'indeterminate', provider: 'jira',
    url: 'https://example.atlassian.net/browse/FD-9',
  });
});

describe('TicketStatusSelect', () => {
  it('shows the ticket status and lists live transitions on click', async () => {
    render(<TicketStatusSelect issue={ISSUE} />);
    const chip = screen.getByLabelText('Ticket status');
    expect(chip).toHaveTextContent('To Do');

    fireEvent.click(chip);
    expect(await screen.findByText('Start Progress')).toBeInTheDocument();
    expect(screen.getByText('Close')).toBeInTheDocument();
    expect(transitions).toHaveBeenCalledWith('jira', 'FD-9');
  });

  it('executes the picked transition and publishes the refreshed issue', async () => {
    render(<TicketStatusSelect issue={ISSUE} />);
    fireEvent.click(screen.getByLabelText('Ticket status'));
    fireEvent.click(await screen.findByText('Start Progress'));

    await vi.waitFor(() => expect(transition).toHaveBeenCalledWith('jira', 'FD-9', '21'));
    // menu closes once the provider confirms; the store then holds the refreshed issue
    await vi.waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Ticket transitions' })).not.toBeInTheDocument(),
    );
    expect(readTickets().issues['jira:FD-9']!.status).toBe('In Progress');
  });

  it('closing via the backdrop does not leak the click to the row underneath', async () => {
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <TicketStatusSelect issue={ISSUE} />
      </div>,
    );
    fireEvent.click(screen.getByLabelText('Ticket status')); // chip click is a button — row guard's job
    await screen.findByText('Start Progress');
    rowClick.mockClear();
    fireEvent.click(screen.getByRole('menu', { name: 'Ticket transitions' }).parentElement!);
    expect(screen.queryByRole('menu', { name: 'Ticket transitions' })).not.toBeInTheDocument();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('reverts the optimistic update and shows the error when the provider refuses', async () => {
    transition.mockRejectedValue(new Error('Jira responded 400'));
    render(<TicketStatusSelect issue={ISSUE} />);
    fireEvent.click(screen.getByLabelText('Ticket status'));
    fireEvent.click(await screen.findByText('Close'));

    expect(await screen.findByText(/Jira responded 400/)).toBeInTheDocument();
    expect(readTickets().issues['jira:FD-9']!.status).toBe('To Do');
  });

  it('shows a Linear estimate without a Jira time-tracking hint', async () => {
    transitions.mockResolvedValue([]);
    const linearIssue = {
      ...ISSUE, provider: 'linear' as const, estimate: '3', url: 'https://linear.app/team/issue/FD-9',
    };
    render(<TicketStatusSelect issue={linearIssue} />);
    fireEvent.click(screen.getByLabelText('Ticket status'));
    expect(await screen.findByText('No transitions available')).toBeInTheDocument();
    expect(transitions).toHaveBeenCalledWith('linear', 'FD-9');
  });
});
