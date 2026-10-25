// The Files tab: a light, read-only look at a worktree — its folders on the
// left (loaded as they open), one file on the right. The same for a runner's
// worktree, read through the runner's own API. Instead of VS Code for "what's
// in this file / what changed here"; VS Code stays one click away.
// Code navigation lives here: go to definition (one exact answer jumps, else a
// picker), references, ⌘⇧F search, and back/forward through where you went.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, type RemoteFilesTarget } from '../../api';
import type { FileAskContext, NavAnswer, NavHit, SearchQuery } from '../../types';
import { FileTree } from './FileTree';
import { FileViewer, type FileAt } from './FileViewer';
import { NavPanel, navTitle, type NavKind } from './NavPanel';
import { SearchPanel } from './SearchPanel';
import { filesError } from './errors';

/** Back/forward keep this many places each way. */
export const HISTORY_CAP = 50;
/** A cursor move within this many lines of the current place updates it instead of adding one. */
export const NEAR_LINES = 10;
const capped = (list: FileAt[], at: FileAt) => [...list, at].slice(-HISTORY_CAP);

type NavState = { kind: NavKind; at: FileAt; answer: NavAnswer | null; error: string | null };

export type FilesTabProps = {
  wsId: string;
  worktreePath: string;
  remote?: { runnerId: string; remoteWsId: string };
  /** Open this file (and line); a new nonce opens it again. */
  openPath?: { path: string; line?: number; nonce: number };
  onAskAgent?: (ctx: FileAskContext) => void;
  onOpenInVsCode?: (path: string, line: number) => void;
};

