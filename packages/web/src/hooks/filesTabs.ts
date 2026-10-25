import { hasLeaf, readPaneLayouts, rememberPaneLayouts, removeLeaf, replaceLeaf, type PaneNode } from './paneLayout';

// Which worktrees have a Files tab open in the terminal hub. It is client-side
// only, so this is its source of truth — persisted so the tab survives panel
// reopen.
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

// The embedded VS Code tab is gone (the Files tab and "Open in editor" replace
// it). Saved hub state from before still names it as mode 'vscode': turn each
// such tab into that worktree's Files tab — its open list, last-active tab,
// tab order and split-pane leaves — once, so nothing crashes or dangles.
const LEGACY_KEY = 'strado:vscode-tabs';
const LEGACY = 'vscode:1';
const FILES = 'files:1';
export function migrateEditorTabs(): void {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw === null) return;
    localStorage.removeItem(LEGACY_KEY);
    const paths = (JSON.parse(raw) as unknown[]).filter((p): p is string => typeof p === 'string');
    for (const p of paths) rememberFilesTab(p, true);

    const active = JSON.parse(localStorage.getItem('strado.activeTab') ?? '{}') as Record<string, unknown>;
    for (const [p, key] of Object.entries(active)) if (key === LEGACY) active[p] = FILES;
    localStorage.setItem('strado.activeTab', JSON.stringify(active));

    const order = JSON.parse(localStorage.getItem('strado.tabOrder') ?? '{}') as Record<string, unknown>;
    for (const [p, keys] of Object.entries(order)) {
      if (!Array.isArray(keys) || !keys.includes(LEGACY)) continue;
      order[p] = keys.includes(FILES) ? keys.filter((k) => k !== LEGACY) : keys.map((k) => (k === LEGACY ? FILES : k));
    }
    localStorage.setItem('strado.tabOrder', JSON.stringify(order));

    const layouts = readPaneLayouts();
    for (const [p, nodes] of Object.entries(layouts)) {
      const hasFiles = nodes.some((n) => hasLeaf(n, FILES));
      const next = nodes
        .map((n) => (!hasLeaf(n, LEGACY) ? n : hasFiles ? removeLeaf(n, LEGACY) : replaceLeaf(n, LEGACY, FILES)))
        .filter((n): n is PaneNode => n !== null);
      rememberPaneLayouts(p, next);
    }
  } catch {
    // storage blocked or junk: the old tab simply isn't carried over
  }
}
