import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type OrphanCallDto, type StationDto } from '../api';
import { subscribeIntercom, subscribeWorktrees } from '../eventStream';

/** Bursts of intercom/worktree events collapse into one refetch per window. */
export const STATIONS_THROTTLE_MS = 500;

/** The workspace's intercom stations (every agent/shell tab, with its calls to
 * the human, plus the calls whose asker has no tab), kept fresh from the event stream. A failed load keeps the last
 * good list so the Dock's lights never flash empty. */
export function useStations(wsId: string): { stations: StationDto[]; orphanCalls: OrphanCallDto[]; loaded: boolean; refresh: () => Promise<void> } {
  const [stations, setStations] = useState<StationDto[]>([]);
  const [orphanCalls, setOrphanCalls] = useState<OrphanCallDto[]>([]);
  // The workspace whose list has landed: `loaded` is never true for a previous one.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const wsRef = useRef(wsId);
  wsRef.current = wsId;

  const refresh = useCallback(async () => {
    const ws = wsRef.current;
    try {
      const next = await api.intercom.stations(ws);
      if (wsRef.current === ws) { setStations(next.stations); setOrphanCalls(next.orphanCalls ?? []); setLoadedFor(ws); }
    } catch {
      // keep what we had
    }
  }, []);

  useEffect(() => {
    setStations([]);
    setOrphanCalls([]);
    void refresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void refresh(); }, STATIONS_THROTTLE_MS);
    };
    // A message alone moves no light; every other intercom event can.
    const offIntercom = subscribeIntercom(wsId, (evt) => { if (evt.type !== 'feed.changed') soon(); });
    const offWorktrees = subscribeWorktrees(soon);
    return () => {
      if (timer) clearTimeout(timer);
      offIntercom();
      offWorktrees();
    };
  }, [wsId, refresh]);

  return { stations, orphanCalls, loaded: loadedFor === wsId, refresh };
}
