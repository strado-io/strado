// ⌘⇧F in the Files tab: search the worktree (rg, else git grep) with word,
// case and regex switches; results grouped by file, VS Code style: each line
// trimmed so its match shows, the match marked, ↑/↓ and ⏎ to open one.
// Each keystroke cancels the search it supersedes. With `replace` (a worktree
// on this machine), › shows a replace box and Replace all (replaceInFiles.ts).
import { useEffect, useRef, useState } from 'react';
import type { NavHit, SearchAnswer, SearchQuery } from '../../types';
import type { ReplaceReport } from './replaceInFiles';
import { filesError } from './errors';
import { byFile } from './NavPanel';
import { FileIcon } from './FileIcon';

// The server answers in tens of ms (ripgrep): wait just past a typing burst.
const DEBOUNCE_MS = 80;
/** Characters of the line kept before a match. */
const CONTEXT = 12;

/** The match in a result line, [start, end) in characters, from the hit's 1-based column. */
export function matchAt(preview: string, col: number, q: SearchQuery): [number, number] {
  const start = Math.max(0, Math.min(preview.length, col - 1));
  let len = q.q.length;
  if (q.regex) {
    try {
      const re = new RegExp(q.q, `y${q.case ? '' : 'i'}`);
      re.lastIndex = start;
      len = re.exec(preview)?.[0].length ?? len;
    } catch { /* the server took it; the browser's dialect didn't: mark the query's length */ }
  }
  return [start, Math.min(preview.length, start + len)];
}

/** A result line around its match: up to CONTEXT characters before it (cut
 * with an ellipsis), the match, then the rest (the row truncates the end). */
