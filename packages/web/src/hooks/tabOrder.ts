// Persisted per-worktree tab order for the hub's tab strip (drag-to-reorder).
// Keys are `${mode}:${id}`. Tabs missing from the saved order keep their
// structural position after the saved ones.
const STORE = 'strado.tabOrder';

type OrderMap = Record<string, string[]>;

function readAll(): OrderMap {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as OrderMap) : {};
  } catch {
    return {};
  }
}

export function readTabOrder(path: string): string[] {
  const v = readAll()[path];
  return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
}

export function rememberTabOrder(path: string, keys: string[]): void {
  try {
    const all = readAll();
    all[path] = keys;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* storage unavailable — order just won't persist */
  }
}

export function tabKeyOf(t: { mode: string; id: string; remote?: { runnerId: string } | null }): string {
  // A remote shell and a local shell can both be session 1 of the same
  // worktree, so the runner has to be part of the identity — otherwise they
  // share a pane, a split leaf and a saved order slot.
  return t.remote ? `${t.mode}@${t.remote.runnerId}:${t.id}` : `${t.mode}:${t.id}`;
}

// Last-active tab per worktree. The hub remounts on every worktree switch
// (keyed by path), so without this the tab selection dies with the unmount —
// R1 on tab 3 → R2 → back to R1 landed on tab 1.
const ACTIVE_STORE = 'strado.activeTab';
const TAB_MODES = ['claude', 'shell', 'codex', 'opencode', 'vscode', 'browser', 'kb'] as const;
export type TabMode = (typeof TAB_MODES)[number];

export function readActiveTab(path: string): { mode: TabMode; id: string } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_STORE) ?? '{}') as Record<string, unknown>;
    const key = raw[path];
    if (typeof key !== 'string') return null;
    const i = key.indexOf(':');
    if (i === -1) return null;
    const mode = key.slice(0, i) as TabMode;
    const id = key.slice(i + 1);
    if (!TAB_MODES.includes(mode) || !/^\d+$/.test(id)) return null;
    return { mode, id };
  } catch {
    return null;
  }
}

export function rememberActiveTab(path: string, key: string): void {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_STORE) ?? '{}') as Record<string, unknown>;
    raw[path] = key;
    localStorage.setItem(ACTIVE_STORE, JSON.stringify(raw));
  } catch {
    /* storage unavailable — selection just won't persist */
  }
}

/** Stable-sort tabs by the saved order; unsaved tabs keep structural order after them. */
export function applyTabOrder<T extends { tab: { mode: string; id: string; remote?: { runnerId: string } | null } }>(
  saved: string[],
  tabs: T[],
): T[] {
  if (saved.length === 0) return tabs;
  const rank = new Map(saved.map((k, i) => [k, i]));
  return tabs
    .map((t, i) => ({ t, r: rank.get(tabKeyOf(t.tab)) ?? saved.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.t);
}
