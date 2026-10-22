import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { api } from '../api';
import { subscribeIntercom, subscribeWorktrees } from '../eventStream';
import { INITIAL_INTERCOM, intercomReducer, type IntercomState } from '../hooks/intercom';

export type IntercomContextValue = IntercomState & {
  refresh(): Promise<void>;
};
const IntercomContext = createContext<IntercomContextValue | null>(null);
const REFETCH_DEBOUNCE_MS = 150;

/** The workspace's intercom peers, kept fresh from the event stream. */
export function IntercomProvider({ wsId, children }: { wsId: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(intercomReducer, INITIAL_INTERCOM);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The workspace the most recently started effect is for. A fetch closes
  // over the `wsId` it was started for; if that no longer matches this ref by
  // the time it resolves, a newer workspace switch is already in flight and
  // the stale result is dropped instead of overwriting the new workspace's data.
  const wsRef = useRef(wsId);

  const refresh = useCallback(async () => {
    try {
      const peers = await api.intercom.peers(wsId);
      if (wsRef.current === wsId) dispatch({ type: 'peers', peers });
    } catch (err) {
      if (wsRef.current === wsId) dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [wsId]);

  useEffect(() => {
    wsRef.current = wsId;
    dispatch({ type: 'reset' });
    void refresh();
    // Peers change when a tab opens or dies; any intercom event (a peer, a
    // call, a task) may follow one, so refetch. A new message on the line: the
    // Dock's feed refetches; nothing here changed.
    const soon = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { void refresh(); }, REFETCH_DEBOUNCE_MS);
    };
    const unsub = subscribeIntercom(wsId, (evt) => {
      if (evt.type === 'feed.changed' || evt.type === 'message.queued') return;
      soon();
    });
    const unsubWorktrees = subscribeWorktrees(soon);
    return () => { unsub(); unsubWorktrees(); clearTimeout(timer.current); };
  }, [wsId, refresh]);

  const value = useMemo<IntercomContextValue>(() => ({ ...state, refresh }), [state, refresh]);

  return <IntercomContext.Provider value={value}>{children}</IntercomContext.Provider>;
}
export function useIntercom(): IntercomContextValue {
  const ctx = useContext(IntercomContext);
  if (!ctx) throw new Error('useIntercom must be inside <IntercomProvider>');
  return ctx;
}
