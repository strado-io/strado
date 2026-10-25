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
// The server sends a heartbeat every 15 s; twice that with no event at all means the stream is dead.
const STREAM_SILENT_MS = 30_000;
const STREAM_CHECK_MS = 5_000;
const STREAM_BACKOFF_MS = 1_000;
const STREAM_BACKOFF_MAX_MS = 30_000;
const CLOSED = 2; // EventSource.CLOSED (the test stub may not define it)

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

  // The latest page, again: after a reconnect, and after a send or approval
  // (a safety net when the stream is down). Replaced per Focus by the effect.
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    setEntries([]);
    setMeta(null);
    setHasOlder(false);
    reloadRef.current = () => {};
    if (!focusId) return;
    let live = true;
    const load = () => api.focusJarvis.log(wsId, focusId, { limit: PAGE }).then((page) => {
      if (!live) return;
      setEntries((cur) => merge(page.entries, cur.filter((e) => !page.entries.some((p) => p.id === e.id))));
      setMeta(page.meta);
      setHasOlder(page.entries.length >= PAGE);
    }).catch(() => { /* the stream's reconnect reloads */ });
    reloadRef.current = () => { void load(); };
    void load();

    // The stream, kept alive. A server restart can leave an EventSource
    // CLOSED for good (its retry met an error page), or open but silent:
    // either way it is replaced, with backoff, and the latest page reloaded.
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let lastEvent = Date.now();
    // Only a server that sends named heartbeats can be judged silent.
    let beats = false;
    const connect = (initial = false) => {
      retry = null;
      const source = new EventSource(api.focusJarvis.streamUrl(wsId, focusId));
      es = source;
      lastEvent = Date.now();
      const alive = () => { lastEvent = Date.now(); };
      let openedBefore = false;
      source.addEventListener('open', () => {
        alive();
        // A reopen, or the browser's own reconnect: anything said meanwhile is in the log.
        if (openedBefore || !initial) void load();
        openedBefore = true;
        attempts = 0;
      });
      source.addEventListener('error', () => {
        if (source.readyState === CLOSED) reopen();
      });
      source.addEventListener('heartbeat', () => { beats = true; alive(); });
      source.addEventListener('entry', ((e: MessageEvent) => {
        alive();
        let entry: ChatEntry;
        try { entry = JSON.parse(e.data) as ChatEntry; } catch { return; /* ignore malformed */ }
        setEntries((cur) => upsertEntry(cur, entry));
        onLiveRef.current?.(entry);
      }) as EventListener);
      source.addEventListener('meta', ((e: MessageEvent) => {
        alive();
        try { setMeta(JSON.parse(e.data) as JarvisMeta); } catch { /* ignore malformed */ }
      }) as EventListener);
      return source;
    };
    const reopen = () => {
      if (!live || retry) return;
      es?.close();
      const wait = Math.min(STREAM_BACKOFF_MAX_MS, STREAM_BACKOFF_MS * 2 ** attempts);
      attempts++;
      retry = setTimeout(() => { if (live) connect(); }, wait);
    };
    connect(true);
    const watchdog = setInterval(() => {
      if (beats && !retry && Date.now() - lastEvent > STREAM_SILENT_MS) reopen();
    }, STREAM_CHECK_MS);
    return () => {
      live = false;
      clearInterval(watchdog);
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [wsId, focusId]);

  const send = useCallback(async (text: string) => {
    if (!focusId) return;
    const entry = await api.focusJarvis.send(wsId, focusId, { text, windowId: uiClientId(), context: contextRef.current() });
    setEntries((cur) => upsertEntry(cur, entry));
    reloadRef.current();
  }, [wsId, focusId]);

  const approve = useCallback(async (entryId: string, yes: boolean) => {
    if (!focusId) return;
    await api.focusJarvis.approve(wsId, focusId, entryId, { approve: yes, windowId: uiClientId(), context: contextRef.current() });
    reloadRef.current();
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
