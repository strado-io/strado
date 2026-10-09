import { useCallback, useEffect, useState } from 'react';

// Which focus group is active and which groups are folded — per device and
// per workspace. Every instance (three sidebar panes, the
// dashboard) re-reads on one change event so they never disagree.
const ACTIVE_KEY = 'strado:focus-group-active';
const COLLAPSED_KEY = 'strado:focus-groups-collapsed';
const CHANGE_EVENT = 'strado:focus-prefs-change';

function readMap<T>(key: string): Record<string, T> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
function writeMap<T>(key: string, wsId: string, value: T) {
  try { localStorage.setItem(key, JSON.stringify({ ...readMap<T>(key), [wsId]: value })); } catch { /* storage off */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function read(wsId: string) {
  const active = readMap<string | null>(ACTIVE_KEY)[wsId];
  return {
    activeFocusGroupId: typeof active === 'string' ? active : null,
    collapsedGroupIds: stringList(readMap<unknown>(COLLAPSED_KEY)[wsId]),
  };
}

export function useFocusPrefs(wsId: string) {
  const [prefs, setPrefs] = useState(() => read(wsId));
  useEffect(() => {
    const sync = () => setPrefs(read(wsId));
    sync();
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, [wsId]);

  const setActiveFocusGroupId = useCallback((v: string | null) => writeMap(ACTIVE_KEY, wsId, v), [wsId]);
  const toggleGroupCollapsed = useCallback((id: string) => {
    const cur = read(wsId).collapsedGroupIds;
    writeMap(COLLAPSED_KEY, wsId, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }, [wsId]);
  return { ...prefs, setActiveFocusGroupId, toggleGroupCollapsed };
}