export function snippet(preview: string, [start, end]: [number, number]) {
  const from = start > CONTEXT ? start - CONTEXT : 0;
  return {
    cut: from > 0,
    before: from > 0 ? preview.slice(from, start) : preview.slice(0, start).trimStart(),
    match: preview.slice(start, end),
    after: preview.slice(end),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('ch') ? 'es' : 's'}`;

export function SearchPanel({ search, replace, onPick, onClose, seed }: {
  search: (q: SearchQuery, signal: AbortSignal) => Promise<SearchAnswer>;
  /** Each ⌘⇧F (a new nonce): focus the box and select it, starting from `text` when there is one. */
  seed?: { text: string; nonce: number };
  /** `side`: ⌥, open it beside the current file. `query`: what found it, for the editor to mark. */
  onPick: (hit: NavHit, side: boolean, query: SearchQuery) => void;
  onClose: () => void;
  /** Replace every match of the query in these files. Absent: no replace (read-only worktree). */
  replace?: (query: SearchQuery, replacement: string, paths: string[]) => Promise<ReplaceReport>;
}) {
  const [q, setQ] = useState('');
  const [word, setWord] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [regex, setRegex] = useState(false);
  // The answer with the query that produced it (marks follow that, not the box as typed since).
  const [found, setFound] = useState<{ query: SearchQuery; answer: SearchAnswer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0);
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  // Bumped after a replace: the same query, searched again.
  const [rerun, setRerun] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seed?.text) setQ(seed.text);
    input.current?.focus();
    // After the value lands, so the selection covers it.
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const text = q.trim();
    if (!text) { setFound(null); setBusy(false); setError(null); return; }
    const ac = new AbortController();
    setBusy(true);
    const query: SearchQuery = { q: text, word, case: matchCase, regex };
    const t = setTimeout(() => {
      search(query, ac.signal)
        .then((answer) => { if (!ac.signal.aborted) { setFound({ query, answer }); setError(null); setSel(0); setFolded(new Set()); } })
        .catch((err: unknown) => { if (!ac.signal.aborted) setError(filesError(err, 'search')); })
        .finally(() => { if (!ac.signal.aborted) setBusy(false); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q, word, matchCase, regex, search, rerun]);

  const hits = found?.answer.hits ?? [];
  const groups = byFile(hits);
  // The rows ↑/↓ walk: every hit in an open group, in order.
  const rows = groups.flatMap(([file, group]) => (folded.has(file) ? [] : group));
  const current = Math.min(sel, Math.max(rows.length - 1, 0));
  const pick = (h: NavHit, side: boolean) => { if (found) onPick(h, side, found.query); };
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [current, found]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(current + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(current - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(rows[current]!, e.altKey); }
  };
  const replaceAll = async () => {
    if (!replace || !found || hits.length === 0 || replaceBusy) return;
    const n = `${plural(hits.length, 'match')}${found.answer.truncated ? '+' : ''} in ${plural(groups.length, 'file')}`;
    const more = found.answer.truncated ? '\n\nOnly the files listed are changed; there are more matches than shown.' : '';
    if (!confirm(`Replace ${n} with “${replacement}”?${more}`)) return;
    setReplaceBusy(true);
    try {
      const r = await replace(found.query, replacement, groups.map(([file]) => file));
      const parts = [`Replaced ${plural(r.replaced, 'match')} in ${plural(r.files, 'file')}`];
      if (r.skipped.length) parts.push(`${plural(r.skipped.length, 'file')} with unsaved edits left alone`);
      if (r.failed.length) parts.push(`${plural(r.failed.length, 'file')} couldn’t be changed`);
      setReport(parts.join(' · '));
    } finally {
      setReplaceBusy(false);
      setRerun((k) => k + 1);
    }
  };
  const toggleFold = (file: string) => setFolded((s) => { const n = new Set(s); if (!n.delete(file)) n.add(file); return n; });

  const toggle = (on: boolean) => `flex h-5 w-6 items-center justify-center rounded font-mono text-[11px] leading-none transition-colors ${
    on ? 'bg-sky-500/25 text-sky-300 ring-1 ring-inset ring-sky-400/50' : 'text-zinc-500 hover:bg-[rgb(var(--pane-edge)/0.08)] hover:text-zinc-200'}`;
  const summary = busy ? 'Searching…'
    : found ? (hits.length === 0 ? 'No results' : `${plural(hits.length, 'result')}${found.answer.truncated ? '+' : ''} in ${plural(groups.length, 'file')}`)
    : '';
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="search" aria-label="Search files" data-testid="search-panel" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 flex-col gap-1 border-b border-[rgb(var(--pane-edge)/0.08)] p-2">
        <div className="flex items-center gap-1">
        {replace && (
          <button type="button" onClick={() => setReplacing((v) => !v)} aria-expanded={replacing} aria-label="Toggle replace" title="Toggle replace"
            className="flex h-7 w-4 shrink-0 items-center justify-center rounded text-[13px] text-zinc-500 hover:text-zinc-200">
            <span aria-hidden className={`transition-transform ${replacing ? 'rotate-90' : ''}`}>›</span>
          </button>
        )}
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[rgb(var(--pane-edge)/0.12)] bg-[rgb(var(--pane-edge)/0.03)] pl-2 pr-1 focus-within:border-sky-400/60">
          <span aria-hidden className="shrink-0 text-[13px] leading-none text-zinc-500">⌕</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search text"
            aria-controls="files-search-results" spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 selection:bg-sky-400/30 selection:text-inherit" />
          <button type="button" className={toggle(matchCase)} aria-pressed={matchCase} onClick={() => setMatchCase((v) => !v)} title="Match case" aria-label="Match case">Aa</button>
          <button type="button" className={`${toggle(word)} underline decoration-1 underline-offset-2`} aria-pressed={word} onClick={() => setWord((v) => !v)} title="Match whole word" aria-label="Match whole word">ab</button>
          <button type="button" className={toggle(regex)} aria-pressed={regex} onClick={() => setRegex((v) => !v)} title="Use regular expression" aria-label="Use regular expression">.*</button>
        </div>
        </div>
        {replace && replacing && (
          <div className="flex items-center gap-1 pl-5">
            <input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="Replace" aria-label="Replace with" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void replaceAll(); } }}
              className="h-7 min-w-0 flex-1 rounded-md border border-[rgb(var(--pane-edge)/0.12)] bg-[rgb(var(--pane-edge)/0.03)] px-2 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-400/60" />
            <button type="button" onClick={() => void replaceAll()} disabled={!found || hits.length === 0 || busy || replaceBusy}
              title="Replace all (⌘Enter)" className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-zinc-200 hover:bg-[rgb(var(--pane-edge)/0.08)] disabled:opacity-40">
              {replaceBusy ? 'Replacing…' : 'Replace all'}
            </button>
          </div>
        )}
        <span className="px-0.5 text-[11px] text-zinc-500" aria-live="polite">{summary}</span>
        {report && <span className="px-0.5 text-[11px] text-zinc-400" role="status">{report}</span>}
      </div>
      <div ref={list} id="files-search-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {error ? <p role="alert" className="px-2 text-[11px] text-red-300">{error}</p>
          : groups.map(([file, group]) => {
            const open = !folded.has(file);
            const name = file.split('/').pop() ?? file;
            const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
            return (
              <section key={file} aria-label={file} className="mb-0.5">
                <button type="button" onClick={() => toggleFold(file)} aria-expanded={open} title={file}
                  className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left hover:bg-[rgb(var(--pane-edge)/0.05)]">
                  <span aria-hidden className={`w-3 shrink-0 text-center text-[11px] text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
                  <FileIcon path={file} />
                  <span className="shrink-0 truncate text-[12px] text-zinc-200">{name}</span>
                  {dir && <span className="min-w-0 truncate text-[11px] text-zinc-500">{dir}</span>}
                  <span className="ml-auto shrink-0 rounded-full bg-[rgb(var(--pane-edge)/0.08)] px-1.5 text-[10px] tabular-nums leading-4 text-zinc-400">{group.length}</span>
                </button>
                {open && group.map((h) => {
                  const i = rows.indexOf(h);
                  const s = snippet(h.preview, matchAt(h.preview, h.col, found!.query));
                  const selected = i === current;
                  return (
                    <div key={`${h.line}:${h.col}`} role="option" aria-selected={selected} tabIndex={-1} aria-label={`${file}:${h.line}: ${h.preview.trim()}`}
                      onClick={(e) => { setSel(i); pick(h, e.altKey); }} onMouseDown={(e) => e.preventDefault()}
                      title={`${file}:${h.line} — ⌥-click to open to the side`}
                      className={`flex h-[22px] cursor-pointer items-center gap-2 rounded-md pl-4 pr-1 ${
                        selected ? 'bg-[rgb(var(--pane-edge)/0.09)] text-zinc-100' : 'text-zinc-300 hover:bg-[rgb(var(--pane-edge)/0.05)]'}`}>
                      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-600">{h.line}</span>
                      <span className="min-w-0 truncate whitespace-pre font-mono text-[12px]">
                        {s.cut && <span className="text-zinc-600">…</span>}{s.before}
                        <mark className="rounded-[3px] bg-amber-400/35 px-px text-inherit">{s.match}</mark>{s.after}
                      </span>
                    </div>
                  );
                })}
              </section>
            );
          })}
        {found?.answer.truncated && <p className="px-2 py-1 text-[11px] text-zinc-600">More matches than shown — narrow the search.</p>}
      </div>
    </div>
  );
}
