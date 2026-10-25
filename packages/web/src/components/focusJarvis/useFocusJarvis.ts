import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { uiClientId } from '../../lib/uiControl';
import type { ChatEntry, JarvisMeta } from '../../types';

/** Of two copies of one entry, the one to keep: the incoming one, unless it
 * is an earlier copy of a reply already finished (done:false over done:true),
 * or a shorter unfinished copy of one still streaming. */
function newer(have: ChatEntry, incoming: ChatEntry): ChatEntry {
  if (have.type === 'jarvis' && incoming.type === 'jarvis') {
    if (have.done && !incoming.done) return have;
    if (!have.done && !incoming.done && incoming.text.length < have.text.length) return have;
  }
  return incoming;
}

/** Entries arrive whole and again as they grow (a streamed reply): replace by id, else append. */
export function upsertEntry(entries: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i === -1) return [...entries, entry];
  const kept = newer(entries[i]!, entry);
  if (kept === entries[i]) return entries;
  const next = [...entries];
  next[i] = kept;
  return next;
}

/** A reloaded page folded into what the chat holds: one copy per id (see
 * `newer`), in time order, so entries older than the page stay above it. */
export function mergePage(cur: ChatEntry[], page: ChatEntry[]): ChatEntry[] {
  const all = page.reduce(upsertEntry, cur);
  // A stable sort: equal times keep the order they had.
  return all.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i)).map(({ e }) => e);
}

export type FocusJarvis = {
  entries: ChatEntry[];
  meta: JarvisMeta | null;
  /** True while there may be older entries before the first one loaded. */
  hasOlder: boolean;
  send: (text: string) => Promise<void>;
  approve: (entryId: string, approve: boolean) => Promise<void>;
  stop: () => Promise<void>;
  loadOlder: () => Promise<void>;
  /** Re-fetch the latest page now (after a refused approval, say). */
  reload: () => void;
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
    // A stream `meta` that lands while a page is in flight is newer than the page's.
    let metaSeq = 0;
    const load = () => {
      const seq = metaSeq;
      return api.focusJarvis.log(wsId, focusId, { limit: PAGE }).then((page) => {
        if (!live) return;
        setEntries((cur) => mergePage(cur, page.entries));
        if (metaSeq === seq) setMeta(page.meta);
        setHasOlder((had) => had || page.entries.length >= PAGE);
      }).catch(() => { /* the stream's reconnect reloads */ });
    };
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
        try { setMeta(JSON.parse(e.data) as JarvisMeta); metaSeq++; } catch { /* ignore malformed */ }
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

  // W6: an older page lands only in the chat that asked for it (same Focus,
  // still mounted), one at a time.
  const chatRef = useRef<string | null>(null);
  useEffect(() => {
    const key = focusId ? `${wsId}\u0000${focusId}` : null;
    chatRef.current = key;
    return () => { if (chatRef.current === key) chatRef.current = null; };
  }, [wsId, focusId]);
  const olderInFlight = useRef(false);
  const loadOlder = useCallback(async () => {
    const first = entries[0];
    if (!focusId || !first || olderInFlight.current) return;
    const key = `${wsId}\u0000${focusId}`;
    olderInFlight.current = true;
    try {
      const page = await api.focusJarvis.log(wsId, focusId, { before: first.id, limit: PAGE });
      if (chatRef.current !== key) return;
      setEntries((cur) => mergePage(cur, page.entries));
      setHasOlder(page.entries.length >= PAGE);
    } finally {
      olderInFlight.current = false;
    }
  }, [wsId, focusId, entries]);

  const reload = useCallback(() => reloadRef.current(), []);

  return { entries, meta, hasOlder, send, approve, stop, loadOlder, reload };
}
