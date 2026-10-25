// File tabs inside the Files tab, VS Code's way: a tree click opens the one
// preview tab (replaced by the next click), anything that goes somewhere on
// purpose (definition, reference, search hit, outline, a link from outside)
// opens a permanent tab or switches to the one already open. Up to two panes
// side by side, each with its own tabs. Pure state; FilesTab renders it.

/** Tabs kept per pane; past this the least recently used one closes. */
export const TABS_CAP = 20;

export type PaneIndex = 0 | 1;
export type FileTab = {
  path: string;
  /** The tree's preview tab: italic, replaced by the next tree click. */
  preview: boolean;
  /** Where this tab's cursor is (1-based); a switch back lands here. */
  line: number;
  col: number;
  /** Where the viewer is asked to go: set by a jump, or the cursor when the tab is shown again. */
  go: { line: number; col: number };
  /** Bumped with each jump into an open tab, so the viewer goes again. */
  nonce: number;
  /** For least-recently-used closing. */
  used: number;
};
export type Pane = { tabs: FileTab[]; active: string | null };
export type TabsState = { panes: Pane[]; focus: PaneIndex; clock: number };

export const emptyTabs = (): TabsState => ({ panes: [{ tabs: [], active: null }], focus: 0, clock: 0 });

export type OpenMode = 'preview' | 'permanent';
export type TabsAction =
  | { type: 'open'; pane: PaneIndex; path: string; line?: number; col?: number; mode: OpenMode }
  | { type: 'activate'; pane: PaneIndex; path: string }
  | { type: 'pin'; pane: PaneIndex; path: string }
  | { type: 'close'; pane: PaneIndex; path: string }
  | { type: 'cursor'; pane: PaneIndex; path: string; line: number; col: number }
  | { type: 'focus'; pane: PaneIndex }
  | { type: 'closePane'; pane: PaneIndex }
  | { type: 'load'; state: TabsState };

export function activeTab(s: TabsState, pane: PaneIndex = s.focus): FileTab | null {
  const p = s.panes[pane];
  return p?.tabs.find((t) => t.path === p.active) ?? null;
}

function withPane(s: TabsState, i: PaneIndex, f: (p: Pane) => Pane): TabsState {
  const panes = [...s.panes];
  panes[i] = f(panes[i] ?? { tabs: [], active: null });
  return { ...s, panes };
}

// Past the cap, close the least recently used tab other than the active one.
function capTabs(p: Pane): Pane {
  if (p.tabs.length <= TABS_CAP) return p;
  const victim = [...p.tabs].filter((t) => t.path !== p.active).sort((a, b) => a.used - b.used)[0];
  return victim ? capTabs({ ...p, tabs: p.tabs.filter((t) => t !== victim) }) : p;
}

// An emptied side pane goes away; an emptied first pane hands over to the side one.
function tidy(s: TabsState): TabsState {
  if (s.panes.length < 2) return s;
  const [a, b] = s.panes as [Pane, Pane];
  if (b.tabs.length === 0) return { ...s, panes: [a], focus: 0 };
  if (a.tabs.length === 0) return { ...s, panes: [b], focus: 0 };
  return s;
}

