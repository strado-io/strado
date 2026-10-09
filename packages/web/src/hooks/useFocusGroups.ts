import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, type FocusGroup } from '../api';

// One list per workspace, shared by every consumer (three sidebar panes, the
// dashboard's ⌥⌘-arrow cycling, ⌘K). A mutation shows the server's answer at
// once, then refetches the whole list so changes from other devices (or a
// group deleted elsewhere) land too. Each load is numbered and only the newest
// one may write, so an older reply that arrives late can't roll the list back.
type Snapshot = { groups: FocusGroup[]; loaded: boolean; fresh: boolean };
const EMPTY: Snapshot = { groups: [], loaded: false, fresh: false };
const snapshots = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<void>>();
const latestLoad = new Map<string, number>();
const listeners = new Set<() => void>();

const emit = () => { for (const l of listeners) l(); };
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

export function __resetFocusGroups() {
  snapshots.clear();
  inflight.clear();
  latestLoad.clear();
}

function setGroups(wsId: string, fn: (groups: FocusGroup[]) => FocusGroup[], fresh = snapshots.get(wsId)?.fresh ?? false) {
  snapshots.set(wsId, { groups: fn(snapshots.get(wsId)?.groups ?? []), loaded: true, fresh });
  emit();
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
    .then(() => api.groups.list(wsId))
    .then((groups) => { if (isLatest()) setGroups(wsId, () => groups, true); })
    // A failed load shows as "no groups" (the section hides, the sidebar still
    // works) but stays un-fresh, so the next mount or window focus retries.
    .catch(() => { if (isLatest()) setGroups(wsId, (prev) => prev, false); })
    .finally(() => { if (inflight.get(wsId) === p) inflight.delete(wsId); });
  inflight.set(wsId, p);
  return p;
}

export function useFocusGroups(wsId: string) {
  const snap = useSyncExternalStore(subscribe, () => snapshots.get(wsId) ?? EMPTY);

  useEffect(() => {
    if (!snapshots.get(wsId)?.fresh) void load(wsId);
    // Another device may have changed the groups while this window was away.
    const onFocus = () => void load(wsId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [wsId]);

  // Show the server's answer now; then refetch the list whether or not the
  // call succeeded (a 404 means the group went away elsewhere).
  const mutate = useCallback(async <T,>(call: () => Promise<T>, apply: (result: T) => void): Promise<T> => {
    try {
      const result = await call();
      apply(result);
      return result;
    } finally {
      void load(wsId, true);
    }
  }, [wsId]);
  const replace = useCallback((g: FocusGroup) => setGroups(wsId, (gs) => gs.map((x) => (x.id === g.id ? g : x))), [wsId]);

  const create = useCallback((name: string, members?: string[]) =>
    mutate(() => api.groups.create(wsId, { name, members }), (g) => setGroups(wsId, (gs) => [...gs, g])), [wsId, mutate]);
  const rename = useCallback(async (id: string, name: string) => {
    await mutate(() => api.groups.update(wsId, id, { name }), replace);
  }, [wsId, mutate, replace]);
  const setMembership = useCallback(async (id: string, memberId: string, member: boolean) => {
    await mutate(() => api.groups.update(wsId, id, member ? { addMembers: [memberId] } : { removeMembers: [memberId] }), replace);
  }, [wsId, mutate, replace]);
  const remove = useCallback(async (id: string) => {
    await mutate(() => api.groups.remove(wsId, id), () => setGroups(wsId, (gs) => gs.filter((x) => x.id !== id)));
  }, [wsId, mutate]);

  return { groups: snap.groups, loaded: snap.loaded, create, rename, setMembership, remove };
}
