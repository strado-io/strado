import { api, type TicketIssueDto, type TicketProviderId } from '../../api';

// Your open tickets across the configured providers, loaded once per session
// the first time something asks. A failed provider contributes nothing
// rather than failing the whole list.
let cache: Promise<TicketIssueDto[]> | null = null;

export function loadMyTickets(configured: TicketProviderId[]): Promise<TicketIssueDto[]> {
  if (configured.length === 0) return Promise.resolve([]);
  if (!cache) {
    cache = Promise.all(configured.map((p) => api.tickets.myIssues(p).catch(() => [] as TicketIssueDto[])))
      .then((lists) => lists.flat());
  }
  return cache;
}

export function __resetMyTickets() { cache = null; }
