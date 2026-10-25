// The open file's symbols from its language server, nested, beside the code.
// A click (or Enter) jumps there; a branch folds. Without a server it says so.
import { useEffect, useState } from 'react';
import type { OutlineAnswer, OutlineSymbol } from '../../types';
import { filesError } from './errors';

export function OutlinePanel({ path, load, onPick, onClose }: {
  path: string;
  load: (path: string, signal: AbortSignal) => Promise<OutlineAnswer>;
  onPick: (s: OutlineSymbol) => void;
  onClose: () => void;
}) {
  const [answer, setAnswer] = useState<OutlineAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const ac = new AbortController();
    setAnswer(null); setError(null);
    Promise.resolve().then(() => load(path, ac.signal))
      .then((a) => { if (!ac.signal.aborted) setAnswer(a); })
      .catch((err: unknown) => { if (!ac.signal.aborted) setError(filesError(err, 'file')); });
    return () => ac.abort();
  }, [path, load]);

  const toggle = (key: string) => setFolded((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const rows = (symbols: OutlineSymbol[], depth: number, parent: string): React.ReactNode[] => symbols.flatMap((s, i) => {
    const key = `${parent}/${i}:${s.name}`;
    const kids = s.children?.length ? s.children : null;
    const open = !folded.has(key);
    return [
      <li key={key} className="flex items-center" style={{ paddingLeft: `${depth * 10}px` }}>
        {kids ? (
          <button type="button" onClick={() => toggle(key)} aria-label={`${open ? 'Fold' : 'Unfold'} ${s.name}`} aria-expanded={open}
            className={`w-3.5 shrink-0 text-[11px] text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>›</button>
        ) : <span className="w-3.5 shrink-0" />}
        <button type="button" onClick={() => onPick(s)} title={`${s.kind} ${s.name} — line ${s.line}`}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-white/[0.05]">
          <span className="shrink-0 font-mono text-[11px] text-sky-400/80">{s.kind}</span>
          <span className="truncate text-[11px] text-zinc-200">{s.name}</span>
        </button>
      </li>,
      ...(kids && open ? rows(kids, depth + 1, key) : []),
    ];
  });

  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-zinc-800/80" aria-label="Outline" data-testid="outline-panel"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
      <div className="flex h-7 shrink-0 items-center justify-between px-2 text-[11px] text-zinc-500">
        <span>Outline</span>
        <button type="button" onClick={onClose} aria-label="Close outline" className="rounded px-1 hover:bg-white/[0.06] hover:text-zinc-200">×</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {error ? (
          <p role="alert" className="px-1 text-[11px] text-red-300">{error}</p>
        ) : !answer ? (
          <p className="px-1 text-[11px] text-zinc-500">Loading…</p>
        ) : answer.server === null ? (
          <p className="px-1 text-[11px] text-zinc-500">No language server for this file — install one in Settings for an outline.</p>
        ) : answer.symbols.length === 0 ? (
          <p className="px-1 text-[11px] text-zinc-500">No symbols in this file.</p>
        ) : (
          <ul>{rows(answer.symbols, 0, '')}</ul>
        )}
      </div>
    </aside>
  );
}
