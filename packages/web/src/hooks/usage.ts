import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { UsageAccount, UsageSummary } from '../types';

export type UsageRange = 7 | 30 | 90;

export type UsageState = {
  summary: UsageSummary | null;
  accounts: UsageAccount[];
  /** True until the first fetch for this workspace and range settles. */
  loading: boolean;
  /** True while a refresh runs behind data that is already on screen. */
  refreshing: boolean;
  error: string | null;
};

const EMPTY: UsageState = {
  summary: null, accounts: [], loading: true, refreshing: false, error: null,
};

/** Quota resets on a 5h/weekly clock, so anything faster is wasted work. */
const POLL_MS = 5 * 60_000;

/**
 * Workspace usage: priced token history plus the per-account quota cards.
 *
 * The two calls are independent by design — a locked Keychain must not cost the
 * user their cost history, so a failed accounts fetch leaves the summary alone.
 */
export function useUsage(wsId: string, days: UsageRange) {
  const [state, setState] = useState<UsageState>(EMPTY);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const destinationRef = useRef({ wsId, days });
  const requestSeq = useRef(0);

  const refresh = useCallback(() => setRefreshSeq((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    const workspaceChanged = destinationRef.current.wsId !== wsId;
    const rangeChanged = destinationRef.current.days !== days;
    destinationRef.current = { wsId, days };
    const requestId = ++requestSeq.current;

    setState((current) => (workspaceChanged
      ? { ...EMPTY }
      : rangeChanged || !current.summary
        ? { ...current, loading: true, refreshing: false, error: null }
        : { ...current, refreshing: true, error: null }));

    // Optional at runtime so a partial api mock in an unrelated test degrades
    // to an empty page instead of throwing.
    const summaryCall = api.usage?.summary(wsId, days) ?? Promise.resolve(null);
    const accountsCall = api.usage?.accounts(wsId) ?? Promise.resolve([]);

    summaryCall.then((summary) => {
      if (!alive || requestId !== requestSeq.current) return;
      setState((current) => ({ ...current, summary, loading: false, refreshing: false, error: null }));
    }).catch((error: unknown) => {
      if (!alive || requestId !== requestSeq.current) return;
      setState((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    });

    accountsCall.then((accounts) => {
      if (!alive || requestId !== requestSeq.current) return;
      setState((current) => ({ ...current, accounts }));
    }).catch(() => {
      if (!alive || requestId !== requestSeq.current) return;
      setState((current) => ({ ...current, accounts: [] }));
    });

    return () => { alive = false; };
  }, [wsId, days, refreshSeq]);

  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { ...state, refresh };
}

/**
 * Quota cards on their own, for the toolbar's usage control.
 *
 * Shared across every open worktree hub: the module-level cache means ten tabs
 * make one request, and a tab opened mid-window paints from the last answer
 * instead of waiting for its own.
 */
type AccountsCache = { wsId: string; at: number; accounts: UsageAccount[]; inFlight: Promise<UsageAccount[]> | null };

const accountsCache: AccountsCache = { wsId: '', at: 0, accounts: [], inFlight: null };

function loadAccounts(wsId: string): Promise<UsageAccount[]> {
  const fresh = accountsCache.wsId === wsId && Date.now() - accountsCache.at < POLL_MS;
  if (fresh) return Promise.resolve(accountsCache.accounts);
  if (accountsCache.inFlight && accountsCache.wsId === wsId) return accountsCache.inFlight;
  const request = (api.usage?.accounts(wsId) ?? Promise.resolve([]))
    .then((accounts) => {
      accountsCache.wsId = wsId;
      accountsCache.at = Date.now();
      accountsCache.accounts = accounts;
      return accounts;
    })
    .catch(() => [] as UsageAccount[])
    .finally(() => { accountsCache.inFlight = null; });
  accountsCache.wsId = wsId;
  accountsCache.inFlight = request;
  return request;
}

/** Test seam: drops the shared cache so each case starts cold. */
export function resetQuotaCache(): void {
  accountsCache.wsId = '';
  accountsCache.at = 0;
  accountsCache.accounts = [];
  accountsCache.inFlight = null;
}

export function useQuotaAccounts(wsId: string) {
  const [accounts, setAccounts] = useState<UsageAccount[]>(
    accountsCache.wsId === wsId ? accountsCache.accounts : [],
  );

  useEffect(() => {
    let alive = true;
    const load = () => loadAccounts(wsId).then((next) => { if (alive) setAccounts(next); });
    load();
    const timer = setInterval(() => {
      accountsCache.at = 0;
      load();
    }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [wsId]);

  return accounts;
}
