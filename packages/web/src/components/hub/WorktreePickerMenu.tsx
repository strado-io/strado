import { useState } from 'react';
import { PROC_COLOR } from './shared';

export type PickerCandidate = {
  path: string;
  label: string;
  title: string;
  procStatus: string;
};

// The header "+" popover: search + pick any workspace worktree that isn't
// already open as a super tab. Search state lives here — the popover mounts
// fresh on every open, so the query resets naturally.
export function WorktreePickerMenu({
  anchor,
  onClose,
  candidates,
  onPick,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  candidates: PickerCandidate[];
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = candidates
    .filter(
      (c) =>
        !q ||
        c.label.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.path.toLowerCase().includes(q),
    )
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="fixed inset-0 z-30" onClick={onClose}>
      <div
        className="absolute flex max-h-80 w-80 flex-col rounded-md border border-zinc-800 bg-zinc-900 py-1 text-xs shadow-2xl"
        style={{ left: anchor.x, top: anchor.y }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
        aria-label="Open worktree"
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered[0]) onPick(filtered[0].path);
          }}
          placeholder="Search worktrees…"
          aria-label="Search worktrees"
          className="mx-2 mb-1 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <div className="overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-zinc-500">
              {q ? 'No worktrees match' : 'All worktrees are already open'}
            </div>
          )}
          {filtered.map((c) => (
            <button
              key={c.path}
              onClick={() => onPick(c.path)}
              title={c.path}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${PROC_COLOR[c.procStatus] ?? 'bg-zinc-600'}`} />
              <span className="truncate font-mono">{c.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
