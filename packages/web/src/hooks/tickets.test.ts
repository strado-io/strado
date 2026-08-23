import { describe, expect, it } from 'vitest';
import { publishTickets, readTickets, ticketRef } from './tickets';

const issue = (key: string) => ({
  provider: 'linear' as const, key, summary: 's', status: 'Todo', category: 'new' as const,
  assignee: null, priority: null, estimate: null, url: `https://linear.app/x/issue/${key}`,
  timeSpent: null, remaining: null, timeSpentSeconds: null, remainingSeconds: null,
});

describe('tickets store', () => {
  it('ticketRef defaults missing provider to jira and uppercases', () => {
    expect(ticketRef(undefined, ' fd-1 ')).toBe('jira:FD-1');
    expect(ticketRef('linear', 'eng-45')).toBe('linear:ENG-45');
  });
  it('publish merges issues and clears resolved missing refs', () => {
    publishTickets({ missing: ['linear:ENG-9'] });
    expect(readTickets().missing.has('linear:ENG-9')).toBe(true);
    publishTickets({ issues: { 'linear:ENG-9': issue('ENG-9') } });
    expect(readTickets().missing.has('linear:ENG-9')).toBe(false);
    expect(readTickets().issues['linear:ENG-9']!.summary).toBe('s');
  });

  it('providerErrors is replaced wholesale each publish — a recovered provider clears its error', () => {
    publishTickets({ providerErrors: { linear: 'Linear rejected the token' } });
    expect(readTickets().providerErrors).toEqual({ linear: 'Linear rejected the token' });
    // next poll comes back clean — the stale error must not linger
    publishTickets({ providerErrors: {} });
    expect(readTickets().providerErrors).toEqual({});
  });
});
