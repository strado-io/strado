import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, api, type KbFile } from '../api';
import { formatBytes } from '../lib/formatBytes';
import { MarkdownView } from './MarkdownView';

const POLL_MS = 10_000;

const selKey = (p: string) => `strado:kb-selected:${p}`;
const collapsedKey = (p: string) => `strado:kb-collapsed:${p}`;

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function baseOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

// readMarkdownFile's own VALIDATION error for this ships { size, max } in
// details (packages/server/src/services/markdownIndex.ts) — narrows an
// ApiClientError to that shape so the raw "file is larger than 2097152
// bytes" string never reaches the user.
function isFileTooLargeDetails(details: unknown): details is { size: number; max: number } {
  return (
    typeof details === 'object' && details !== null &&
    typeof (details as { size?: unknown }).size === 'number' &&
    typeof (details as { max?: unknown }).max === 'number'
  );
}

// Root files first, then one group per directory in path order.
function groupByDir(files: KbFile[]): { dir: string; files: KbFile[] }[] {
  const groups = new Map<string, KbFile[]>();
  for (const f of files) {
    const d = dirOf(f.path);
    const list = groups.get(d);
    if (list) list.push(f);
    else groups.set(d, [f]);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0] < b[0] ? -1 : 1))
    .map(([dir, fs]) => ({ dir, files: fs }));
}

