import { useEffect, useState } from 'react';
import type { TicketIssueDto, TicketProviderId } from '../api';

export type TicketIssue = TicketIssueDto;

export type TicketsState = {
  jiraBaseUrl: string | null;
  configured: TicketProviderId[];
  issues: Record<string, TicketIssueDto>;
  // Ticket ids the server confirmed do NOT exist (worktrees whose
  // ids only look like ticket keys). Rows use this to drop the dead link.
  missing: Set<string>;
  // The batch endpoint's per-provider `errors` from the most recent poll —
  // one provider's outage (e.g. a revoked Linear token) surfaced without
  // blanking the others. Replaced wholesale on every publish (not merged)
  // so a provider that recovers has its error cleared automatically.
  providerErrors: Partial<Record<TicketProviderId, string>>;
};

// Module-level store: the Dashboard polls for all rows and
// publishes here; any component (rows, dialogs) subscribes via useTickets().
let state: TicketsState = { jiraBaseUrl: null, configured: [], issues: {}, missing: new Set(), providerErrors: {} };
const EVENT = 'strado:tickets';

export function providerLabel(provider: TicketProviderId): string {
  return provider === 'jira' ? 'Jira' : 'Linear';
}

export function ticketRef(provider: TicketProviderId | null | undefined, key: string): string {
  return `${provider ?? 'jira'}:${key.trim().toUpperCase()}`;
}

export function publishTickets(patch: {
  jiraBaseUrl?: string | null;
  configured?: TicketProviderId[];
  issues?: Record<string, TicketIssueDto>;
  missing?: string[];
  providerErrors?: Partial<Record<TicketProviderId, string>>;
}): void {
  const issues = patch.issues ? { ...state.issues, ...patch.issues } : state.issues;
  const missing = new Set(state.missing);
  for (const k of patch.missing ?? []) missing.add(k);
  // an issue that now resolves is no longer missing (ticket created later)
  for (const k of Object.keys(patch.issues ?? {})) missing.delete(k);
  state = {
    jiraBaseUrl: patch.jiraBaseUrl !== undefined ? patch.jiraBaseUrl : state.jiraBaseUrl,
    configured: patch.configured ?? state.configured,
    issues,
    missing,
    // Replaced, not merged: each poll's errors object is the full, current
    // picture — a provider absent from it has recovered.
    providerErrors: patch.providerErrors !== undefined ? patch.providerErrors : state.providerErrors,
  };
  window.dispatchEvent(new Event(EVENT));
}

export function readTickets(): TicketsState {
  return state;
}

export function useTickets(): TicketsState {
  const [snap, setSnap] = useState<TicketsState>(state);
  useEffect(() => {
    const update = () => setSnap(state);
    window.addEventListener(EVENT, update);
    return () => window.removeEventListener(EVENT, update);
  }, []);
  return snap;
}

export function jiraIssueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}`;
}
