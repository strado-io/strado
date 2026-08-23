import { useEffect, useState } from 'react';

// Which worktrees have a Knowledge Base tab open. Like the VS Code tab, this is
// a client-only tab with no server session, so localStorage is the single
// source of truth — persisted so tabs survive a panel reopen or reload.
const KEY = 'strado:kb-tabs';
const EVENT = 'strado:kb-tabs';

export function readKbTabs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function rememberKbTab(path: string, open: boolean): void {
  const tabs = readKbTabs();
  if (open) tabs.add(path);
  else tabs.delete(path);
  localStorage.setItem(KEY, JSON.stringify([...tabs]));
  window.dispatchEvent(new Event(EVENT));
}

export function useKbTabs(): Set<string> {
  const [tabs, setTabs] = useState<Set<string>>(readKbTabs);
  useEffect(() => {
    const update = () => setTabs(readKbTabs());
    window.addEventListener(EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return tabs;
}
