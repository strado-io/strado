// The Files tab: a light, read-only look at a worktree — its folders on the
// left (loaded as they open), files in tabs on the right — one pane, or two
// side by side (fileTabs.ts has the rules). The same for a runner's
// worktree, read through the runner's own API. For "what's in this file / what
// changed here"; the person's own editor stays one click away (Open in editor).
// Code navigation lives here: go to definition (one exact answer jumps, else a
// picker), references, ⌘⇧F search, and back/forward through where you went.
import { useCallback, useEffect, useId, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, type RemoteFilesTarget } from '../../api';
import type { FileAskContext, LspServerId, LspServerStatus, NavAnswer, NavHit, SearchQuery } from '../../types';
import { requestRunInShell } from '../../lib/runInShell';
import { FileTree } from './FileTree';
import { FileViewer, type FileAt } from './FileViewer';
import { NavPanel, navTitle, type NavKind } from './NavPanel';
import { SearchPanel } from './SearchPanel';
import { filesError } from './errors';
import { activeTab, loadTabs, saveTabs, tabsReducer, type OpenMode, type Pane, type PaneIndex } from './fileTabs';

/** Back/forward keep this many places each way. */
export const HISTORY_CAP = 50;
/** A cursor move within this many lines of the current place updates it instead of adding one. */
export const NEAR_LINES = 10;
/** A place in the history: a file position and the pane it was in. */
type Place = FileAt & { pane: PaneIndex };
const capped = (list: Place[], at: Place) => [...list, at].slice(-HISTORY_CAP);

/** Narrower than this (px), the tree header's chips show icons only. */
const COMPACT_BELOW = 220;

type NavState = { kind: NavKind; at: Place; answer: NavAnswer | null; error: string | null; slow?: boolean };
/** A lookup still going after this long is probably a project loading; say so. */
export const SLOW_LOOKUP_MS = 800;
const TS_LIKE = /\.(?:[cm]?[jt]sx?)$/i;
/** What a slow first lookup is waiting for. */
const slowWords = (path: string) => `${TS_LIKE.test(path) ? 'Loading TypeScript project' : 'Starting the language server'}… (first lookup takes a while)`;

export type FilesTabProps = {
  wsId: string;
  worktreePath: string;
  /** `name` is the runner's, for "install it on <name>". */
  remote?: { runnerId: string; remoteWsId: string; name?: string };
  /** Open this file (and line); a new nonce opens it again. */
  openPath?: { path: string; line?: number; nonce: number };
  onAskAgent?: (ctx: FileAskContext) => void;
  /** The person's own desktop editor, at a file and line (this machine only). */
  onOpenInEditor?: (path: string, line: number) => void;
  /** The chosen editor's name ("Cursor", "VS Code"), for the too-large note; "editor" when unknown. */
  editorLabel?: string;
  /** The active file and its cursor line (1-based), or null with none: for the pane title bar's editor button. */
  onActiveFileChange?: (file: { path: string; line: number } | null) => void;
};