export function tabsReducer(s: TabsState, a: TabsAction): TabsState {
  const clock = s.clock + 1;
  switch (a.type) {
    case 'open': {
      // Opening into the side pane makes it (at most two).
      const pane: PaneIndex = a.pane === 1 && s.panes.length < 2 ? 1 : (Math.min(a.pane, s.panes.length - 1) as PaneIndex);
      const next = withPane({ ...s, clock, focus: pane }, pane, (p) => {
        const line = a.line ?? 1;
        const col = a.col ?? 1;
        const have = p.tabs.find((t) => t.path === a.path);
        if (have) {
          const keepPlace = a.line == null;
          const tab: FileTab = {
            ...have, used: clock,
            preview: have.preview && a.mode === 'preview',
            line: keepPlace ? have.line : line, col: keepPlace ? have.col : col,
            go: keepPlace ? (p.active === a.path ? have.go : { line: have.line, col: have.col }) : { line, col },
            nonce: keepPlace ? have.nonce : have.nonce + 1,
          };
          return { tabs: p.tabs.map((t) => (t === have ? tab : t)), active: a.path };
        }
        const tab: FileTab = { path: a.path, preview: a.mode === 'preview', line, col, go: { line, col }, nonce: 0, used: clock };
        const preview = a.mode === 'preview' ? p.tabs.findIndex((t) => t.preview) : -1;
        if (preview >= 0) {
          const tabs = [...p.tabs];
          tabs[preview] = tab;
          return { tabs, active: a.path };
        }
        const at = p.tabs.findIndex((t) => t.path === p.active);
        const tabs = [...p.tabs];
        tabs.splice(at + 1, 0, tab);
        return capTabs({ tabs, active: a.path });
      });
      return next;
    }
    case 'activate':
      return withPane({ ...s, clock, focus: a.pane }, a.pane, (p) => ({
        // Shown again: back where its cursor was.
        tabs: p.tabs.map((t) => (t.path === a.path ? { ...t, used: clock, go: p.active === a.path ? t.go : { line: t.line, col: t.col } } : t)),
        active: p.tabs.some((t) => t.path === a.path) ? a.path : p.active,
      }));
    case 'pin':
      return withPane(s, a.pane, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.path === a.path ? { ...t, preview: false } : t)) }));
    case 'close': {
      const out = withPane(s, a.pane, (p) => {
        const i = p.tabs.findIndex((t) => t.path === a.path);
        if (i < 0) return p;
        const tabs = p.tabs.filter((_, j) => j !== i);
        const active = p.active !== a.path ? p.active : (tabs[i] ?? tabs[i - 1])?.path ?? null;
        return { tabs, active };
      });
      return tidy(out);
    }
    case 'cursor':
      return withPane(s, a.pane, (p) => ({
        ...p, tabs: p.tabs.map((t) => (t.path === a.path ? { ...t, line: a.line, col: a.col } : t)),
      }));
    case 'focus':
      return a.pane < s.panes.length && a.pane !== s.focus ? { ...s, focus: a.pane } : s;
    case 'load':
      return a.state;
    case 'closePane':
      if (s.panes.length < 2) return s;
      return { ...s, panes: s.panes.filter((_, i) => i !== a.pane), focus: 0 };
  }
}

// Kept per worktree, so reopening it brings its tabs back.
type Saved = { panes: Array<{ tabs: Array<Pick<FileTab, 'path' | 'preview' | 'line' | 'col'>>; active: string | null }>; focus: PaneIndex };

export const tabsKey = (scope: string) => `strado:files-tabs:${scope}`;

export function loadTabs(scope: string): TabsState {
  try {
    const raw = localStorage.getItem(tabsKey(scope));
    if (!raw) return emptyTabs();
    const saved = JSON.parse(raw) as Saved;
    const panes: Pane[] = (saved.panes ?? []).slice(0, 2).map((p) => {
      const tabs = (p.tabs ?? [])
        .filter((t) => typeof t?.path === 'string' && t.path)
        .slice(0, TABS_CAP)
        .map((t, i) => {
          const line = Number(t.line) || 1;
          const col = Number(t.col) || 1;
          return { path: t.path, preview: !!t.preview, line, col, go: { line, col }, nonce: 0, used: i };
        });
      return { tabs, active: tabs.some((t) => t.path === p.active) ? p.active : tabs[0]?.path ?? null };
    }).filter((p) => p.tabs.length > 0);
    if (!panes.length) return emptyTabs();
    return { panes, focus: saved.focus === 1 && panes.length > 1 ? 1 : 0, clock: TABS_CAP };
  } catch {
    return emptyTabs();
  }
}

export function saveTabs(scope: string, s: TabsState): void {
  const saved: Saved = {
    panes: s.panes.map((p) => ({ tabs: p.tabs.map(({ path, preview, line, col }) => ({ path, preview, line, col })), active: p.active })),
    focus: s.focus,
  };
  try {
    if (saved.panes.every((p) => p.tabs.length === 0)) localStorage.removeItem(tabsKey(scope));
    else localStorage.setItem(tabsKey(scope), JSON.stringify(saved));
  } catch { /* private mode or full: tabs just aren't remembered */ }
}