export function FilesTab({ wsId, worktreePath, remote, openPath, onAskAgent, onOpenInVsCode }: FilesTabProps) {
  const [changedOnly, setChangedOnly] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [selected, setSelected] = useState<string | null>(openPath?.path ?? null);
  // Every jump gets a new nonce (the viewer goes to its line once per nonce).
  const seq = useRef(0);
  const [target, setTarget] = useState<{ line?: number; col?: number; nonce: number }>({ line: openPath?.line, nonce: 0 });
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(openPath ? { path: openPath.path, nonce: 0 } : null);
  // Where you went, for ⌘[ / ⌘] (or Alt←/→). `here` is the last place opened or navigated from.
  const [back, setBack] = useState<FileAt[]>([]);
  const [forward, setForward] = useState<FileAt[]>([]);
  const here = useRef<FileAt | null>(openPath ? { path: openPath.path, line: openPath.line ?? 1, col: 1 } : null);
  const [nav, setNav] = useState<NavState | null>(null);
  const navAbort = useRef<AbortController | null>(null);
  const [searching, setSearching] = useState(false);
  // Refresh: agents change files all the time; re-list the open folders and re-read the open file.
  const [reloadKey, setReloadKey] = useState(0);
  const root = useRef<HTMLDivElement>(null);
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

  const open = useCallback((to: { path: string; line?: number; col?: number }) => {
    const nonce = ++seq.current;
    setSelected(to.path);
    setTarget({ line: to.line, col: to.col, nonce });
    setReveal({ path: to.path, nonce });
    here.current = { path: to.path, line: to.line ?? 1, col: to.col ?? 1 };
  }, []);
  /** A jump you can come back from. */
  const jump = useCallback((from: FileAt | null, to: FileAt) => {
    if (from) setBack((b) => capped(b, from));
    setForward([]);
    open(to);
  }, [open]);
  // The cursor moved in the open file (VS Code's rule): far from the current
  // place, that place goes into the history; near it, the place just moves, so
  // arrow keys and nearby clicks don't fill the history.
  const moved = useCallback((at: FileAt) => {
    const cur = here.current;
    here.current = at;
    if (!cur || (cur.path === at.path && Math.abs(cur.line - at.line) <= NEAR_LINES)) return;
    setBack((b) => capped(b, cur));
    setForward([]);
  }, []);
  const goBack = () => {
    const prev = back[back.length - 1];
    if (!prev) return;
    // Read where we are before open() moves it.
    const from = here.current;
    setBack(back.slice(0, -1));
    if (from) setForward((f) => capped(f, from));
    open(prev);
  };
  const goForward = () => {
    const next = forward[forward.length - 1];
    if (!next) return;
    const from = here.current;
    setForward(forward.slice(0, -1));
    if (from) setBack((b) => capped(b, from));
    open(next);
  };

  useEffect(() => {
    if (!openPath) return;
    // Opening from elsewhere (a chat link, the picker) is a file switch you can come back from.
    const from = here.current;
    if (from && (from.path !== openPath.path || Math.abs(from.line - (openPath.line ?? 1)) > NEAR_LINES)) jump(from, { path: openPath.path, line: openPath.line ?? 1, col: 1 });
    else open({ path: openPath.path, line: openPath.line });
  }, [openPath?.path, openPath?.line, openPath?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const runnerId = remote?.runnerId;
  const remoteWsId = remote?.remoteWsId;
  const where: RemoteFilesTarget | undefined = runnerId && remoteWsId ? { runnerId, remoteWsId } : undefined;
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

  // A newer navigation cancels the one in flight.
  const navigate = (kind: NavKind, at: FileAt) => {
    navAbort.current?.abort();
    const ac = new AbortController();
    navAbort.current = ac;
    here.current = at;
    setNav({ kind, at, answer: null, error: null });
    api.lsp[kind](wsId, worktreePath, at, where, ac.signal)
      .then((answer) => {
        if (ac.signal.aborted) return;
        // One exact definition: go there. A guess, or several, is shown to pick from.
        if (kind === 'definition' && answer.source === 'lsp' && answer.hits.length === 1) {
          setNav(null);
          const h = answer.hits[0]!;
          jump(at, { path: h.path, line: h.line, col: h.col });
          return;
        }
        setNav({ kind, at, answer, error: null });
      })
      .catch((err: unknown) => { if (!ac.signal.aborted) setNav({ kind, at, answer: null, error: filesError(err, 'search') }); });
  };
  const closeNav = () => { navAbort.current?.abort(); setNav(null); };
  useEffect(() => () => navAbort.current?.abort(), []);
  const pickHit = (h: NavHit, from: FileAt | null) => jump(from, { path: h.path, line: h.line, col: h.col });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    // Ctrl+- / Ctrl+Shift+- are VS Code's Mac defaults (Shift turns '-' into '_').
    const minus = e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Minus' || e.key === '-' || e.key === '_');
    if ((mod && !e.shiftKey && e.key === '[') || (e.altKey && e.key === 'ArrowLeft') || (minus && !e.shiftKey)) { e.preventDefault(); goBack(); }
    else if ((mod && !e.shiftKey && e.key === ']') || (e.altKey && e.key === 'ArrowRight') || (minus && e.shiftKey)) { e.preventDefault(); goForward(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearching(true); }
  };

  const toggle = 'flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-200';
  return (
    <div ref={root} className="flex h-full min-h-0 gap-2 p-2" data-testid="files-tab" onKeyDown={onKeyDown}>
      <aside className="glass pane-card flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border">
        <div className="flex h-8 shrink-0 items-center gap-3 border-b border-zinc-800/80 px-3">
          <label className={toggle}>
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} className="accent-sky-600" />
            Changed only
          </label>
          <label className={toggle}>
            <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} className="accent-sky-600" />
            Show ignored
          </label>
          <button type="button" onClick={() => setSearching((v) => !v)} aria-pressed={searching} aria-label="Search files" title="Search (⌘⇧F)"
            className={`ml-auto rounded-md px-1 text-[13px] leading-none hover:bg-white/[0.06] hover:text-zinc-100 ${searching ? 'text-zinc-100' : 'text-zinc-400'}`}>⌕</button>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} aria-label="Refresh files" title="Refresh"
            className="rounded-md px-1 text-[13px] leading-none text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">↻</button>
        </div>
        {searching ? (
          <SearchPanel search={search} onClose={() => setSearching(false)} onPick={(h) => pickHit(h, selected ? here.current : null)} />
        ) : (
          <FileTree load={loadDir} changedOnly={changedOnly} selected={selected} reloadKey={reloadKey} reveal={reveal}
            onSelect={(p) => jump(selected ? here.current : null, { path: p, line: 1, col: 1 })} />
        )}
      </aside>
      <main className="glass pane-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
        {selected ? (
          <FileViewer key={`${worktreePath}\0${selected}`} worktreePath={worktreePath} path={selected} line={target.line} col={target.col} nonce={target.nonce} reloadKey={reloadKey}
            read={read} marks={marks} onAskAgent={onAskAgent} onOpenInVsCode={onOpenInVsCode}
            onNavigate={navigate} onCursor={moved} hover={hover} outline={outline}
            headerStart={(
              <span className="flex shrink-0 items-center">
                <button type="button" onClick={goBack} disabled={back.length === 0} aria-label="Back" title="Back (⌘[)"
                  className="rounded-md px-1 text-[13px] leading-none text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30">‹</button>
                <button type="button" onClick={goForward} disabled={forward.length === 0} aria-label="Forward" title="Forward (⌘])"
                  className="rounded-md px-1 text-[13px] leading-none text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30">›</button>
              </span>
            )} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-[11px] text-zinc-500">Pick a file to read it here.</div>
        )}
        {nav && (
          <NavPanel
            title={nav.answer ? navTitle(nav.kind, nav.answer) : nav.error ?? (nav.kind === 'definition' ? 'Finding the definition' : 'Finding references')}
            hits={nav.answer?.hits ?? []}
            pending={!nav.answer && !nav.error}
            empty={nav.error ? '' : nav.kind === 'definition' ? 'No definition found.' : 'No references found.'}
            onPick={(h) => { pickHit(h, nav.at); if (nav.kind === 'definition') setNav(null); }}
            onClose={closeNav}
          />
        )}
      </main>
    </div>
  );
}