export function FilesTab({ wsId, worktreePath, remote, openPath, onAskAgent, onOpenInEditor, editorLabel, onActiveFileChange }: FilesTabProps) {
  const runnerId = remote?.runnerId;
  const remoteWsId = remote?.remoteWsId;
  const where: RemoteFilesTarget | undefined = runnerId && remoteWsId ? { runnerId, remoteWsId } : undefined;
  const [changedOnly, setChangedOnly] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  // Open tabs (and the side pane), kept per worktree.
  const scope = `${wsId}\0${runnerId ?? ''}\0${worktreePath}`;
  const [tabs, dispatch] = useReducer(tabsReducer, scope, loadTabs);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const loadedScope = useRef(scope);
  useEffect(() => {
    if (loadedScope.current === scope) return;
    loadedScope.current = scope;
    const next = loadTabs(scope);
    dispatch({ type: 'load', state: next });
    // Another worktree: its own places, not this one's history.
    setBack([]); setForward([]); setNav(null); navAbort.current?.abort();
    const t = activeTab(next);
    here.current = t ? { path: t.path, line: t.line, col: t.col, pane: next.focus } : null;
  }, [scope]);
  useEffect(() => { if (loadedScope.current === scope) saveTabs(scope, tabs); }, [scope, tabs]);
  const selected = activeTab(tabs)?.path ?? null;
  // The pane's title bar opens the active file at its cursor in the person's editor.
  const activeLine = activeTab(tabs)?.line ?? null;
  const reportActive = useRef(onActiveFileChange);
  reportActive.current = onActiveFileChange;
  useEffect(() => {
    reportActive.current?.(selected && activeLine != null ? { path: selected, line: activeLine } : null);
  }, [selected, activeLine]);
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(openPath ? { path: openPath.path, nonce: 0 } : selected ? { path: selected, nonce: 0 } : null);
  const seq = useRef(0);
  // Where you went, for ⌘[ / ⌘] (or Alt←/→), across tabs and panes. `here` is the last place opened or navigated from.
  const [back, setBack] = useState<Place[]>([]);
  const [forward, setForward] = useState<Place[]>([]);
  const here = useRef<Place | null>(null);
  if (here.current === null) {
    const t = activeTab(tabs);
    if (t) here.current = { path: t.path, line: t.line, col: t.col, pane: tabs.focus };
  }
  const [nav, setNav] = useState<NavState | null>(null);
  const navAbort = useRef<AbortController | null>(null);
  const [searching, setSearching] = useState(false);
  // Refresh: agents change files all the time; re-list the open folders and re-read the open file.
  const [reloadKey, setReloadKey] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  // The tree header never wraps: below this width the chips drop their words.
  const header = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = header.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < COMPACT_BELOW));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // No polling: re-check when the person comes back — the tab shown again (it
  // was hidden in the hub), the window refocused, or the app visible again.
  // At most once every 2s, so a burst of those is one reload.
  useEffect(() => {
    let last = Date.now();
    let shown = true;
    const refresh = () => {
      if (Date.now() - last < 2000) return;
      last = Date.now();
      setReloadKey((k) => k + 1);
    };
    const onVisible = () => { if (document.visibilityState === 'visible' && shown) refresh(); };
    const onFocus = () => { if (shown) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    let io: IntersectionObserver | null = null;
    if (root.current && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        const now = entries.some((e) => e.isIntersecting);
        if (now && !shown) refresh();
        shown = now;
      });
      io.observe(root.current);
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      io?.disconnect();
    };
  }, []);

  /** Show a file: in its open tab (going to `line` if given), else a new tab of `mode`. */
  const open = useCallback((to: { path: string; line?: number; col?: number }, mode: OpenMode, pane: PaneIndex = tabsRef.current.focus) => {
    // Going somewhere else drops a definition still being looked up (a starting
    // server can take a while), so it can't pull you away later.
    navAbort.current?.abort();
    setNav((n) => (n && !n.answer && !n.error ? null : n));
    dispatch({ type: 'open', pane, path: to.path, line: to.line, col: to.col, mode });
    setReveal({ path: to.path, nonce: ++seq.current });
    const p: PaneIndex = pane === 1 ? 1 : 0;
    const have = tabsRef.current.panes[p]?.tabs.find((t) => t.path === to.path);
    here.current = { path: to.path, line: to.line ?? have?.line ?? 1, col: to.col ?? have?.col ?? 1, pane: p };
  }, []);
  /** A jump you can come back from. */
  const jump = useCallback((from: Place | null, to: { path: string; line?: number; col?: number }, mode: OpenMode = 'permanent', pane?: PaneIndex) => {
    if (from) setBack((b) => capped(b, from));
    setForward([]);
    open(to, mode, pane);
  }, [open]);
  // The cursor moved in a file (VS Code's rule): far from the current place,
  // that place goes into the history; near it, the place just moves, so arrow
  // keys and nearby clicks don't fill the history.
  const moved = useCallback((at: FileAt, pane: PaneIndex) => {
    dispatch({ type: 'cursor', pane, path: at.path, line: at.line, col: at.col });
    const cur = here.current;
    here.current = { ...at, pane };
    if (!cur || (cur.path === at.path && Math.abs(cur.line - at.line) <= NEAR_LINES)) return;
    setBack((b) => capped(b, cur));
    setForward([]);
  }, []);
  // Back and forward reopen a closed file, in the preview tab, rather than refuse.
  const paneFor = (p: Place): PaneIndex => (p.pane < tabsRef.current.panes.length ? p.pane : 0);
  const goBack = () => {
    const prev = back[back.length - 1];
    if (!prev) return;
    // Read where we are before open() moves it.
    const from = here.current;
    setBack(back.slice(0, -1));
    if (from) setForward((f) => capped(f, from));
    open(prev, 'preview', paneFor(prev));
  };
  const goForward = () => {
    const next = forward[forward.length - 1];
    if (!next) return;
    const from = here.current;
    setForward(forward.slice(0, -1));
    if (from) setBack((b) => capped(b, from));
    open(next, 'preview', paneFor(next));
  };

  useEffect(() => {
    if (!openPath) return;
    // Opening from elsewhere (a chat link, the picker) is its own tab, and a place you can come back from.
    const from = here.current;
    // No line asked: an open tab stays where it was (a new one starts at the top).
    const to = { path: openPath.path, line: openPath.line, col: openPath.line ? 1 : undefined };
    if (from && (from.path !== to.path || (to.line != null && Math.abs(from.line - to.line) > NEAR_LINES))) jump(from, to);
    else open(to, 'permanent');
  }, [openPath?.path, openPath?.line, openPath?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable per worktree and toggle, so the tree reloads only when one changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadDir = useCallback((dir: string) => api.files.tree(wsId, worktreePath, dir, { ignored: showIgnored }, where), [wsId, worktreePath, showIgnored, runnerId, remoteWsId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const read = useCallback((p: string) => api.files.read(wsId, worktreePath, p, where), [wsId, worktreePath, runnerId, remoteWsId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const marks = useCallback((p: string) => api.files.marks(wsId, worktreePath, p, where), [wsId, worktreePath, runnerId, remoteWsId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hover = useCallback((at: FileAt, signal: AbortSignal) => api.lsp.hover(wsId, worktreePath, at, where, signal), [wsId, worktreePath, runnerId, remoteWsId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const outline = useCallback((p: string, signal: AbortSignal) => api.lsp.outline(wsId, worktreePath, p, where, signal), [wsId, worktreePath, runnerId, remoteWsId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const search = useCallback((q: SearchQuery, signal: AbortSignal) => api.files.search(wsId, worktreePath, q, where, signal), [wsId, worktreePath, runnerId, remoteWsId]);

  // How many files differ from HEAD, for the Changed chip; re-read with Refresh.
  const [changedCount, setChangedCount] = useState(0);
  useEffect(() => {
    let live = true;
    const tail = `/worktrees/${encodeURIComponent(worktreePath)}/git/changes`;
    const ask = where
      ? api.runners.rpc<{ files: unknown[] }>(where.runnerId, `/api/w/${encodeURIComponent(where.remoteWsId)}${tail}`)
      : api.worktrees.git.changes(wsId, worktreePath);
    Promise.resolve(ask).then((r) => { if (live) setChangedCount(r?.files?.length ?? 0); }).catch(() => { if (live) setChangedCount(0); });
    return () => { live = false; };
  }, [wsId, worktreePath, runnerId, remoteWsId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A newer navigation cancels the one in flight. What it finds opens in the pane it was asked from.
  const navigate = (kind: NavKind, at: FileAt, pane: PaneIndex) => {
    navAbort.current?.abort();
    const ac = new AbortController();
    navAbort.current = ac;
    dispatch({ type: 'focus', pane });
    // ⌘-click moved the cursor there; the tab comes back to it.
    dispatch({ type: 'cursor', pane, path: at.path, line: at.line, col: at.col });
    const from: Place = { ...at, pane };
    here.current = from;
    setNav({ kind, at: from, answer: null, error: null });
    const slow = setTimeout(() => { if (!ac.signal.aborted) setNav((n) => (n && n.at === from && !n.answer && !n.error ? { ...n, slow: true } : n)); }, SLOW_LOOKUP_MS);
    ac.signal.addEventListener('abort', () => clearTimeout(slow));
    api.lsp[kind](wsId, worktreePath, at, where, ac.signal)
      .then((answer) => {
        clearTimeout(slow);
        if (ac.signal.aborted) return;
        // One exact definition: go there. A guess, or several, is shown to pick from.
        if (kind === 'definition' && answer.source === 'lsp' && answer.hits.length === 1) {
          setNav(null);
          const h = answer.hits[0]!;
          jump(from, { path: h.path, line: h.line, col: h.col }, 'permanent', pane);
          return;
        }
        setNav({ kind, at: from, answer, error: null });
      })
      .catch((err: unknown) => { clearTimeout(slow); if (!ac.signal.aborted) setNav({ kind, at: from, answer: null, error: filesError(err, 'nav') }); });
  };
  /** Back to the code after a panel closes, so the keys keep working. */
  const focusCode = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-testid="files-pane-${tabsRef.current.focus}"] .cm-content`)?.focus());
  const closeNav = () => { navAbort.current?.abort(); setNav(null); focusCode(); };
  useEffect(() => () => navAbort.current?.abort(), []);
  // A picked hit opens as its own tab; ⌥-click opens it in the side pane.
  const pickHit = (h: NavHit, from: Place | null, side: boolean, pane: PaneIndex = tabsRef.current.focus) =>
    jump(from, { path: h.path, line: h.line, col: h.col }, 'permanent', side ? 1 : pane);

  // No server for this file here: its install command (this machine's, or the
  // runner's) goes to a Shell tab, typed in locally, copied with a hint on a runner.
  const install = async (id: LspServerId) => {
    const servers = where
      ? (await api.runners.rpc<{ servers: LspServerStatus[] }>(where.runnerId, '/api/lsp/servers')).servers
      : await api.lspServers.list();
    const opts = servers.find((s) => s.id === id)?.install ?? [];
    const cmd = (opts.find((o) => o.available) ?? opts[0])?.command;
    if (cmd) requestRunInShell({ worktreePath, command: cmd });
  };

  const closeTab = (pane: PaneIndex, path: string) => {
    dispatch({ type: 'close', pane, path });
    focusCode();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    // In a text box every key is the box's. In the code, Alt←/→ moves by word;
    // ⌘[ ⌘] and Ctrl± still go back/forward there.
    const t = e.target as HTMLElement;
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
      // ⌘⇧O: the open file, at its cursor, in the person's editor (the hub opens
      // the worktree when no file tab is open, so only claim it with one).
      const active = activeTab(tabsRef.current);
      if (active && onOpenInEditor) {
        e.preventDefault(); e.stopPropagation();
        onOpenInEditor(active.path, active.line);
      }
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
      // ⌘W closes the file tab, not the app's tab, while focus is in Files (the find bar too).
      const active = activeTab(tabsRef.current);
      if (active) { e.preventDefault(); e.stopPropagation(); closeTab(tabsRef.current.focus, active.path); }
      return;
    }
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearching(true); }
      return;
    }
    const alt = e.altKey && !t.closest?.('.cm-editor');
    // Ctrl+- / Ctrl+Shift+- are VS Code's Mac defaults (Shift turns '-' into '_').
    const minus = e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Minus' || e.key === '-' || e.key === '_');
    if ((mod && !e.shiftKey && e.key === '[') || (alt && e.key === 'ArrowLeft') || (minus && !e.shiftKey)) { e.preventDefault(); goBack(); }
    else if ((mod && !e.shiftKey && e.key === ']') || (alt && e.key === 'ArrowRight') || (minus && e.shiftKey)) { e.preventDefault(); goForward(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearching(true); }
    else if (e.key === 'Escape' && !e.defaultPrevented && tabs.panes.length > 1 && tabs.focus === 1 && !nav) {
      e.preventDefault();
      dispatch({ type: 'closePane', pane: 1 });
      focusCode();
    }
  };

  const iconBtn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-white/[0.06] hover:text-zinc-100';
  const historyButtons = (
    <span className="flex shrink-0 items-center">
      <button type="button" onClick={goBack} disabled={back.length === 0} aria-label="Back" title="Back (⌘[)"
        className="rounded-md px-1 text-[13px] leading-none text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30">‹</button>
      <button type="button" onClick={goForward} disabled={forward.length === 0} aria-label="Forward" title="Forward (⌘])"
        className="rounded-md px-1 text-[13px] leading-none text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30">›</button>
    </span>
  );
  const uid = useId();
  const tabIds = (paneId: number) => ({
    panel: `${uid}-panel-${paneId}`,
    tab: (path: string) => `${uid}-tab-${paneId}-${encodeURIComponent(path)}`,
  });
  const fromHere = () => (selected ? here.current : null);
  return (
    // data-file-tab-open: the hub's own ⌘W steps aside for ours while a file tab is open.
    <div ref={root} className="flex h-full min-h-0 gap-2 p-2" data-testid="files-tab" data-files-tab="" {...(selected ? { 'data-file-tab-open': '' } : {})} onKeyDown={onKeyDown}>
      <aside className="glass pane-card flex w-64 min-w-[11rem] shrink flex-col overflow-hidden rounded-xl border">
        <div ref={header} className="flex h-8 shrink-0 flex-nowrap items-center gap-1 overflow-hidden border-b border-zinc-800/80 pl-2 pr-1" data-testid="files-tree-header">
          <Chip on={changedOnly} onClick={() => setChangedOnly((v) => !v)} compact={compact} label="Changed"
            title="Changed only — list just the files that differ from HEAD" icon={<FilterIcon />} count={changedCount} />
          <Chip on={showIgnored} onClick={() => setShowIgnored((v) => !v)} compact={compact} label="Ignored"
            title="Show ignored — also list files .gitignore hides" icon={<EyeOffIcon />} />
          <span className="flex-1" />
          <button type="button" onClick={() => setSearching((v) => !v)} aria-pressed={searching} aria-label="Search files" title="Search files (⌘⇧F)"
            className={`${iconBtn} ${searching ? 'glass-pill text-zinc-100' : 'text-zinc-400'}`}><SearchIcon /></button>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} aria-label="Refresh files" title="Refresh"
            className={`${iconBtn} text-zinc-400`}><RefreshIcon /></button>
        </div>
        {searching ? (
          <SearchPanel search={search} onClose={() => { setSearching(false); focusCode(); }} onPick={(h, side) => pickHit(h, fromHere(), side)} />
        ) : (
          <FileTree load={loadDir} changedOnly={changedOnly} selected={selected} reloadKey={reloadKey} reveal={reveal}
            onSelect={(p) => jump(fromHere(), { path: p }, 'preview')}
            onPin={(p) => dispatch({ type: 'pin', pane: tabsRef.current.focus, path: p })} />
        )}
      </aside>
      <main className="glass pane-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
        {selected === null && tabs.panes.every((p) => p.tabs.length === 0) ? (
          <div className="flex flex-1 items-center justify-center p-6 text-[11px] text-zinc-500">Pick a file to read it here.</div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {tabs.panes.map((pane, i) => {
              const pi = i as PaneIndex;
              const t = activeTab(tabs, pi);
              return (
                <section key={pane.id} data-testid={`files-pane-${i}`} aria-label={i === 0 ? 'Files' : 'Files, side'}
                  className={`flex min-w-0 flex-1 flex-col ${i > 0 ? 'border-l border-zinc-800/80' : ''}`}
                  onMouseDownCapture={() => dispatch({ type: 'focus', pane: pi })} onFocusCapture={() => dispatch({ type: 'focus', pane: pi })}>
                  <TabStrip pane={pane} ids={tabIds(pane.id)} focused={tabs.panes.length > 1 && tabs.focus === pi}
                    onActivate={(path) => {
                      const tab = pane.tabs.find((x) => x.path === path);
                      if (tab && path !== pane.active) jump(here.current, { path }, 'preview', pi);
                    }}
                    onPin={(path) => dispatch({ type: 'pin', pane: pi, path })}
                    onClose={(path) => closeTab(pi, path)}
                    onClosePane={i > 0 ? () => { dispatch({ type: 'closePane', pane: pi }); focusCode(); } : undefined} />
                  <div role="tabpanel" id={tabIds(pane.id).panel} aria-labelledby={t ? tabIds(pane.id).tab(t.path) : undefined} className="flex min-h-0 flex-1 flex-col">
                  {t ? (
                    <FileViewer key={`${worktreePath}\0${t.path}`} onMissing={t.restored ? () => dispatch({ type: 'close', pane: pi, path: t.path }) : undefined} worktreePath={worktreePath} path={t.path} line={t.go.line} col={t.go.col} nonce={t.nonce} reloadKey={reloadKey}
                      read={read} marks={marks} onAskAgent={onAskAgent} onOpenInEditor={onOpenInEditor} editorLabel={editorLabel}
                      onNavigate={(kind, at) => navigate(kind, at, pi)} onCursor={(at) => moved(at, pi)} hover={hover} outline={outline}
                      headerStart={historyButtons}
                      headerEnd={i === 0 && tabs.panes.length < 2 ? (
                        <button type="button" onClick={() => open({ path: t.path, line: t.line, col: t.col }, 'permanent', 1)}
                          aria-label="Open to the side" title="Open to the side (⌥-click a definition or reference)"
                          className="rounded-md px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"><SplitIcon /></button>
                      ) : undefined} />
                  ) : (
                    <div className="flex flex-1 items-center justify-center p-6 text-[11px] text-zinc-500">Pick a file to read it here.</div>
                  )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {nav && (
          <NavPanel
            title={nav.answer ? navTitle(nav.kind, nav.answer, remote ? remote.name ?? 'the runner' : undefined)
              : nav.error ?? (nav.slow ? slowWords(nav.at.path) : nav.kind === 'definition' ? 'Finding the definition' : 'Finding references')}
            hits={nav.answer?.hits ?? []}
            pending={!nav.answer && !nav.error}
            action={nav.answer?.fallback === 'not-installed' && nav.answer.server
              ? { label: 'Install', run: () => { void install(nav.answer!.server!).catch((err: unknown) => console.warn('[files] no install command:', err)); } }
              : nav.slow && !nav.answer && !nav.error ? { label: 'Cancel', run: closeNav }
              : undefined}
            empty={nav.error ? '' : nav.kind === 'definition' ? 'No definition found.' : 'No references found.'}
            onPick={(h, side) => { pickHit(h, nav.at, side, nav.at.pane); if (nav.kind === 'definition') setNav(null); }}
            onClose={closeNav}
          />
        )}
      </main>
    </div>
  );
}

// One pane's open files: the preview tab in italics, × or middle-click closes,
// double-click keeps a preview tab. Scrolls sideways, never wraps. Keyboard:
// ←/→ (Home/End) move between tabs, Enter or Space shows one, Delete closes it.
function TabStrip({ pane, ids, focused, onActivate, onPin, onClose, onClosePane }: {
  pane: Pane;
  ids: { panel: string; tab: (path: string) => string };
  focused: boolean;
  onActivate: (path: string) => void;
  onPin: (path: string) => void;
  onClose: (path: string) => void;
  onClosePane?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const focusTab = (path: string | undefined) => {
    if (path) list.current?.querySelector<HTMLElement>(`[id="${CSS.escape(ids.tab(path))}"]`)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>, path: string) => {
    const i = pane.tabs.findIndex((t) => t.path === path);
    const to = e.key === 'ArrowRight' ? pane.tabs[(i + 1) % pane.tabs.length]
      : e.key === 'ArrowLeft' ? pane.tabs[(i - 1 + pane.tabs.length) % pane.tabs.length]
      : e.key === 'Home' ? pane.tabs[0]
      : e.key === 'End' ? pane.tabs[pane.tabs.length - 1]
      : null;
    if (to) { e.preventDefault(); focusTab(to.path); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(path); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const next = pane.tabs[i + 1] ?? pane.tabs[i - 1];
      onClose(path);
      requestAnimationFrame(() => focusTab(next?.path));
    }
  };
  return (
    <div className={`flex h-8 shrink-0 items-stretch border-b border-zinc-800/80 ${focused ? 'bg-white/[0.02]' : ''}`}>
      <div ref={list} role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
        {pane.tabs.map((t) => {
          const on = t.path === pane.active;
          const name = t.path.split('/').pop() || t.path;
          return (
            <div key={t.path} role="presentation"
              className={`group flex shrink-0 items-center border-r border-zinc-800/60 ${on ? 'glass-pill rounded-none' : 'hover:bg-white/[0.04]'}`}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.path); } }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}>
              <div id={ids.tab(t.path)} role="tab" aria-selected={on} aria-controls={on ? ids.panel : undefined} tabIndex={on ? 0 : -1}
                title={t.preview ? `${t.path} — preview (double-click to keep)` : t.path}
                data-preview={t.preview || undefined}
                onClick={() => onActivate(t.path)}
                onDoubleClick={() => onPin(t.path)}
                onKeyDown={(e) => onKey(e, t.path)}
                className={`flex h-full cursor-pointer items-center whitespace-nowrap pl-3 pr-1 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400/50 ${
                  on ? 'text-zinc-100' : 'text-zinc-400 group-hover:text-zinc-200'} ${t.preview ? 'italic' : ''}`}>
                {name}
              </div>
              <button type="button" tabIndex={-1} aria-label={`Close ${name}`} title="Close (⌘W, or Delete on the tab)"
                onClick={() => onClose(t.path)}
                className={`mr-1 flex h-4 w-4 items-center justify-center rounded text-[13px] leading-none text-zinc-500 hover:bg-white/[0.08] hover:text-zinc-100 ${on ? '' : 'opacity-0 group-hover:opacity-100'}`}>×</button>
            </div>
          );
        })}
      </div>
      {onClosePane && (
        <button type="button" onClick={onClosePane} aria-label="Close side pane" title="Close side pane (Esc)"
          className="flex w-8 shrink-0 items-center justify-center text-[13px] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100">×</button>
      )}
    </div>
  );
}

function Chip({ on, onClick, compact, label, title, icon, count }: {
  on: boolean; onClick: () => void; compact: boolean; label: string; title: string; icon: ReactNode; count?: number;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} aria-label={count ? `${label}, ${count} changed` : label} title={title}
      className={`flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] ${
        on ? 'glass-pill text-zinc-100' : 'border-transparent text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'}`}>
      {icon}
      {!compact && <span>{label}</span>}
      {count != null && count > 0 && (
        <span className="rounded bg-sky-500/15 px-1 tabular-nums text-sky-300" aria-hidden>{count}</span>
      )}
    </button>
  );
}

// Lucide's filter, eye-off, search and refresh-cw, at 14px.
const svg = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
function FilterIcon() {
  return <svg {...svg} className="shrink-0"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>;
}
function EyeOffIcon() {
  return (
    <svg {...svg} className="shrink-0">
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  );
}
function SearchIcon() {
  return <svg {...svg}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>;
}
function SplitIcon() {
  return <svg {...svg}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M12 3v18" /></svg>;
}
function RefreshIcon() {
  return (
    <svg {...svg}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
    </svg>
  );
}
