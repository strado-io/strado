import { useState } from 'react';
import type { Workspace } from '../types';

export function NewWorkspaceDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (ws: Workspace) => Promise<void>;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [defaultEditor, setEditor] = useState<Workspace['defaultEditor']>('code');
  const [defaultPortBase, setPortBase] = useState(8000);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onCreate({
        id,
        name,
        // These values remain part of the stored workspace shape for backward
        // compatibility, but they are no longer user-facing settings.
        color: '#71717a',
        icon: name.trim().charAt(0).toUpperCase() || 'W',
        defaultEditor,
        defaultPortBase,
        logDir: null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  const labelCls = 'flex flex-col gap-1 text-xs text-zinc-400';
  const inputCls = 'rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-xl"
      >
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">New workspace</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            ID
            <input className={inputCls} value={id} onChange={(e) => setId(e.target.value)}
                   pattern="[a-z0-9-]+" required placeholder="e.g. strado" />
          </label>
          <label className={labelCls}>
            Name
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className={labelCls}>
            Editor
            <select className={inputCls} value={defaultEditor}
                    onChange={(e) => setEditor(e.target.value as Workspace['defaultEditor'])}>
              <option value="code">VS Code</option>
              <option value="cursor">Cursor</option>
              <option value="subl">Sublime</option>
              <option value="webstorm">WebStorm</option>
            </select>
          </label>
          <label className={labelCls}>
            Default port base
            <input type="number" className={inputCls} min={1024} max={65535}
                   value={defaultPortBase}
                   onChange={(e) => setPortBase(Number(e.target.value))} />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose}
                  className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900">
            Cancel
          </button>
          <button type="submit" disabled={submitting}
                  className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50">
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
