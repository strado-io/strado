import { useCallback, useEffect, useState } from 'react';

const SHOW_TIME_KEY = 'strado:hub-show-time';
const SHOW_STATUS_KEY = 'strado:hub-show-status';
/** The bottom bar (location + command box). Off, it shows only while ⌘K holds the keyboard. */
const SHOW_DOCK_KEY = 'strado:show-dock';
const CHANGE_EVENT = 'strado:hub-display-change';

// All three start off: a quiet hub by default. Only an explicit "on" shows them.
function readPreference(key: string): boolean {
  return localStorage.getItem(key) === 'true';
}

export function useHubDisplayPreferences() {
  const [showTime, setShowTimeState] = useState(() => readPreference(SHOW_TIME_KEY));
  const [showStatus, setShowStatusState] = useState(() => readPreference(SHOW_STATUS_KEY));
  const [showDock, setShowDockState] = useState(() => readPreference(SHOW_DOCK_KEY));

  useEffect(() => {
    const sync = () => {
      setShowTimeState(readPreference(SHOW_TIME_KEY));
      setShowStatusState(readPreference(SHOW_STATUS_KEY));
      setShowDockState(readPreference(SHOW_DOCK_KEY));
    };
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);

  const setShowTime = useCallback((value: boolean) => {
    localStorage.setItem(SHOW_TIME_KEY, String(value));
    setShowTimeState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const setShowStatus = useCallback((value: boolean) => {
    localStorage.setItem(SHOW_STATUS_KEY, String(value));
    setShowStatusState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const setShowDock = useCallback((value: boolean) => {
    localStorage.setItem(SHOW_DOCK_KEY, String(value));
    setShowDockState(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { showTime, setShowTime, showStatus, setShowStatus, showDock, setShowDock };
}
