import { useCallback, useEffect, useState } from 'react';
import { ATTENTION_ORDER, type Attention, type GroupBy, type SortBy } from './attention';

export type BoardPrefs = {
  groupBy: GroupBy;
  sort: SortBy;
  /** Attention tile currently filtering the board, or null for all. */
  tile: Attention | null;
  /** Collapsed group keys (see groupRows). */
  collapsed: string[];
};

export const DEFAULT_BOARD_PREFS: BoardPrefs = { groupBy: 'state', sort: 'activity', tile: null, collapsed: [] };

const GROUP_BY: GroupBy[] = ['state', 'repo', 'none'];
const SORT_BY: SortBy[] = ['activity', 'ticket', 'manual'];

const key = (wsId: string) => `strado.board.${wsId}`;

// Every field is validated on the way in: a stale or hand-edited value must
// degrade to the default for THAT field, never take the whole board with it.
export function readBoardPrefs(wsId: string): BoardPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(key(wsId)) ?? 'null') as Partial<Record<keyof BoardPrefs, unknown>> | null;
    if (!raw || typeof raw !== 'object') return DEFAULT_BOARD_PREFS;
    return {
      groupBy: GROUP_BY.includes(raw.groupBy as GroupBy) ? (raw.groupBy as GroupBy) : DEFAULT_BOARD_PREFS.groupBy,
      sort: SORT_BY.includes(raw.sort as SortBy) ? (raw.sort as SortBy) : DEFAULT_BOARD_PREFS.sort,
      tile: ATTENTION_ORDER.includes(raw.tile as Attention) ? (raw.tile as Attention) : null,
      collapsed: Array.isArray(raw.collapsed) ? raw.collapsed.filter((k): k is string => typeof k === 'string') : [],
    };
  } catch {
    return DEFAULT_BOARD_PREFS;
  }
}

export function useBoardPrefs(wsId: string): [BoardPrefs, (patch: Partial<BoardPrefs>) => void] {
  const [prefs, setPrefs] = useState<BoardPrefs>(() => readBoardPrefs(wsId));
  useEffect(() => { setPrefs(readBoardPrefs(wsId)); }, [wsId]);
  useEffect(() => {
    try { localStorage.setItem(key(wsId), JSON.stringify(prefs)); } catch { /* storage unavailable */ }
  }, [wsId, prefs]);
  const patch = useCallback((p: Partial<BoardPrefs>) => setPrefs((cur) => ({ ...cur, ...p })), []);
  return [prefs, patch];
}
