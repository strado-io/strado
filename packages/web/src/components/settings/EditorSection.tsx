import { useState } from 'react';
import { chosenEditor, setPreferredEditor, useEditors } from '../../hooks/editors';
import type { EditorId } from '../../types';

// Settings › Files › Editor: which desktop editor "Open in editor" uses. The
// editor runs on its own; Strado only hands it the worktree or file.

export function EditorSection() {
  const { answer } = useEditors();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await setPreferredEditor(value ? (value as EditorId) : null);
    } catch {
      setError("Couldn't save that — try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Editor</h1>
        <p className="mt-1 text-[13px] text-zinc-400">
          “Open in editor” in Files, the worktree card and its menu hands the worktree, or the file at its line, to this app.
        </p>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] text-zinc-200">Open files in</span>
        {!answer ? (
          <span className="text-[11px] text-zinc-500">Looking for editors…</span>
        ) : (
          <select
            aria-label="Open files in"
            value={answer.preferred ?? ''}
            disabled={busy}
            onChange={(e) => void save(e.target.value)}
            className="w-64 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[13px] text-zinc-100 disabled:opacity-40"
          >
            <option value="">Automatic ({chosenEditor({ ...answer, preferred: null }).label})</option>
            {answer.editors.map((e) => (
              <option key={e.id} value={e.id} disabled={!e.available}>
                {e.available ? e.label : `${e.label} (not installed)`}
              </option>
            ))}
          </select>
        )}
      </label>
      {answer && !chosenEditor(answer).lines && (
        <p className="mt-2 text-[11px] text-zinc-500">This one opens the file, but not at a line.</p>
      )}
      {error && <p role="alert" className="mt-2 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
