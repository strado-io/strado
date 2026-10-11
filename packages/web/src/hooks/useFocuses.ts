import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, type Focus, type FocusTicket } from '../api';
import { clearLooseWorktrees, readLooseWorktrees } from './looseWorktrees';

// Focuses for one workspace, shared by every consumer (the sidebar's panes,
// the pill popover, ⌘K, the Dashboard's open-adds-to-focus). A mutation
// shows the server's answer at once, then refetches the whole list so changes
// from other devices land too. Each load is numbered and only the newest one
// may write, so an older reply that arrives late can't roll the list back.
//
// The active Focus is per device: `strado:active-focus-by-ws` holds one id
// per workspace. An id that is no longer in the loaded list counts as none.
type Snapshot = { focuses: Focus[]; loaded: boolean; fresh: boolean };
const EMPTY: Snapshot = { focuses: [], loaded: false, fresh: false };
const snapshots = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<void>>();
const latestLoad = new Map<string, number>();
const migrated = new Set<string>();
const listeners = new Set<() => void>();

const ACTIVE_KEY = 'strado:active-focus-by-ws';
let activeCache: Record<string, string> | null = null;

const emit = () => { for (const l of listeners) l(); };
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

export function __resetFocuses() {
  snapshots.clear();
  inflight.clear();
  latestLoad.clear();
  migrated.clear();
  activeCache = null;
}

function readActiveAll(): Record<string, string> {
  if (activeCache) return activeCache;
  try {
    const v = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? '{}') as unknown;
    activeCache = v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([, id]) => typeof id === 'string')) as Record<string, string>
      : {};
  } catch { activeCache = {}; }
  return activeCache;
}
export function readActiveFocusId(wsId: string): string | null {
  return readActiveAll()[wsId] ?? null;
}
function writeActive(wsId: string, id: string | null) {
  const next = { ...readActiveAll() };
  if (id) next[wsId] = id; else delete next[wsId];
  activeCache = next;
  try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(next)); } catch { /* storage off */ }
  emit();
}

function setFocuses(wsId: string, fn: (focuses: Focus[]) => Focus[], fresh = snapshots.get(wsId)?.fresh ?? false) {
  snapshots.set(wsId, { focuses: fn(snapshots.get(wsId)?.focuses ?? []), loaded: true, fresh });
  emit();
}

// One-time per workspace: the pre-Focus "Working on" list becomes a Focus of
// the same name and is activated, so nothing a user had open disappears.
async function migrateLoose(wsId: string, focuses: Focus[]): Promise<Focus[]> {
  if (migrated.has(wsId)) return focuses;
  migrated.add(wsId);
  const ids = readLooseWorktrees(wsId);
  if (ids.length === 0 || focuses.length > 0) return focuses;
  const created = await api.focuses.create(wsId, { name: 'Working on', members: ids });
  clearLooseWorktrees(wsId);
  writeActive(wsId, created.id);
  return [created];
}

/** `force` skips joining an in-flight load: after a mutation that load may predate it. */
function load(wsId: string, force = false): Promise<void> {
  const pending = inflight.get(wsId);
  if (pending && !force) return pending;
  const mine = (latestLoad.get(wsId) ?? 0) + 1;
  latestLoad.set(wsId, mine);
  const isLatest = () => latestLoad.get(wsId) === mine;
  // Through a .then so a synchronous throw lands in the same catch as a
  // rejected request.
  const p: Promise<void> = Promise.resolve()
    .then(() => api.focuses.list(wsId))
    .then((focuses) => migrateLoose(wsId, focuses))
    .then((focuses) => { if (isLatest()) setFocuses(wsId, () => focuses, true); })
    // A failed load shows as "no focuses" (the sidebar still works) but stays
    // un-fresh, so the next mount or window focus retries.
    .catch(() => { if (isLatest()) setFocuses(wsId, (prev) => prev, false); })
    .finally(() => { if (inflight.get(wsId) === p) inflight.delete(wsId); });
  inflight.set(wsId, p);
  return p;
}

/** The active Focus of a workspace, from the shared snapshot; null until loaded or when none. */
export function activeFocusOf(wsId: string): Focus | null {
  const id = readActiveFocusId(wsId);
  return (id && snapshots.get(wsId)?.focuses.find((f) => f.id === id)) || null;
}

/** Make sure the list is loaded (for callers outside React, like the Dashboard's open path). */
export function ensureFocusesLoaded(wsId: string): Promise<void> {
  return snapshots.get(wsId)?.fresh ? Promise.resolve() : load(wsId);
}

export function useFocuses(wsId: string) {
  const snap = useSyncExternalStore(subscribe, () => snapshots.get(wsId) ?? EMPTY);
  const activeId = useSyncExternalStore(subscribe, () => readActiveFocusId(wsId));
  const active = (activeId && snap.focuses.find((f) => f.id === activeId)) || null;

  useEffect(() => {
    if (!snapshots.get(wsId)?.fresh) void load(wsId);
    // Another device may have changed the focuses while this window was away.
    const onFocus = () => void load(wsId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [wsId]);

  // Show the server's answer now; then refetch the list whether or not the
  // call succeeded (a 404 means the focus went away elsewhere).
  const mutate = useCallback(async <T,>(call: () => Promise<T>, apply: (result: T) => void): Promise<T> => {
    try {
      const result = await call();
      apply(result);
      return result;
    } finally {
      void load(wsId, true);
    }
  }, [wsId]);
  const replace = useCallback((f: Focus) => setFocuses(wsId, (fs) => fs.map((x) => (x.id === f.id ? f : x))), [wsId]);

  // Activation is local and instant; the server only learns the time, for ordering.
  const activate = useCallback((id: string | null) => {
    writeActive(wsId, id);
    if (id) void mutate(() => api.focuses.update(wsId, id, { touch: true }), replace).catch(() => undefined);
  }, [wsId, mutate, replace]);
  /** Creates and activates. */
  const create = useCallback(async (name: string, members?: string[], ticket?: FocusTicket) => {
    const f = await mutate(() => api.focuses.create(wsId, { name, members, ticket }), (created) => setFocuses(wsId, (fs) => [...fs, created]));
    writeActive(wsId, f.id);
    return f;
  }, [wsId, mutate]);
  const rename = useCallback(async (id: string, name: string) => {
    await mutate(() => api.focuses.update(wsId, id, { name }), replace);
  }, [wsId, mutate, replace]);
  const setMembership = useCallback(async (id: string, memberId: string, member: boolean) => {
    await mutate(() => api.focuses.update(wsId, id, member ? { addMembers: [memberId] } : { removeMembers: [memberId] }), replace);
  }, [wsId, mutate, replace]);
  const addMembers = useCallback(async (id: string, memberIds: string[]) => {
    if (memberIds.length === 0) return;
    await mutate(() => api.focuses.update(wsId, id, { addMembers: memberIds }), replace);
  }, [wsId, mutate, replace]);
  const remove = useCallback(async (id: string) => {
    await mutate(() => api.focuses.remove(wsId, id), () => setFocuses(wsId, (fs) => fs.filter((x) => x.id !== id)));
    if (readActiveFocusId(wsId) === id) writeActive(wsId, null);
  }, [wsId, mutate]);

  return { focuses: snap.focuses, loaded: snap.loaded, active, activeId, activate, create, rename, setMembership, addMembers, remove };
}
