import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { uiClientId } from '../../lib/uiControl';
import type { ChatEntry, JarvisMeta } from '../../types';

/** Entries arrive whole and again as they grow (a streamed reply): replace by id, else append. */
export function upsertEntry(entries: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i === -1) return [...entries, entry];
  const next = [...entries];
  next[i] = entry;
  return next;
}

const merge = (entries: ChatEntry[], incoming: ChatEntry[]) => incoming.reduce(upsertEntry, entries);

export type FocusJarvis = {
  entries: ChatEntry[];
  meta: JarvisMeta | null;
  /** True while there may be older entries before the first one loaded. */
  hasOlder: boolean;
  send: (text: string) => Promise<void>;
  approve: (entryId: string, approve: boolean) => Promise<void>;
  stop: () => Promise<void>;
  loadOlder: () => Promise<void>;
};

const PAGE = 100;

/** A Focus's Jarvis chat: the log, then live `entry`/`meta` events over SSE.
 * `getContext` is read at send time, so Jarvis sees this window as it is now;
 * `onLive` hears each streamed entry (not the loaded log). */
export function useFocusJarvis(wsId: string, focusId: string | null, getContext: () => unknown, onLive?: (entry: ChatEntry) => void): FocusJarvis {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [meta, setMeta] = useState<JarvisMeta | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const contextRef = useRef(getContext);
  contextRef.current = getContext;
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;

  useEffect(() => {
    setEntries([]);
    setMeta(null);
    setHasOlder(false);
    if (!focusId) return;
    let live = true;
    const load = () => api.focusJarvis.log(wsId, focusId, { limit: PAGE }).then((page) => {
      if (!live) return;
      setEntries((cur) => merge(page.entries, cur.filter((e) => !page.entries.some((p) => p.id === e.id))));
      setMeta(page.meta);
      setHasOlder(page.entries.length >= PAGE);
    }).catch(() => { /* the stream's reconnect reloads */ });
    void load();
    const es = new EventSource(api.focusJarvis.streamUrl(wsId, focusId));
    let opened = false;
    // A reconnect may have missed entries: reload the latest page.
    es.addEventListener('open', () => { if (opened) void load(); opened = true; });
    es.addEventListener('entry', ((e: MessageEvent) => {
      let entry: ChatEntry;
      try { entry = JSON.parse(e.data) as ChatEntry; } catch { return; /* ignore malformed */ }
      setEntries((cur) => upsertEntry(cur, entry));
      onLiveRef.current?.(entry);
    }) as EventListener);
    es.addEventListener('meta', ((e: MessageEvent) => {
      try { setMeta(JSON.parse(e.data) as JarvisMeta); } catch { /* ignore malformed */ }
    }) as EventListener);
    return () => { live = false; es.close(); };
  }, [wsId, focusId]);

  const send = useCallback(async (text: string) => {
    if (!focusId) return;
    const entry = await api.focusJarvis.send(wsId, focusId, { text, windowId: uiClientId(), context: contextRef.current() });
    setEntries((cur) => upsertEntry(cur, entry));
  }, [wsId, focusId]);

  const approve = useCallback(async (entryId: string, yes: boolean) => {
    if (!focusId) return;
    await api.focusJarvis.approve(wsId, focusId, entryId, { approve: yes, windowId: uiClientId(), context: contextRef.current() });
  }, [wsId, focusId]);

  const stop = useCallback(async () => {
    if (focusId) await api.focusJarvis.stop(wsId, focusId);
  }, [wsId, focusId]);

  const loadOlder = useCallback(async () => {
    const first = entries[0];
    if (!focusId || !first) return;
    const page = await api.focusJarvis.log(wsId, focusId, { before: first.id, limit: PAGE });
    setEntries((cur) => [...page.entries.filter((e) => !cur.some((c) => c.id === e.id)), ...cur]);
    setHasOlder(page.entries.length >= PAGE);
  }, [wsId, focusId, entries]);

  return { entries, meta, hasOlder, send, approve, stop, loadOlder };
}
