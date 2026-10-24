// A host's Logs tab: the runner's own log, newest at the bottom, redacted on
// the runner before it leaves. The filter runs on the runner (debounced);
// Follow polls for lines after the last one every 2s, only while on screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { LogLine, LogPage } from '../../types';

const LINES = 300;
/** Kept on screen; older lines drop off the top while following. */
const MAX_LINES = 1000;
const FOLLOW_MS = 2_000;
const DEBOUNCE_MS = 300;
const TONE: Record<LogLine['level'], string> = {
  error: 'text-red-300',
  warn: 'text-amber-300',
  info: 'text-zinc-300',
  debug: 'text-zinc-500',
};

const stamp = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
export const formatLine = (l: LogLine) => `${stamp(l.ts)} ${l.level.toUpperCase().padEnd(5)} ${l.text}`;

export function LogsTab({ runnerId, online, visible }: {
  runnerId: string;
  online: boolean;
  /** On screen: the row is expanded and this tab selected. Follow polls only then. */
  visible: boolean;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [source, setSource] = useState<LogPage['source'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [grep, setGrep] = useState('');
  const [follow, setFollow] = useState(false);
  const [copied, setCopied] = useState(false);
  // The file fallback has no cursor (nextSince null): nothing to follow from.
  const [cursor, setCursor] = useState(true);
  const since = useRef<number | null>(null);
  const box = useRef<HTMLPreElement>(null);
  // Answers for an older filter are dropped.
  const generation = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setGrep(filter.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filter]);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const page = await api.runners.logs(runnerId, { lines: LINES, ...(grep ? { grep } : {}) });
      if (gen !== generation.current) return;
      setLines(page.lines);
      setSource(page.source);
      since.current = page.nextSince;
      setCursor(page.nextSince !== null);
      if (page.nextSince === null) setFollow(false);
      setError(null);
    } catch (err) {
      if (gen === generation.current) setError((err as Error).message);
    }
  }, [runnerId, grep]);

  // First look (and every filter change) while on screen.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !online) return;
    const key = `${runnerId}\0${grep}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    void load();
  }, [visible, online, runnerId, grep, load]);

  useEffect(() => {
    if (!follow || !visible || !online) return;
    let inflight = false;
    const t = setInterval(async () => {
      // A slow runner never gets a second poll stacked on the first.
      if (inflight) return;
      inflight = true;
      const gen = generation.current;
      try {
        const page = await api.runners.logs(runnerId, { ...(grep ? { grep } : {}), ...(since.current != null ? { since: since.current } : {}) });
        if (gen !== generation.current) return;
        if (page.nextSince != null) since.current = page.nextSince;
        if (page.lines.length) setLines((cur) => [...cur, ...page.lines].slice(-MAX_LINES));
        setSource(page.source);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        inflight = false;
      }
    }, FOLLOW_MS);
    return () => clearInterval(t);
  }, [follow, visible, online, runnerId, grep]);

  // Newest at the bottom: keep it in view while following or on a fresh load.
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const copy = () => {
    void navigator.clipboard?.writeText(lines.map(formatLine).join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="flex flex-col gap-2" data-testid="logs-tab">
      <div className="flex items-center gap-2">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter log lines"
          className="h-7 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-zinc-600" />
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} disabled={!online || !cursor} className="accent-sky-600" />
          Follow
        </label>
        {!cursor && source !== 'none' && <span className="text-[10px] text-zinc-500" data-testid="follow-hint">Live follow needs the systemd service</span>}
        <button type="button" onClick={copy} disabled={lines.length === 0}
          className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
          {copied ? 'Copied' : 'Copy visible lines'}
        </button>
      </div>
      {!online && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400" data-testid="logs-offline">
          Runner offline — its log can’t be read now.
        </p>
      )}
      {error && <p role="alert" className="text-xs text-red-300">Couldn’t read the log: {error}</p>}
      {source === 'none' ? (
        <p className="text-xs text-zinc-500">This runner has no log yet.</p>
      ) : (
        <pre ref={box} data-testid="log-lines"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-zinc-800 bg-black/60 p-2 font-mono text-[11px] leading-relaxed">
          {lines.length === 0 && source ? <span className="text-zinc-600">{grep ? 'No lines match.' : 'No lines.'}</span> : null}
          {lines.map((l, i) => (
            <div key={`${l.ts}-${i}`} className={TONE[l.level]} data-level={l.level}>{formatLine(l)}</div>
          ))}
        </pre>
      )}
    </section>
  );
}
