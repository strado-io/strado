// Whether the sidebar is collapsed, outside React's tree. Toggling it
// re-renders only what reads it (the sidebar and the open buttons), not the
// whole app: from the top-level Dashboard a toggle re-rendered every page and
// the terminal view (~18 ms), the difference between this and Warp's
// one-frame toggle.
import { useSyncExternalStore } from 'react';
import { markLayoutJump } from './layoutMotion';

const STORE_KEY = 'strado:sidebar-collapsed:v2';
let collapsed = true;
const listeners = new Set<() => void>();

const read = (): boolean => {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    return stored === null ? true : stored === '1';
  } catch { return true; }
};

/** Re-reads what was persisted (the app mounting); no one is notified. */
export function loadSidebarCollapsed(): boolean {
  collapsed = read();
  return collapsed;
}

export const getSidebarCollapsed = (): boolean => collapsed;

/** Collapse or show it. A change is a layout jump: terminals fit in this frame. */
export function setSidebarCollapsed(next: boolean | ((prev: boolean) => boolean)): void {
  const value = typeof next === 'function' ? next(collapsed) : next;
  if (value === collapsed) return;
  collapsed = value;
  try { localStorage.setItem(STORE_KEY, value ? '1' : '0'); } catch { /* not persisted */ }
  markLayoutJump();
  for (const cb of [...listeners]) cb();
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

/** The live value; re-renders the caller (only) when it changes. */
export const useSidebarCollapsed = (): boolean => useSyncExternalStore(subscribe, getSidebarCollapsed, getSidebarCollapsed);
