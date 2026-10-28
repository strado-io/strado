// ⌘[ and ⌘] across the app, like a browser's back and forward: every place you
// land (a worktree's tab, a Focus's Jarvis chat, Code reviews, Usage) goes into
// a history, one per workspace. A place is recorded once it has held still for
// RECORD_MS, so the in-between states of a switch (a Focus restoring its
// worktree, a hub picking its tab) don't fill the history. Going back to a
// place that no longer exists (a closed tab, a removed worktree) steps past it.
// The Files tab keeps its own ⌘[/⌘] for places in code while it has any.
import { useEffect, useRef } from 'react';

export type HubTab = { mode: string; id: string };
export type Place =
  | { kind: 'hub'; focusId: string | null; path: string; tab?: HubTab }
  | { kind: 'remote'; focusId: string | null; runnerId: string; path: string }
  | { kind: 'jarvis'; focusId: string }
  | { kind: 'page'; page: 'reviews' | 'usage' }
  | { kind: 'home' };

export type History = { stack: Place[]; at: number };

export const RECORD_MS = 200;
const MAX = 50;

export const placeKey = (p: Place): string => {
  switch (p.kind) {
    case 'hub': return `hub\0${p.focusId ?? ''}\0${p.path}\0${p.tab ? `${p.tab.mode}:${p.tab.id}` : ''}`;
    case 'remote': return `remote\0${p.focusId ?? ''}\0${p.runnerId}\0${p.path}`;
    case 'jarvis': return `jarvis\0${p.focusId}`;
    case 'page': return `page\0${p.page}`;
    case 'home': return 'home';
  }
};

export const emptyHistory = (): History => ({ stack: [], at: -1 });

/** The same worktree, before its tab was known: the tab fills it in rather than adding a step. */
const sameHubWithoutTab = (a: Place, b: Place) =>
  a.kind === 'hub' && b.kind === 'hub' && !a.tab && !!b.tab && a.path === b.path && a.focusId === b.focusId;

/** Where you are now, after the place you came from. */
export function record(h: History, p: Place): History {
  const cur = h.stack[h.at];
  if (cur && placeKey(cur) === placeKey(p)) return h;
  if (cur && sameHubWithoutTab(cur, p)) {
    const stack = [...h.stack];
    stack[h.at] = p;
    return { stack, at: h.at };
  }
  const stack = [...h.stack.slice(0, h.at + 1), p].slice(-MAX);
  return { stack, at: stack.length - 1 };
}

/** One step back (-1) or forward (1), past places `valid` rejects; null when there is none. */
export function step(h: History, dir: -1 | 1, valid: (p: Place) => boolean): { history: History; place: Place } | null {
  const cur = h.stack[h.at];
  for (let i = h.at + dir; i >= 0 && i < h.stack.length; i += dir) {
    const p = h.stack[i]!;
    if (cur && placeKey(p) === placeKey(cur)) continue;
    if (valid(p)) return { history: { stack: h.stack, at: i }, place: p };
  }
  return null;
}

/** A worktree's tabs changed: places on a tab it no longer has keep the worktree, not the tab. */
export function pruneTabs(h: History, path: string, open: HubTab[]): History {
  const has = (t: HubTab) => open.some((o) => o.mode === t.mode && o.id === t.id);
  let changed = false;
  const mapped = h.stack.map((p) => {
    if (p.kind !== 'hub' || p.path !== path || !p.tab || has(p.tab)) return p;
    changed = true;
    return { kind: 'hub', focusId: p.focusId, path: p.path } as Place;
  });
  if (!changed) return h;
  // Neighbours that became the same place merge; the current index follows its entry.
  const stack: Place[] = [];
  let at = -1;
  mapped.forEach((p, i) => {
    const last = stack[stack.length - 1];
    if (!last || placeKey(last) !== placeKey(p)) stack.push(p);
    if (i === h.at) at = stack.length - 1;
  });
  return { stack, at };
}

/** Is this ⌘[ (-1) or ⌘] (1)? Ctrl off a Mac. */
export function navKey(e: KeyboardEvent, mac: boolean): -1 | 1 | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.shiftKey || e.altKey) return null;
  return e.key === '[' ? -1 : e.key === ']' ? 1 : null;
}

/**
 * The app's history for one workspace: records `place` once it holds still,
 * and on ⌘[ / ⌘] (or a mouse's back/forward buttons) calls `go` with the place
 * to restore. A handler that already used the key (Files' own history)
 * prevents its default, and this one stands back.
 */
export function useAppHistory(opts: {
  scope: string;
  place: Place | null;
  valid: (p: Place) => boolean;
  go: (p: Place) => void;
}): void {
  const histories = useRef(new Map<string, History>());
  // The place a step is restoring: what lands next is that step, not a new one.
  const restoring = useRef<string | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const key = opts.place ? placeKey(opts.place) : null;

  useEffect(() => {
    if (!opts.place) return;
    const place = opts.place;
    const scope = opts.scope;
    const t = setTimeout(() => {
      if (restoring.current) {
        restoring.current = null;
        return;
      }
      histories.current.set(scope, record(histories.current.get(scope) ?? emptyHistory(), place));
    }, RECORD_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, opts.scope]);

  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const move = (dir: -1 | 1): boolean => {
      const { scope, valid, go } = latest.current;
      const next = step(histories.current.get(scope) ?? emptyHistory(), dir, valid);
      if (!next) return false;
      histories.current.set(scope, next.history);
      restoring.current = placeKey(next.place);
      go(next.place);
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const dir = navKey(e, mac);
      if (dir === null) return;
      e.preventDefault();
      move(dir);
    };
    // Mouse buttons 3 and 4: back and forward.
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      move(e.button === 3 ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);

  // Exposed for the hub: tabs that closed stop being places to come back to.
  pruneRef.current = (path, open) => {
    const h = histories.current.get(latest.current.scope);
    if (h) histories.current.set(latest.current.scope, pruneTabs(h, path, open));
  };
}

const pruneRef: { current: (path: string, open: HubTab[]) => void } = { current: () => {} };
/** A hub's open tabs changed (TerminalView): drop the closed ones from the history. */
export const noteHubTabs = (path: string, open: HubTab[]) => pruneRef.current(path, open);
