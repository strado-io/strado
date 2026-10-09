import { useCallback, useEffect, useState } from 'react';

// Which focus group is active, and whether its sidebar section is folded —
// per device and per workspace. Every instance (three sidebar panes, the
// dashboard) re-reads on one change event so they never disagree.
const ACTIVE_KEY = 'strado:focus-group-active';
const COLLAPSED_KEY = 'strado:focus-section-collapsed';
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

function read(wsId: string) {
  const active = readMap<string | null>(ACTIVE_KEY)[wsId];
  return {
    activeFocusGroupId: typeof active === 'string' ? active : null,
    focusCollapsed: readMap<boolean>(COLLAPSED_KEY)[wsId] === true,
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
  const setFocusCollapsed = useCallback((v: boolean) => writeMap(COLLAPSED_KEY, wsId, v), [wsId]);
  return { ...prefs, setActiveFocusGroupId, setFocusCollapsed };
}
