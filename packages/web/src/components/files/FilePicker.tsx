import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileList } from '../../types';
import { fuzzyFiles } from '../../lib/fuzzyPath';

// ⌘P in a worktree: type part of a file's name, Enter opens it in the Files
// tab. "name:42" opens at line 42. The list is the worktree's tracked and
// untracked files (not ignored ones), fetched when the picker opens.

const LIMIT = 50;

function Highlighted({ path, positions }: { path: string; positions: number[] }) {
  const hit = new Set(positions);
  const cut = path.lastIndexOf('/') + 1;
  const part = (from: number, to: number) => [...path.slice(from, to)].map((ch, k) => (
    hit.has(from + k) ? <span key={from + k} className="text-zinc-100">{ch}</span> : ch
  ));
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-[13px] text-zinc-300">{part(cut, path.length)}</span>
      {cut > 0 && <span className="min-w-0 truncate text-[11px] text-zinc-500">{part(0, cut - 1)}</span>}
    </span>
  );
}

export function FilePicker({ load, onPick, onClose }: {
  load: () => Promise<FileList>;
  onPick: (path: string, line: number | undefined) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<FileList | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    load().then((r) => { if (alive) setList(r); }, () => { if (alive) setFailed(true); });
    inputRef.current?.focus();
    return () => { alive = false; };
  }, [load]);

  // "util:42" → the name to match, and the line to land on.
  const lineMatch = /^(.*?):(\d+)$/.exec(query.trim());
  const name = lineMatch ? lineMatch[1]! : query.trim();
  const line = lineMatch ? Number(lineMatch[2]) || undefined : undefined;
  const matches = useMemo(() => (list ? fuzzyFiles(name, list.files, LIMIT) : []), [list, name]);
  const selected = Math.min(index, Math.max(0, matches.length - 1));

  const pick = (path: string) => onPick(path, line);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!matches.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setIndex((selected + dir + matches.length) % matches.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches[selected];
      if (m) pick(m.path);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-center bg-black/30 pt-[12vh]" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label="Go to file" className="surface-pop flex h-fit max-h-[60vh] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl">
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Go to file"
          aria-expanded="true"
          aria-controls="file-picker-list"
          aria-activedescendant={matches[selected] ? `file-picker-${selected}` : undefined}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={onKeyDown}
          placeholder="Go to file (name, or name:line)"
          spellCheck={false}
          className="w-full border-b border-zinc-800 !bg-transparent px-3 py-2.5 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <ul id="file-picker-list" role="listbox" aria-label="Files" className="min-h-0 flex-1 overflow-y-auto py-1">
          {matches.map((m, i) => (
            <li
              key={m.path}
              id={`file-picker-${i}`}
              role="option"
              aria-selected={i === selected}
              title={m.path}
              onPointerMove={() => { if (i !== selected) setIndex(i); }}
              onClick={() => pick(m.path)}
              className={`mx-1 cursor-pointer rounded-md px-2 py-1 ${i === selected ? 'bg-zinc-800' : ''}`}
            >
              <Highlighted path={m.path} positions={m.positions} />
            </li>
          ))}
        </ul>
        {failed ? (
          <p className="px-3 py-2 text-[11px] text-zinc-500">Couldn&apos;t list this worktree&apos;s files</p>
        ) : !list ? (
          <p role="status" className="px-3 py-2 text-[11px] text-zinc-500">Listing files…</p>
        ) : matches.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-zinc-500">No matching files</p>
        ) : list.truncated ? (
          <p className="border-t border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">Showing the first {list.files.length.toLocaleString()} files of a very large worktree</p>
        ) : null}
      </div>
    </div>
  );
}
