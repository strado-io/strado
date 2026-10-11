import { useCallback, useEffect, useState } from 'react';

// Worktrees shown on their own at the top of Working on: ones you opened that
// no group holds. Per device and per workspace, like the other focus prefs.
// The key is the old pinned-worktrees key on purpose — pins became loose rows,
// so nothing needs migrating. Every instance re-reads on one change event, and
// the Dashboard adds rows from outside React through addLooseWorktree.
const KEY = 'strado:pinned-worktrees-by-ws';
const CHANGE_EVENT = 'strado:loose-worktrees-change';

function readAll(): Record<string, string[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).flatMap(([wsId, values]) =>
        Array.isArray(values) ? [[wsId, values.filter((v): v is string => typeof v === 'string')]] : [],
      ),
    );
  } catch {
    return {};
  }
}

export function readLooseWorktrees(wsId: string): string[] {
  return readAll()[wsId] ?? [];
}

function write(wsId: string, ids: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [wsId]: ids })); } catch { /* storage off */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function addLooseWorktree(wsId: string, id: string) {
  const cur = readLooseWorktrees(wsId);
  if (!cur.includes(id)) write(wsId, [...cur, id]);
}

export function removeLooseWorktree(wsId: string, id: string) {
  const cur = readLooseWorktrees(wsId);
  if (cur.includes(id)) write(wsId, cur.filter((x) => x !== id));
}

export function useLooseWorktrees(wsId: string) {
  const [ids, setIds] = useState(() => readLooseWorktrees(wsId));
  useEffect(() => {
    const sync = () => setIds(readLooseWorktrees(wsId));
    sync();
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, [wsId]);
  const add = useCallback((id: string) => addLooseWorktree(wsId, id), [wsId]);
  const remove = useCallback((id: string) => removeLooseWorktree(wsId, id), [wsId]);
  return { ids, add, remove };
}
