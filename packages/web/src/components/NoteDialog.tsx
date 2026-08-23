import { useEffect, useState } from 'react';
import type { Worktree } from '../types';

export function NoteDialog({
  worktree,
  onSave,
  onCancel,
}: {
  worktree: Worktree;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(worktree.meta?.note ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const label = worktree.meta?.ticketId ?? worktree.path.split('/').pop();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm text-zinc-200">
          Note · <span className="font-mono text-zinc-100">{label}</span>
        </div>
        <textarea
          autoFocus
          aria-label="Note"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What changes / requirements does this worktree need?"
          className="h-48 w-full resize-none rounded border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(text)}
            className="rounded bg-sky-700 px-3 py-1 text-sm font-medium text-white hover:bg-sky-600"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
