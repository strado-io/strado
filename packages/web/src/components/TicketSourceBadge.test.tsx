import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TicketSourceBadge } from './TicketSourceBadge';
import { publishTickets } from '../hooks/tickets';

beforeEach(() => {
  publishTickets({ configured: [] });
});

describe('TicketSourceBadge', () => {
  it('renders nothing with a single connected provider', () => {
    publishTickets({ configured: ['jira'] });
    const { container } = render(<TicketSourceBadge provider="jira" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a colored dot once a second provider is connected', () => {
    publishTickets({ configured: ['jira', 'linear'] });
    render(<TicketSourceBadge provider="linear" />);
    expect(screen.getByTitle('Linear')).toBeInTheDocument();
  });

  it('picks the tone per provider', () => {
    publishTickets({ configured: ['jira', 'linear'] });
    render(<TicketSourceBadge provider="jira" />);
    expect(screen.getByTitle('Jira')).toHaveClass('bg-blue-500');
  });
});
