// Which worktrees have a Changes (diff) tab open in the terminal hub. Like
// VS Code it is client-side only, so this is its source of truth — persisted
// so the tab survives panel reopen.
const KEY = 'strado:diff-tabs';

export function readDiffTabs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function rememberDiffTab(path: string, open: boolean): void {
  const tabs = readDiffTabs();
  if (open) tabs.add(path);
  else tabs.delete(path);
  try {
    localStorage.setItem(KEY, JSON.stringify([...tabs]));
  } catch {
    // storage full or blocked: the tab still works for this session
  }
}
