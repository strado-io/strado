import { useEffect, useState } from 'react';

// Which worktrees have a Knowledge Base tab open. Like the VS Code tab, this is
// a client-only tab with no server session, so localStorage is the single
// source of truth — persisted so tabs survive a panel reopen or reload.
const KEY = 'strado:kb-tabs';
const EVENT = 'strado:kb-tabs';
const IDS_KEY = 'strado:kb-tab-ids';

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

/** Extra Knowledge Base tab ids; id 1 remains represented by `readKbTabs`. */
export function readKbTabIds(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(IDS_KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [path, ids] of Object.entries(raw)) {
      if (Array.isArray(ids)) out[path] = ids.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id) && id !== '1');
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberKbTabIds(path: string, ids: string[]): void {
  const all = readKbTabIds();
  const clean = [...new Set(ids)].filter((id) => /^\d+$/.test(id) && id !== '1');
  if (clean.length) all[path] = clean;
  else delete all[path];
  localStorage.setItem(IDS_KEY, JSON.stringify(all));
  window.dispatchEvent(new Event(EVENT));
}

/** Storage namespace for one independently stateful document tab. */
export function kbInstancePath(path: string, id: string): string {
  return id === '1' ? path : `${path}\0kb:${id}`;
}

export function readKbSelection(path: string, id: string): string | null {
  return localStorage.getItem(`strado:kb-selected:${kbInstancePath(path, id)}`);
}

export function rememberKbSelection(path: string, id: string, selected: string | null): void {
  const key = `strado:kb-selected:${kbInstancePath(path, id)}`;
  if (selected) localStorage.setItem(key, selected);
  else localStorage.removeItem(key);
}

export function forgetKbTabState(path: string, id: string): void {
  const instance = kbInstancePath(path, id);
  localStorage.removeItem(`strado:kb-selected:${instance}`);
  localStorage.removeItem(`strado:kb-collapsed:${instance}`);
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
