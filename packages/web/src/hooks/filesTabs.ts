// Which worktrees have a Files tab open in the terminal hub. Like
// VS Code it is client-side only, so this is its source of truth — persisted
// so the tab survives panel reopen.
const KEY = 'strado:files-tabs';

export function readFilesTabs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function rememberFilesTab(path: string, open: boolean): void {
  const tabs = readFilesTabs();
  if (open) tabs.add(path);
  else tabs.delete(path);
  try {
    localStorage.setItem(KEY, JSON.stringify([...tabs]));
  } catch {
    // storage full or blocked: the tab still works for this session
  }
}
