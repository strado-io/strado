import type { Worktree } from '../types';
import { ticketRef, type TicketIssue } from './tickets';

// A row is "settled" (nothing left to do) when the linked ticket's status
// category says done; without a ticket, the local workflow status decides.
// Settled rows sink to the bottom of the task list and render dimmed.
export function isRowSettled(w: Worktree, issues: Record<string, TicketIssue>): boolean {
  const id = w.meta?.ticketId?.trim();
  const issue = id ? issues[ticketRef(w.meta?.ticketProvider, id)] : undefined;
  if (issue) return issue.category === 'done';
  const s = w.meta?.workflowStatus;
  return s === 'verified' || s === 'done';
}
