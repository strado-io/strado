// A worktree's folders, loaded one level at a time as they open. A WAI-ARIA
// tree: one tab stop, arrows to move, Right/Left to open/close or step in/out,
// Enter to open a file. Changed paths carry their git letter; "Changed only"
// hides everything else.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { FileChange, FileTreeEntry, FileTreePage } from '../../types';

type Folder = { entries: FileTreeEntry[]; truncated: boolean } | 'loading' | { error: string };

const CHANGE: Record<FileChange, { text: string; tone: string; word: string }> = {
  M: { text: 'M', tone: 'text-amber-300', word: 'modified' },
  A: { text: 'A', tone: 'text-emerald-400', word: 'added' },
  D: { text: 'D', tone: 'text-red-400', word: 'deleted' },
  R: { text: 'R', tone: 'text-sky-400', word: 'renamed' },
  '?': { text: 'U', tone: 'text-emerald-400', word: 'untracked' },
};

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** "a/b/c.ts" → ["a", "a/b"]. */
const ancestors = (p: string) => p.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));

type Row = { entry: FileTreeEntry; level: number };

export function FileTree({ load, changedOnly, selected, reveal, onSelect }: {
  /** One folder's entries ('' = root). A new function (e.g. ignored toggled) reloads the tree. */
  load: (dir: string) => Promise<FileTreePage>;
  changedOnly: boolean;
  selected: string | null;
  /** Open every folder above this path (a file opened from elsewhere). */
  reveal?: string | null;
  onSelect: (path: string) => void;
}) {
  const [folders, setFolders] = useState<Map<string, Folder>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [focus, setFocus] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  const requested = useRef(new Set<string>());

  const fetchFolder = useCallback((dir: string) => {
    if (requested.current.has(dir)) return;
    requested.current.add(dir);
    setFolders((m) => new Map(m).set(dir, 'loading'));
    Promise.resolve().then(() => load(dir))
      .then((page) => setFolders((m) => new Map(m).set(dir, { entries: page.entries, truncated: page.truncated })))
      .catch((err: Error) => {
        requested.current.delete(dir);
        setFolders((m) => new Map(m).set(dir, { error: err.message }));
      });
  }, [load]);

  // A new loader (ignored files toggled, another worktree) starts over, keeping what is open.
  useEffect(() => {
    requested.current = new Set();
    setFolders(new Map());
  }, [load]);
  useEffect(() => { for (const dir of expanded) if (!folders.has(dir)) fetchFolder(dir); }, [expanded, folders, fetchFolder]);

  useEffect(() => {
    if (!reveal) return;
    setExpanded((s) => {
      const add = ancestors(reveal).filter((d) => !s.has(d));
      return add.length ? new Set([...s, ...add]) : s;
    });
    setFocus(reveal);
  }, [reveal]);

  const rows: Row[] = [];
  const walk = (dir: string, level: number) => {
    const f = folders.get(dir);
    if (!f || f === 'loading' || 'error' in f) return;
    for (const entry of f.entries) {
      if (changedOnly && !entry.change) continue;
      rows.push({ entry, level });
      if (entry.kind === 'dir' && expanded.has(entry.path)) walk(entry.path, level + 1);
    }
  };
  walk('', 1);
  const root = folders.get('');
  const focusPath = focus && rows.some((r) => r.entry.path === focus) ? focus : rows[0]?.entry.path ?? null;

  const toggle = (dir: string, open?: boolean) => setExpanded((s) => {
    const n = new Set(s);
    if (open ?? !n.has(dir)) n.add(dir); else n.delete(dir);
    return n;
  });
  const moveTo = (path: string | undefined) => {
    if (!path) return;
    setFocus(path);
    items.current.get(path)?.focus();
  };
  const activate = (entry: FileTreeEntry) => {
    setFocus(entry.path);
    if (entry.kind === 'dir') toggle(entry.path);
    else onSelect(entry.path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.entry.path === focusPath);
    if (i < 0) return;
    const { entry } = rows[i]!;
    const open = entry.kind === 'dir' && expanded.has(entry.path);
    let handled = true;
    if (e.key === 'ArrowDown') moveTo(rows[i + 1]?.entry.path);
    else if (e.key === 'ArrowUp') moveTo(rows[i - 1]?.entry.path);
    else if (e.key === 'Home') moveTo(rows[0]?.entry.path);
    else if (e.key === 'End') moveTo(rows[rows.length - 1]?.entry.path);
    else if (e.key === 'ArrowRight') {
      if (entry.kind === 'dir' && !open) toggle(entry.path, true);
      else if (open) moveTo(rows[i + 1]?.level === rows[i]!.level + 1 ? rows[i + 1]!.entry.path : undefined);
    } else if (e.key === 'ArrowLeft') {
      if (open) toggle(entry.path, false);
      else moveTo(parentOf(entry.path) || undefined);
    } else if (e.key === 'Enter' || e.key === ' ') activate(entry);
    else handled = false;
    if (handled) e.preventDefault();
  };

  return (
    <div role="tree" aria-label="Files" onKeyDown={onKeyDown} className="flex min-h-0 flex-col overflow-y-auto py-1 text-[13px]" data-testid="file-tree">
      {root === 'loading' || root === undefined ? (
        <p className="px-3 py-2 text-[11px] text-zinc-500">Loading…</p>
      ) : 'error' in root ? (
        <p role="alert" className="px-3 py-2 text-[11px] text-red-300">Couldn’t list files: {root.error}</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-zinc-500">{changedOnly ? 'No changed files.' : 'This folder is empty.'}</p>
      ) : null}
      {rows.map(({ entry, level }) => {
        const isDir = entry.kind === 'dir';
        const open = isDir && expanded.has(entry.path);
        const sub = isDir && open ? folders.get(entry.path) : undefined;
        const change = entry.change ? CHANGE[entry.change] : null;
        const isSel = entry.path === selected;
        return (
          <div key={entry.path} role="none">
            <div
              ref={(el) => { if (el) items.current.set(entry.path, el); else items.current.delete(entry.path); }}
              role="treeitem"
              aria-level={level}
              aria-expanded={isDir ? open : undefined}
              aria-selected={isSel}
              tabIndex={entry.path === focusPath ? 0 : -1}
              data-path={entry.path}
              data-change={entry.change}
              onClick={() => activate(entry)}
              onFocus={() => setFocus(entry.path)}
              title={change ? `${entry.path} — ${change.word}` : entry.path}
              className={`mx-1 flex h-6 cursor-pointer items-center gap-1.5 rounded-md pr-2 outline-none focus-visible:ring-1 focus-visible:ring-sky-400/60 ${
                isSel ? 'glass-pill text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.04]'} ${entry.ignored ? 'opacity-50' : ''}`}
              style={{ paddingLeft: `${(level - 1) * 12 + 6}px` }}
            >
              <span aria-hidden className={`w-3 shrink-0 text-center text-[11px] text-zinc-500 transition-transform ${isDir ? (open ? 'rotate-90' : '') : 'invisible'}`}>›</span>
              <span className={`min-w-0 flex-1 truncate ${isDir ? 'text-zinc-200' : ''} ${change && !isDir ? change.tone : ''}`}>{entry.name}</span>
              {change && (
                <span className={`shrink-0 font-mono text-[11px] ${isDir ? 'text-zinc-500' : change.tone}`} aria-label={change.word}>
                  {isDir ? '•' : change.text}
                </span>
              )}
            </div>
            {sub === 'loading' && <p className="py-0.5 text-[11px] text-zinc-600" style={{ paddingLeft: `${level * 12 + 24}px` }}>Loading…</p>}
            {sub && sub !== 'loading' && 'error' in sub && <p role="alert" className="py-0.5 text-[11px] text-red-300" style={{ paddingLeft: `${level * 12 + 24}px` }}>{sub.error}</p>}
            {sub && sub !== 'loading' && !('error' in sub) && sub.truncated && (
              <p className="py-0.5 text-[11px] text-zinc-600" style={{ paddingLeft: `${level * 12 + 24}px` }}>Showing the first 2,000 entries.</p>
            )}
          </div>
        );
      })}
      {root && root !== 'loading' && !('error' in root) && root.truncated && <p className="px-3 py-1 text-[11px] text-zinc-600">Showing the first 2,000 entries.</p>}
    </div>
  );
}
