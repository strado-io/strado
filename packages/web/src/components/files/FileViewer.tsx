// One file, read-only: CodeMirror (loaded on first use, never in the main
// bundle) with line numbers, a change gutter against HEAD, and n/p between
// changes. Selecting lines offers "Ask agent"; the header opens the file in VS
// Code at the current line. Binary and over-limit files get a plain note.
// Code navigation: ⌘-click/F12 and ⇧F12 are reported up (the tab runs them and
// keeps the history); hover and the outline are this file's own.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileAskContext, FileContent, FileMarks, HoverAnswer, OutlineAnswer, SearchQuery } from '../../types';
import { OutlinePanel } from './OutlinePanel';
import { capSnippet, changeStarts } from './changes';
import { filesError } from './errors';
import type { CodeView, NavKind, Selection } from './codeView';

const loadCodeView = () => import('./codeView');

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A place in a file, 1-based. */
export type FileAt = { path: string; line: number; col: number };

export function FileViewer({ worktreePath, path, line, col, nonce, reloadKey, read, marks: readMarks, highlight = null, onAskAgent, onNavigate, onCursor, hover, outline, headerStart, headerEnd, onMissing }: {
  worktreePath: string;
  path: string;
  /** Scroll here (1-based) once loaded; a new `nonce` asks again. */
  line?: number;
  col?: number;
  nonce?: number;
  /** A new value re-reads the file and its marks (Refresh). */
  reloadKey?: number;
  read: (path: string) => Promise<FileContent>;
  marks: (path: string) => Promise<FileMarks>;
  /** The ⌘⇧F query a result was opened from: every match marked. */
  highlight?: SearchQuery | null;
  onAskAgent?: (ctx: FileAskContext) => void;
  /** ⌘-click/F12 (definition) and ⇧F12 (references) at a place in this file. */
  onNavigate?: (kind: NavKind, at: FileAt) => void;
  /** The person moved the cursor here (click, keys, an outline pick) — for back/forward. */
  onCursor?: (at: FileAt) => void;
  hover?: (at: FileAt, signal: AbortSignal) => Promise<HoverAnswer>;
  outline?: (path: string, signal: AbortSignal) => Promise<OutlineAnswer>;
  /** Before the path in the header (the tab's back/forward). */
  headerStart?: ReactNode;
  /** After the header's own buttons (the tab's Open to the side). */
  headerEnd?: ReactNode;
  /** The file isn't there (deleted since): the tab may go. */
  onMissing?: () => void;
}) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [marks, setMarks] = useState<FileMarks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [editorFailed, setEditorFailed] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CodeView | null>(null);
  const cursorLine = useRef(1);
  // The asked line is a one-time jump per ask (path + line + nonce). A reload
  // that rebuilds the editor goes back to where the person was, not to it.
  const appliedAsk = useRef<string | null>(null);
  const askKey = line ? `${path}\0${line}\0${col ?? 1}\0${nonce ?? ''}` : null;
  const [outlineOpen, setOutlineOpen] = useState(false);
  // The editor is built once per text; it reaches these through refs.
  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;
  const missingRef = useRef(onMissing);
  missingRef.current = onMissing;
  const cursorRef = useRef(onCursor);
  cursorRef.current = onCursor;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const shownPath = useRef<string | null>(null);
  // The latest marks, for an editor that finishes loading after they arrived.
  const marksRef = useRef<FileMarks | null>(null);
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  marksRef.current = marks;

  // The file, then its marks (a failed marks call only loses the gutter).
  useEffect(() => {
    let live = true;
    // A new path starts blank; a re-read of the same one keeps the old copy up until the new one lands.
    if (shownPath.current !== path) {
      shownPath.current = path;
      setFile(null); setMarks(null); setError(null); setSelection(null);
    }
    Promise.resolve().then(() => read(path))
      .then((f) => {
        if (!live) return;
        setError(null);
        // Same text back: keep the object, so the editor (and its cursor) stays put.
        setFile((cur) => (cur && cur.path === f.path && cur.text === f.text && cur.binary === f.binary && cur.tooLarge === f.tooLarge ? cur : f));
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(filesError(err, 'file'));
        if ((err as { code?: unknown })?.code === 'NOT_FOUND') missingRef.current?.();
      });
    Promise.resolve().then(() => readMarks(path))
      .then((m) => { if (live) setMarks(m); })
      .catch(() => { /* no gutter */ });
    return () => { live = false; };
    // A new nonce (the same file opened again) or reloadKey re-reads: agents
    // change files all the time and an old copy is worse than a reload.
  }, [path, read, readMarks, nonce, reloadKey]);

  const text = file && !file.binary && !file.tooLarge ? file.text ?? '' : null;

  // The editor, once per file's text.
  useEffect(() => {
    const el = host.current;
    if (text === null || !el || !file) return;
    let live = true;
    let view: CodeView | null = null;
    setEditorFailed(false);
    loadCodeView()
      .then(({ createCodeView }) => createCodeView(el, {
        doc: text,
        path: file.path,
        language: file.language,
        marks: marksRef.current,
        onSelection: (s) => {
          if (s) cursorLine.current = s.from;
          setSelection(s);
        },
        onCursor: (at: { line: number; col: number }) => cursorRef.current?.({ path: file.path, ...at }),
        ...(navRef.current ? { onNavigate: (kind: NavKind, at: { line: number; col: number }) => navRef.current?.(kind, { path: file.path, ...at }) } : {}),
        ...(hoverRef.current ? {
          hover: async (at: { line: number; col: number }, signal: AbortSignal) => (await hoverRef.current?.({ path: file.path, ...at }, signal))?.markdown ?? null,
        } : {}),
      }))
      .then((v) => {
        if (!live) { v.destroy(); return; }
        view = v;
        viewRef.current = v;
        v.setMarks(marksRef.current);
        v.setHighlight(highlightRef.current);
        if (askKey && appliedAsk.current !== askKey) {
          appliedAsk.current = askKey;
          v.goToLine(line!, col);
          cursorLine.current = line!;
          focusIfLost(v);
        } else if (cursorLine.current > 1) {
          v.goToLine(cursorLine.current);
        }
      })
      .catch(() => { if (live) setEditorFailed(true); });
    return () => {
      live = false;
      view?.destroy();
      viewRef.current = null;
      el.replaceChildren();
    };
    // `line` is applied by its own effect below; a new line must not rebuild the
    // editor, and neither must a re-read that brought back the same text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, file?.path, file?.language]);

  useEffect(() => { viewRef.current?.setMarks(marks); }, [marks, text]);
  useEffect(() => { viewRef.current?.setHighlight(highlight); }, [highlight]);
  useEffect(() => {
    if (!askKey || !viewRef.current || appliedAsk.current === askKey) return;
    appliedAsk.current = askKey;
    viewRef.current.goToLine(line!, col);
    cursorLine.current = line!;
    focusIfLost(viewRef.current);
  }, [askKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const starts = changeStarts(marks);
  const step = (dir: 1 | -1) => {
    const to = viewRef.current?.step(dir);
    if (to != null) cursorLine.current = to;
  };
  const ask = () => {
    if (!selection || !onAskAgent) return;
    onAskAgent({ worktreePath, path, from: selection.from, to: selection.to, snippet: capSnippet(selection.text) });
  };

  const iconBtn = 'rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-40';
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="file-viewer" aria-label={path}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800/80 px-3">
        {headerStart}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400" title={path}>{path}</span>
        {selection && onAskAgent && (
          <button type="button" onClick={ask} className="rounded-md bg-sky-600/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-500">
            Ask agent about {selection.from === selection.to ? `line ${selection.from}` : `lines ${selection.from}–${selection.to}`}
          </button>
        )}
        {text !== null && starts.length > 0 && (
          <span className="flex items-center gap-0.5" data-testid="change-nav">
            <span className="mr-1 text-[11px] text-zinc-500">{starts.length} change{starts.length === 1 ? '' : 's'}</span>
            <button type="button" className={iconBtn} onClick={() => step(-1)} aria-label="Previous change" title="Previous change (p)">↑</button>
            <button type="button" className={iconBtn} onClick={() => step(1)} aria-label="Next change" title="Next change (n)">↓</button>
          </span>
        )}
        {outline && text !== null && (
          <button type="button" className={`${iconBtn} ${outlineOpen ? 'bg-white/[0.06] text-zinc-100' : ''}`} onClick={() => setOutlineOpen((o) => !o)}
            aria-pressed={outlineOpen} aria-label="Outline" title="Outline">
            Outline
          </button>
        )}
        {headerEnd}
      </header>
      {error ? (
        <p role="alert" className="p-4 text-[13px] text-red-300">{error}</p>
      ) : !file ? (
        <p className="p-4 text-[11px] text-zinc-500">Loading…</p>
      ) : file.binary ? (
        <Empty title="Binary file" body={`${path} isn’t text, so it isn’t shown here.`} />
      ) : file.tooLarge ? (
        <Empty title="Too large to show" body={`${path} is ${mb(file.size)}; the viewer shows files up to 1 MB. Open it in your editor from the title bar.`} />
      ) : editorFailed ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-[13px] text-zinc-200" data-testid="plain-text">{text}</pre>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="code-host" />
          {outlineOpen && outline && (
            <OutlinePanel path={path} load={outline} onClose={() => { setOutlineOpen(false); viewRef.current?.focus(); }}
              onPick={(s) => { viewRef.current?.goToLine(s.line, s.col); cursorLine.current = s.line; onCursor?.({ path, line: s.line, col: s.col }); }} />
          )}
        </div>
      )}
    </section>
  );
}

/** After a jump, keys (⌘[ ⌘] ⌘⇧F) keep working: if the jump took focus with it
 *  (a closed panel, a rebuilt viewer), it comes to the code. */
function focusIfLost(v: CodeView) {
  const a = document.activeElement;
  if (!a || a === document.body) v.focus();
}

function Empty({ title, body, action }: { title: string; body: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center" data-testid="file-empty">
      <p className="text-[13px] font-medium text-zinc-300">{title}</p>
      <p className="max-w-sm text-[11px] text-zinc-500">{body}</p>
      {action && (
        <button type="button" onClick={action.run} className="mt-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-white/[0.06]">
          {action.label}
        </button>
      )}
    </div>
  );
}