function loadCollapsed(worktreePath: string): Set<string> {
  try {
    const raw = localStorage.getItem(collapsedKey(worktreePath));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

// Assumes one KnowledgeBasePanel instance per worktreePath (Task 7 mounts a
// keyed instance per worktree). `selected`/`collapsed` are lazily read from
// localStorage once at mount and never re-synced if worktreePath changed
// under an existing instance instead of a remount.
export function KnowledgeBasePanel({
  wsId,
  worktreePath,
  active,
  onOpenInVsCode,
}: {
  wsId: string;
  worktreePath: string;
  active: boolean;
  onOpenInVsCode: (relPath: string) => void;
}) {
  const [files, setFiles] = useState<KbFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [cap, setCap] = useState(0);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(
    () => localStorage.getItem(selKey(worktreePath)),
  );
  // Mirrors `selected` for a synchronous read in refreshList (below) without
  // adding `selected` to its own dependency list — that would recreate
  // refreshList (and the polling effect that depends on it) every time the
  // user clicks a different file, churning the poll interval.
  const selectedRef = useRef(selected);
  const [content, setContent] = useState<string | null>(null);
  const [contentSize, setContentSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // False only for the over-cap case below — Retry can never succeed
  // against a file that's simply too large, so offering it is misleading.
  const [errorRetryable, setErrorRetryable] = useState(true);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(worktreePath));

  // Which path `content` currently holds — `content` is single-valued but
  // mtimeRef records a visit per path, so without this a mtime-match alone
  // is not evidence content belongs to the CURRENT selection: select A,
  // select B (content now holds B's text), reselect A — A's mtime on disk
  // is unchanged, so a mtime-only check would short-circuit and leave B's
  // text on screen under A's header. Kept in sync at every setContent call.
  const contentPathRef = useRef<string | null>(null);
  // Keyed by path: two files can share an mtimeMs (1s-granularity
  // filesystems, cp -p, tar -x), so a single shared ref would show one
  // file's stale content under a different file's header after switching.
  const mtimeRef = useRef<Map<string, number>>(new Map());
  // Mirrors `files` for a synchronous read inside loadFile's catch handler,
  // which otherwise closes over a stale `files` — loadFile is only
  // recreated when wsId/worktreePath change, not on every poll.
  const filesRef = useRef<KbFile[]>([]);
  // Only the very first listing response may set a user-visible error —
  // once we have any good data, later poll failures keep it silently.
  const hasLoadedOnceRef = useRef(false);
  // Monotonic guard against a request whose wsId/worktreePath changed
  // underneath it while in flight, in case this instance is ever reused
  // across worktrees rather than remounted (see the assumption noted
  // above). A boolean can't do this: React runs an effect's cleanup and the
  // next run's setup synchronously in the same flush when deps change, so a
  // plain `live = false` (cleanup) / `live = true` (setup) pair is back to
  // true again long before a slower, superseded request resolves — nothing
  // is actually distinguishing "this generation" from "the next one". An
  // ever-incrementing counter never gets un-done by a later generation's
  // setup, so a call that captured an older epoch stays stale forever once
  // a newer one has started.
  const epochRef = useRef(0);
  useEffect(() => {
    return () => { epochRef.current += 1; };
  }, [wsId, worktreePath]);

  const loadList = useCallback(async () => {
    const epoch = epochRef.current;
    try {
      const r = await api.kb.files(wsId, worktreePath);
      if (epochRef.current !== epoch) return null; // superseded mid-flight
      filesRef.current = r.files;
      setFiles(r.files);
      setTruncated(r.truncated);
      setCap(r.cap);
      setListError(null);
      hasLoadedOnceRef.current = true;
      setFilesLoaded(true);
      return r.files;
    } catch (e) {
      if (epochRef.current !== epoch) return null;
      if (!hasLoadedOnceRef.current) {
        setListError(e instanceof Error ? e.message : 'Failed to load files');
      }
      setFilesLoaded(true);
      return null; // subsequent poll failures otherwise keep the last good data — no error spam
    }
  }, [wsId, worktreePath]);

  const loadFile = useCallback(async (rel: string) => {
    const epoch = epochRef.current;
    setError(null);
    try {
      const r = await api.kb.file(wsId, worktreePath, rel);
      if (epochRef.current !== epoch) return;
      setContent(r.content);
      contentPathRef.current = rel;
      setContentSize(r.size);
      mtimeRef.current.set(rel, r.mtimeMs);
    } catch (e) {
      if (epochRef.current !== epoch) return;
      setContent(null);
      contentPathRef.current = null;
      if (e instanceof ApiClientError && e.code === 'VALIDATION' && isFileTooLargeDetails(e.details)) {
        setError(`This file is ${formatBytes(e.details.size)}, over the ${formatBytes(e.details.max)} limit for viewing here.`);
        setErrorRetryable(false);
      } else {
        setError(e instanceof Error ? e.message : 'Failed to read file');
        setErrorRetryable(true);
      }
      // Absence from the listing is NOT evidence a file is unreadable —
      // listMarkdownFiles filters gitignored paths but readMarkdownFile
      // doesn't, so a gitignored doc is a real, readable file that's simply
      // excluded from the browse list. Only pair it with an actual failed
      // read to call a selection genuinely gone, and recover so the pane
      // doesn't stay wedged on a dead path. Also requires a real listing to
      // have landed at least once: filesRef starts as [] before the first
      // response, so "not in filesRef" is otherwise always true and a
      // transient failure at startup (before any poll has run) would evict
      // a perfectly good selection with nothing left to ever restore it —
      // an active panel self-heals via refreshList's fill, but a hidden one
      // (see the content-load effect's own active gate below) never gets
      // the chance to.
      if (hasLoadedOnceRef.current && !filesRef.current.some((f) => f.path === rel)) {
        const fallback = filesRef.current[0]?.path ?? null;
        setSelected(fallback);
        selectedRef.current = fallback;
        // Persisted here, at the point selected actually changes, rather
        // than from an effect keyed on worktreePath — see the note on the
        // component's assumption above for why an effect can't do this
        // correctly (it can't tell which path a stale value belongs to).
        // A null fallback (no files left at all) still needs the key
        // cleared, not skipped — otherwise it keeps naming a dead file
        // forever, and the next mount wastes a load on it and flashes Retry.
        if (fallback) localStorage.setItem(selKey(worktreePath), fallback);
        else localStorage.removeItem(selKey(worktreePath));
      }
    }
  }, [wsId, worktreePath]);

  // Loads the listing and, only if nothing was already selected, fills in a
  // selection from it. Shared by the poll loop and the listing Retry button
  // — calling loadList() directly from Retry left the pane showing "Select a
  // document to read." until the next scheduled poll tick filled it in.
  const refreshList = useCallback(async () => {
    const next = await loadList();
    if (next && selectedRef.current == null) {
      const first = next[0]?.path ?? null;
      setSelected(first);
      selectedRef.current = first;
      if (first) localStorage.setItem(selKey(worktreePath), first);
      else localStorage.removeItem(selKey(worktreePath));
    }
    return next;
  }, [loadList, worktreePath]);

  // First load + polling, gated on `active` (an inactive panel does
  // nothing). The recurring poll is additionally gated on the document
  // being visible — a backgrounded window shouldn't spend a request every
  // 10s nobody can see the result of — but the INITIAL load is not: an
  // active-but-hidden panel (window occluded, tab still active) still needs
  // its listing ready for the moment the user looks at it, and it's one
  // ~20ms request, not a repeating poll. Gating the first load on
  // visibility too meant a hidden window's active tab never fetched a
  // listing at all — rail stuck on "Loading…" forever, right next to a
  // fully-rendered content pane (loadFile isn't visibility-gated), until
  // the visibilitychange listener below finally fired. An existing
  // selection is never reconsidered here just because the newest listing
  // doesn't include it — see loadFile's catch for why.
  useEffect(() => {
    if (!active) return;
    void refreshList();
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      await refreshList();
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    // Refresh immediately on refocus instead of waiting up to POLL_MS.
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, refreshList]);

  // Load on selection change, and reload when the open file changed on disk.
  // Gated on `active` — Task 7 keeps hidden panes mounted, and without this
  // a hidden pane with a persisted selection fetched its file content on
  // every app start regardless of whether the user ever looks at it: a
  // 33-worktree machine with 33 remembered KB tabs would fire 33 reads of
  // up to 2MB into 33 offscreen React trees.
  //
  // Persistence for `selected` does NOT live here — it lives at each call
  // site that actually changes it (selectFile below, refreshList's fill,
  // loadFile's catch fallback), each of which closes over the exact
  // worktreePath its own new value belongs to. An effect keyed on
  // worktreePath can't do this correctly: `selected` is a lazy useState that
  // never re-derives for a new path, so on a path change this effect would
  // still be holding the OLD worktree's value with no way to tell it apart
  // from a legitimately-current one — a single-run guard only delays that
  // write to the next time `files` changes (which happens moments later, as
  // soon as the new worktree's listing loads), it doesn't prevent it.
  useEffect(() => {
    if (!active) return;
    if (!selected) { setContent(null); contentPathRef.current = null; return; }
    const listed = files.find((f) => f.path === selected);
    // Both conditions are required: an unchanged mtime only proves the file
    // hasn't changed on disk, not that `content` (single-valued) currently
    // holds THIS path's text — see contentPathRef's declaration for why.
    if (contentPathRef.current === selected && listed && mtimeRef.current.get(selected) === listed.mtimeMs) return;
    void loadFile(selected);
  }, [selected, files, loadFile, active]);

  // Selects a file and persists it under the worktree this closure was
  // created for — the one unambiguous answer to "which path does this
  // belong to" (see the note above).
  const selectFile = useCallback((path: string) => {
    setSelected(path);
    selectedRef.current = path;
    localStorage.setItem(selKey(worktreePath), path);
  }, [worktreePath]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  const groups = useMemo(() => groupByDir(shown), [shown]);

  // Persisted here, next to the state update, rather than from an effect
  // (same reasoning as selectFile above) or inside the updater passed to
  // setCollapsed (that updater must stay pure — StrictMode double-invokes
  // it, which would double the write).
  const toggle = (dir: string) => {
    const next = new Set(collapsed);
    if (next.has(dir)) next.delete(dir);
    else next.add(dir);
    setCollapsed(next);
    localStorage.setItem(collapsedKey(worktreePath), JSON.stringify([...next]));
  };

  // Stable identity required by MarkdownView, which memoizes its component
  // map (and thus its whole parsed render) on [currentDir, onNavigate] — an
  // inline arrow here would rebuild that map, and re-parse the document, on
  // every keystroke in the filter input above. Depending on selectFile (and
  // transitively on worktreePath) doesn't break that: worktreePath is
  // constant across keystroke-driven re-renders, so this stays stable for
  // exactly the case the memo cares about.
  const handleNavigate = useCallback((rel: string) => selectFile(rel), [selectFile]);

  return (
    <div className="flex h-full w-full min-h-0">
      <aside className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-900">
        <div className="border-b border-zinc-900 p-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none"
          />
        </div>
        {truncated && (
          <div className="border-b border-zinc-900 px-2 py-1.5 text-[11px] text-amber-500/80">
            Large worktree — showing only the first {cap} files.
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {!filesLoaded ? (
            <p className="px-3 py-2 text-xs text-zinc-500">Loading…</p>
          ) : listError ? (
            <div className="px-3 py-2 text-xs text-zinc-500">
              <p className="mb-2">{listError}</p>
              <button
                onClick={() => void refreshList()}
                className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900"
              >
                Retry
              </button>
            </div>
          ) : files.length === 0 ? (
            <p className="px-3 py-2 text-xs text-zinc-500">No markdown files in this worktree.</p>
          ) : (
            groups.map((g) => (
              <div key={g.dir || '<root>'}>
                {g.dir && (
                  <button
                    onClick={() => toggle(g.dir)}
                    aria-expanded={!collapsed.has(g.dir)}
                    aria-label={`${g.dir} folder`}
                    className="w-full truncate px-2 py-1 text-left text-[11px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
                  >
                    {g.dir}
                  </button>
                )}
                {!collapsed.has(g.dir) &&
                  g.files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => selectFile(f.path)}
                      title={f.path}
                      className={
                        f.path === selected
                          ? 'block w-full truncate rounded px-3 py-1 text-left text-xs text-zinc-100 bg-zinc-900'
                          : 'block w-full truncate rounded px-3 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                      }
                    >
                      {baseOf(f.path)}
                    </button>
                  ))}
              </div>
            ))
          )}
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected && (
          <header className="flex shrink-0 items-center gap-2 border-b border-zinc-900 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{selected}</span>
            <button
              onClick={() => navigator.clipboard?.writeText(selected).catch(() => undefined)}
              className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300"
            >
              Copy path
            </button>
            <button
              onClick={() => onOpenInVsCode(selected)}
              className="shrink-0 text-xs text-sky-400 hover:underline"
            >
              Open in VS Code
            </button>
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="p-4 text-sm text-zinc-500">
              <p className="mb-2">{error}</p>
              {errorRetryable && (
                <button
                  onClick={() => selected && void loadFile(selected)}
                  className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900"
                >
                  Retry
                </button>
              )}
            </div>
          ) : content == null ? (
            <p className="p-4 text-sm text-zinc-600">
              {selected ? 'Loading…' : 'Select a document to read.'}
            </p>
          ) : (
            // MarkdownView deliberately ships no base typography, padding, or
            // width constraint — that's this panel's job to own.
            <div className="mx-auto max-w-3xl px-6 py-4 text-sm leading-relaxed text-zinc-300">
              <MarkdownView
                content={content}
                size={contentSize}
                currentDir={dirOf(selected ?? '')}
                onNavigate={handleNavigate}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
