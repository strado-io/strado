import { FormEvent, useState } from 'react';
import { api } from '../../api';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { Workspace } from '../../types';

export function WorkspaceGeneralSection() {
  const { workspace, refresh } = useWorkspace();
  const [form, setForm] = useState({
    name: workspace.name,
    icon: workspace.icon,
    color: workspace.color,
    defaultEditor: workspace.defaultEditor,
    defaultPortBase: workspace.defaultPortBase,
    logDir: workspace.logDir,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labelCls = 'flex flex-col gap-1 text-xs text-zinc-400';
  const inputCls = 'rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none';

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.workspaces.patch(workspace.id, {
        name: form.name,
        color: form.color,
        icon: form.icon,
        defaultEditor: form.defaultEditor,
        defaultPortBase: form.defaultPortBase,
        logDir: form.logDir,
      });
      await refresh();
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="max-w-lg" onSubmit={save}>
      <h2 className="mb-4 text-base font-semibold text-zinc-100">
        Workspace <span className="text-zinc-500">({workspace.id})</span>
      </h2>
      {error && <div className="mb-3 rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Name
          <input className={inputCls} value={form.name} required
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className={labelCls}>
          Icon
          <input className={inputCls} value={form.icon} maxLength={2} required
                 onChange={(e) => setForm({ ...form, icon: e.target.value })} />
        </label>
        <label className={labelCls}>
          Color
          <input type="color" className="h-9 w-full rounded border border-zinc-800 bg-transparent"
                 value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
        </label>
        <label className={labelCls}>
          Default editor
          <select className={inputCls} value={form.defaultEditor}
                  onChange={(e) => setForm({ ...form, defaultEditor: e.target.value as Workspace['defaultEditor'] })}>
            <option value="code">VS Code</option>
            <option value="cursor">Cursor</option>
            <option value="subl">Sublime</option>
            <option value="webstorm">WebStorm</option>
          </select>
        </label>
        <label className={labelCls}>
          Default port base
          <input type="number" className={inputCls} min={1024} max={65535} value={form.defaultPortBase}
                 onChange={(e) => setForm({ ...form, defaultPortBase: Number(e.target.value) })} />
        </label>
        <label className={labelCls + ' col-span-2'}>
          Log dir (optional override)
          <input className={inputCls} value={form.logDir ?? ''} placeholder="default: ~/.strado/logs/<id>/"
                 onChange={(e) => setForm({ ...form, logDir: e.target.value || null })} />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="submit" disabled={saving}
                className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved.</span>}
      </div>
    </form>
  );
}
