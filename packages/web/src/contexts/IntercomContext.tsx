import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { api } from '../api';
import type { ForkCreateInput, ForkDto } from '../api';
import { subscribeIntercom, subscribeWorktrees } from '../eventStream';
import { INITIAL_INTERCOM, collectionOf, intercomReducer, type IntercomState } from '../hooks/intercom';

export type IntercomContextValue = IntercomState & {
  refresh(): Promise<void>;
  resolve(id: string, resolution: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  createTask(input: { title: string; body?: string; ticketKey?: string; worktreePath?: string }): Promise<void>;
  assignTask(id: string, agent: string): Promise<void>;
  releaseTask(id: string): Promise<void>;
  doneTask(id: string): Promise<void>;
  cancelTask(id: string): Promise<void>;
  createFork(input: ForkCreateInput): Promise<ForkDto>;
  cancelFork(id: string): Promise<void>;
};
const IntercomContext = createContext<IntercomContextValue | null>(null);
const REFETCH_DEBOUNCE_MS = 150;

export function IntercomProvider({ wsId, children }: { wsId: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(intercomReducer, INITIAL_INTERCOM);
  const timers = useRef<{ escalations?: ReturnType<typeof setTimeout>; tasks?: ReturnType<typeof setTimeout>; forks?: ReturnType<typeof setTimeout>; peers?: ReturnType<typeof setTimeout> }>({});
  // The workspace the most recently started effect is for. A fetch closes
  // over the `wsId` it was started for; if that no longer matches this ref by
  // the time it resolves, a newer workspace switch is already in flight and
  // the stale result is dropped instead of overwriting the new workspace's data.
  const wsRef = useRef(wsId);

  const fetchEscalations = useCallback(async () => {
    try {
      const escalations = await api.intercom.escalations.list(wsId);
      if (wsRef.current === wsId) dispatch({ type: 'escalations', escalations });
    } catch (err) {
      if (wsRef.current === wsId) dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [wsId]);
  const fetchTasks = useCallback(async () => {
    try {
      const tasks = await api.intercom.tasks.list(wsId);
      if (wsRef.current === wsId) dispatch({ type: 'tasks', tasks });
    } catch (err) {
      if (wsRef.current === wsId) dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [wsId]);
  const fetchForks = useCallback(async () => {
    try {
      const forks = await api.intercom.forks.list(wsId);
      if (wsRef.current === wsId) dispatch({ type: 'forks', forks });
    } catch (err) {
      if (wsRef.current === wsId) dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [wsId]);
  const fetchPeers = useCallback(async () => {
    try {
      const peers = await api.intercom.peers(wsId);
      if (wsRef.current === wsId) dispatch({ type: 'peers', peers });
    } catch (err) {
      if (wsRef.current === wsId) dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [wsId]);
  const refresh = useCallback(async () => {
    try {
      const [escalations, tasks, forks, peers] = await Promise.all([api.intercom.escalations.list(wsId), api.intercom.tasks.list(wsId), api.intercom.forks.list(wsId), api.intercom.peers(wsId)]);
      if (wsRef.current === wsId) dispatch({ type: 'loaded', escalations, tasks, forks, peers });
    } catch (err) {
      if (wsRef.current === wsId) dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [wsId]);

  useEffect(() => {
    wsRef.current = wsId;
    dispatch({ type: 'reset' });
    void refresh();
    const unsub = subscribeIntercom(wsId, (evt) => {
      const which = collectionOf(evt);
      clearTimeout(timers.current[which]);
      // Peers change when a tab opens or dies; an escalation/task/fork event
      // may follow a new tab, so refresh peers alongside whichever collection
      // moved. A `peer.*` event is the registry itself saying so: peers only.
      timers.current[which] = setTimeout(() => {
        if (which === 'tasks') void fetchTasks();
        else if (which === 'forks') void fetchForks();
        else if (which === 'escalations') void fetchEscalations();
        void fetchPeers();
      }, REFETCH_DEBOUNCE_MS);
    });
    const unsubWorktrees = subscribeWorktrees(() => {
      clearTimeout(timers.current.peers);
      timers.current.peers = setTimeout(() => { void fetchPeers(); }, REFETCH_DEBOUNCE_MS);
    });
    return () => { unsub(); unsubWorktrees(); clearTimeout(timers.current.escalations); clearTimeout(timers.current.tasks); clearTimeout(timers.current.forks); clearTimeout(timers.current.peers); };
  }, [wsId, refresh, fetchEscalations, fetchTasks, fetchForks, fetchPeers]);

  const value = useMemo<IntercomContextValue>(() => ({
    ...state,
    refresh,
    resolve: async (id, resolution) => { await api.intercom.escalations.resolve(wsId, id, resolution); await fetchEscalations(); },
    dismiss: async (id) => { await api.intercom.escalations.dismiss(wsId, id); await fetchEscalations(); },
    createTask: async (input) => { await api.intercom.tasks.create(wsId, input); await fetchTasks(); },
    assignTask: async (id, agent) => { await api.intercom.tasks.assign(wsId, id, agent); await fetchTasks(); },
    releaseTask: async (id) => { await api.intercom.tasks.release(wsId, id); await fetchTasks(); },
    doneTask: async (id) => { await api.intercom.tasks.done(wsId, id); await fetchTasks(); },
    cancelTask: async (id) => { await api.intercom.tasks.cancel(wsId, id); await fetchTasks(); },
    createFork: async (input) => { const fork = await api.intercom.forks.create(wsId, input); await fetchForks(); return fork; },
    cancelFork: async (id) => { await api.intercom.forks.cancel(wsId, id); await fetchForks(); },
  }), [state, wsId, refresh, fetchEscalations, fetchTasks, fetchForks]);

  return <IntercomContext.Provider value={value}>{children}</IntercomContext.Provider>;
}

export function useIntercom(): IntercomContextValue {
  const ctx = useContext(IntercomContext);
  if (!ctx) throw new Error('useIntercom must be inside <IntercomProvider>');
  return ctx;
}
