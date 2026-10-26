// ⌘⇧F in the Files tab: search the worktree (rg, else git grep) with word,
// case and regex switches; results grouped by file, a click opens the line.
// Each keystroke cancels the search it supersedes.
import { useEffect, useRef, useState } from 'react';
import type { NavHit, SearchAnswer, SearchQuery } from '../../types';
import { filesError } from './errors';
import { byFile } from './NavPanel';

const DEBOUNCE_MS = 250;

export function SearchPanel({ search, onPick, onClose, seed }: {
  search: (q: SearchQuery, signal: AbortSignal) => Promise<SearchAnswer>;
  /** Each ⌘⇧F (a new nonce): focus the box and select it, starting from `text` when there is one. */
  seed?: { text: string; nonce: number };
  /** `side`: ⌥-click, open it beside the current file. */
  onPick: (hit: NavHit, side: boolean) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [word, setWord] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (seed?.text) setQ(seed.text);
    // After the value lands, so the selection covers it.
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    input.current?.focus();
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const query = q.trim();
    if (!query) { setAnswer(null); setBusy(false); setError(null); return; }
    const ac = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      search({ q: query, word, case: matchCase, regex }, ac.signal)
        .then((a) => { if (!ac.signal.aborted) { setAnswer(a); setError(null); } })
        .catch((err: unknown) => { if (!ac.signal.aborted) setError(filesError(err, 'search')); })
        .finally(() => { if (!ac.signal.aborted) setBusy(false); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q, word, matchCase, regex, search]);

  const flag = (on: boolean) => `rounded-md px-1.5 py-0.5 font-mono text-[11px] ${on ? 'glass-pill text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'}`;
  const hits = answer?.hits ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="search" aria-label="Search files" data-testid="search-panel"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-zinc-800/80 p-2">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search text"
          className="h-7 w-full rounded-md border border-zinc-800 bg-zinc-950/60 px-2 font-mono text-[11px] text-zinc-100 outline-none focus:border-zinc-600" />
        <div className="flex items-center gap-1">
          <button type="button" className={flag(word)} aria-pressed={word} onClick={() => setWord((v) => !v)} title="Whole word">ab</button>
          <button type="button" className={flag(matchCase)} aria-pressed={matchCase} onClick={() => setMatchCase((v) => !v)} title="Match case">Aa</button>
          <button type="button" className={flag(regex)} aria-pressed={regex} onClick={() => setRegex((v) => !v)} title="Regular expression">.*</button>
          <span className="ml-auto text-[11px] text-zinc-500" aria-live="polite">
            {busy ? 'Searching…' : answer ? `${hits.length}${answer.truncated ? '+' : ''} result${hits.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {error ? <p role="alert" className="px-2 text-[11px] text-red-300">{error}</p>
          : answer && hits.length === 0 ? <p className="px-2 text-[11px] text-zinc-500">No matches.</p>
          : byFile(hits).map(([file, group]) => (
            <section key={file} aria-label={file}>
              <h4 className="truncate px-2 pt-1 font-mono text-[11px] text-zinc-300">{file} <span className="text-zinc-600">· {group.length}</span></h4>
              <ul>
                {group.map((h) => (
                  <li key={`${h.line}:${h.col}`}>
                    <button type="button" onClick={(e) => onPick(h, e.altKey)} title="⌥-click to open to the side" className="flex w-full items-baseline gap-2 rounded-md px-2 py-0.5 text-left hover:bg-white/[0.05] focus-visible:bg-white/[0.07] focus-visible:outline-none">
                      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-500">{h.line}</span>
                      <span className="truncate font-mono text-[11px] text-zinc-300">{h.preview}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        {answer?.truncated && <p className="px-2 py-1 text-[11px] text-zinc-600">More matches than shown — narrow the search.</p>}
      </div>
    </div>
  );
}
