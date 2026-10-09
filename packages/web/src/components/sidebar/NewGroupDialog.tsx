// Names a new focus group. In-app because the desktop shell (Electron) has no
// window.prompt — it returns nothing, so a prompt-based flow silently no-ops.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export function NewGroupDialog({ onCreate, onCancel }: {
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = () => { if (name.trim()) onCreate(name.trim()); };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="New focus group"
        className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm text-zinc-200">New focus group</div>
        <input
          autoFocus
          aria-label="New group name"
          value={name}
          maxLength={80}
          placeholder="e.g. FX-412"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
            Cancel
          </button>
          <button onClick={submit} disabled={!name.trim()}
            className="rounded bg-sky-700 px-3 py-1 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50">
            Create
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
