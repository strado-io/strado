import { useEffect, useRef, useState } from 'react';

/** What the bar drives: the xterm search addon, behind a small port. */
export type SearchPort = {
  findNext: (term: string, opts: SearchOptions) => void;
  findPrevious: (term: string, opts: SearchOptions) => void;
  /** Drop every highlight. */
  clear: () => void;
  /** index is -1 past the highlight limit. */
  onResults: (cb: (r: { index: number; count: number }) => void) => () => void;
};
export type SearchOptions = {
  caseSensitive: boolean;
  incremental: boolean;
  decorations: {
    matchBackground: string; matchOverviewRuler: string;
    activeMatchBackground: string; activeMatchColorOverviewRuler: string;
  };
};

// #RRGGBB only (the addon's rule): a muted slate for every match, the cursor
// orange for the active one; readable on the dark themes and the light one.
const DECORATIONS: SearchOptions['decorations'] = {
  matchBackground: '#3f4a5a', matchOverviewRuler: '#71717a',
  activeMatchBackground: '#c2410c', activeMatchColorOverviewRuler: '#f97f1b',
};

/** ⌘F on a Mac, Ctrl+F elsewhere (keydown, no other modifiers). */
export function searchKey(e: Pick<KeyboardEvent, 'type' | 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  if (e.type !== 'keydown' || e.key.toLowerCase() !== 'f' || e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** ⌘P on a Mac, Ctrl+P elsewhere (keydown): go to a file in the worktree, from any tab. */
export function filePickerKey(e: Pick<KeyboardEvent, 'type' | 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  if (e.type !== 'keydown' || e.key.toLowerCase() !== 'p' || e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** ⌘⇧F on a Mac, Ctrl+Shift+F elsewhere (keydown): search the worktree's files, from any tab. */
export function filesSearchKey(e: Pick<KeyboardEvent, 'type' | 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  if (e.type !== 'keydown' || e.key.toLowerCase() !== 'f' || !e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Find in a terminal: a compact bar at the pane's top-right. */
export function TerminalSearchBar({ port, onClose, focusSignal = 0 }: {
  port: SearchPort;
  onClose: () => void;
  /** Changes when ⌘F is pressed again with the bar open: focus and select the term. */
  focusSignal?: number;
}) {
  const [term, setTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [focusSignal]);
  useEffect(() => port.onResults(setResult), [port]);

  const opts = (incremental: boolean, cs = caseSensitive): SearchOptions => ({ caseSensitive: cs, incremental, decorations: DECORATIONS });
  const search = (t: string, cs = caseSensitive) => {
    if (!t) { port.clear(); setResult(null); return; }
    port.findNext(t, opts(true, cs));
  };
  const next = () => { if (term) port.findNext(term, opts(false)); };
  const prev = () => { if (term) port.findPrevious(term, opts(false)); };
  const close = () => { port.clear(); onClose(); };

  const count = !term || !result ? '' : result.count === 0 ? 'No results' : result.index < 0 ? `${result.count}+` : `${result.index + 1}/${result.count}`;
  const btn = 'flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100';
  return (
    <div
      role="search"
      aria-label="Terminal search"
      // Keys in the bar belong to it: never the terminal, never another ⌘F.
      onKeyDown={(e) => e.stopPropagation()}
      className="surface-pop absolute right-3 top-1 z-20 flex items-center gap-0.5 rounded-md py-0.5 pl-2 pr-0.5 text-[11px] text-zinc-200"
    >
      <input
        ref={inputRef}
        aria-label="Find in terminal"
        value={term}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => { setTerm(e.target.value); search(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
          else if (e.key === 'Escape') { e.preventDefault(); close(); }
        }}
        className="w-36 bg-transparent py-0.5 text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
      />
      <span className="min-w-[3.5rem] text-right font-mono tabular-nums text-zinc-500">{count}</span>
      <button type="button" aria-label="Match case" aria-pressed={caseSensitive} title="Match case"
        onClick={() => { const cs = !caseSensitive; setCaseSensitive(cs); search(term, cs); inputRef.current?.focus(); }}
        className={`${btn} ${caseSensitive ? 'bg-zinc-700 text-zinc-100' : ''}`}>Aa</button>
      <button type="button" aria-label="Previous match" title="Previous (⇧↵)" onClick={prev} className={btn}>↑</button>
      <button type="button" aria-label="Next match" title="Next (↵)" onClick={next} className={btn}>↓</button>
      <button type="button" aria-label="Close search" title="Close (Esc)" onClick={close} className={btn}>✕</button>
    </div>
  );
}
