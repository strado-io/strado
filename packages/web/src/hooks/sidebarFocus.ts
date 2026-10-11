import { useCallback, useState } from 'react';

// The sidebar's Focus switch. On (the default), the sidebar shows only the
// worktrees you have opened in this space, plus Settled. Off, it shows the
// whole space: every repo with all of its worktrees. One setting per device,
// shared by all spaces, like a view mode rather than a preference about data.
const KEY = 'strado:sidebar-focus';

export function readSidebarFocus(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

export function useSidebarFocus(): [boolean, () => void] {
  const [focus, setFocus] = useState(readSidebarFocus);
  const toggle = useCallback(() => {
    setFocus((v) => {
      try { localStorage.setItem(KEY, v ? 'off' : 'on'); } catch { /* storage off */ }
      return !v;
    });
  }, []);
  return [focus, toggle];
}
