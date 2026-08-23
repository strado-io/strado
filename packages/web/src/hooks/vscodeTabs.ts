import { useEffect, useState } from 'react';

// Which worktrees have a VS Code tab open in the terminal hub. VS Code web is
// an iframe, not a server-side session, so this is the single source of truth
// — persisted so tabs survive panel reopen, broadcast so row icons and the
// sessions dock stay live.
const KEY = 'strado:vscode-tabs';
const EVENT = 'strado:vscode-tabs';

export function readVscodeTabs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function rememberVscodeTab(path: string, open: boolean): void {
  const tabs = readVscodeTabs();
  if (open) tabs.add(path);
  else tabs.delete(path);
  localStorage.setItem(KEY, JSON.stringify([...tabs]));
  window.dispatchEvent(new Event(EVENT));
}

export function useVscodeTabs(): Set<string> {
  const [tabs, setTabs] = useState<Set<string>>(readVscodeTabs);
  useEffect(() => {
    const update = () => setTabs(readVscodeTabs());
    window.addEventListener(EVENT, update);
    // cross-browser-tab changes
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return tabs;
}
