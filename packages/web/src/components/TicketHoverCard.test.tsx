import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TicketHover } from './TicketHoverCard';

const JIRA_ISSUE = {
  key: 'FD-9', summary: 'Fix it', status: 'In Progress', category: 'indeterminate' as const,
  assignee: 'Ann', priority: 'High', estimate: '4h', timeSpent: '1h', remaining: '3h',
  timeSpentSeconds: 3600, remainingSeconds: 10800,
  provider: 'jira' as const, url: 'https://example.atlassian.net/browse/FD-9',
};

const LINEAR_ISSUE = {
  key: 'FD-9', summary: 'Fix it', status: 'In Progress', category: 'indeterminate' as const,
  assignee: 'Ann', priority: 'High', estimate: '3', timeSpent: null, remaining: null,
  timeSpentSeconds: null, remainingSeconds: null,
  provider: 'linear' as const, url: 'https://linear.app/team/issue/FD-9',
};

describe('TicketHover', () => {
  it('shows the Jira time-tracking block with the original estimate', () => {
    render(<TicketHover issue={JIRA_ISSUE}><span>badge</span></TicketHover>);
    fireEvent.mouseEnter(screen.getByLabelText('Jira: In Progress'));
    expect(screen.getByText(/time tracking/)).toBeInTheDocument();
    expect(screen.getByText('1h logged')).toBeInTheDocument();
    expect(screen.getByText('4h')).toBeInTheDocument();
  });

  it('shows a Linear estimate row instead of the time-tracking block', () => {
    render(<TicketHover issue={LINEAR_ISSUE}><span>badge</span></TicketHover>);
    fireEvent.mouseEnter(screen.getByLabelText('Linear: In Progress'));
    expect(screen.getByText('3 pts')).toBeInTheDocument();
    expect(screen.queryByText(/time tracking/)).not.toBeInTheDocument();
  });
});
