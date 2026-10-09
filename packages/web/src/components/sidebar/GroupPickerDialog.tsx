// "Add to group…" from a worktree's ⋯ menu: tick the groups it belongs in, or
// type a new name. A dialog rather than one menu line per group, so the row
// menu stays short however many groups there are.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FocusGroup } from '../../api';

export function GroupPickerDialog({ groups, memberId, onToggle, onCreate, onClose }: {
  /** Groups the worktree can be added to (finished ones are left out). */
  groups: FocusGroup[];
  memberId: string;
  onToggle: (groupId: string, add: boolean) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = query.trim();
  const shown = groups.filter((g) => g.name.toLowerCase().includes(name.toLowerCase()));
  const exact = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  const toggle = (g: FocusGroup) => onToggle(g.id, !g.members.includes(memberId));
  const create = () => { onCreate(name); onClose(); };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[15vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Add to group"
        className="flex w-full max-w-sm flex-col rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          aria-label="Find or create a group"
          value={query}
          maxLength={80}
          placeholder={groups.length ? 'Find a group or type a new name…' : 'Name a new group…'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !name) return;
            if (exact) toggle(exact);
            else create();
          }}
          className="w-full border-b border-zinc-800 bg-transparent px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        <div className="max-h-72 overflow-y-auto p-1">
          {shown.map((g) => {
            const member = g.members.includes(memberId);
            return (
              <label key={g.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900">
                <input type="checkbox" aria-label={g.name} checked={member} onChange={() => toggle(g)}
                  className="h-3.5 w-3.5 shrink-0 accent-sky-500" />
                <span className="min-w-0 flex-1 truncate font-mono">{g.name}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-600">{g.members.length}</span>
              </label>
            );
          })}
          {name && !exact && (
            <button onClick={create}
              className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-sky-300 hover:bg-zinc-900">
              + Create “{name}”
            </button>
          )}
          {!name && shown.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-zinc-600">No groups yet — type a name to create one.</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
