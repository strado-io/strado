import { useMemo, useState } from 'react';
import { api } from '../api';
import type { Workspace } from '../types';

// First screen a fresh install sees (after the invite gate): name your
// workspace, pick an accent, go. Icon is derived from the name; everything
// is editable later in workspace settings.
const COLORS = ['#f97f1b', '#0ea5e9', '#a78bfa', '#34d399', '#f472b6', '#facc15'];

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'default';
}

export function CreateWorkspaceScreen({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('Personal');
  const [color, setColor] = useState(COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const icon = useMemo(() => (name.trim()[0] ?? 'P').toUpperCase(), [name]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = slug(name);
      await api.workspaces.create({
        id,
        name: name.trim(),
        color,
        icon,
        defaultEditor: 'code',
        defaultPortBase: 8080,
        logDir: null,
      } as Workspace);
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-lg text-lg font-semibold text-white"
            style={{ backgroundColor: color }}
            aria-hidden
          >
            {icon}
          </span>
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Create your workspace</h1>
            <p className="text-xs text-zinc-500">Groups your repos and worktrees. Add more later for other orgs.</p>
          </div>
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
          onFocus={(e) => e.target.select()}
          aria-label="Workspace name"
          className="mt-4 h-10 w-full rounded border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          placeholder="Personal, Acme, Widgets Co…"
        />
        <div className="mt-3 flex items-center gap-2" role="radiogroup" aria-label="Accent color">
          {COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={c === color}
              aria-label={`color ${c}`}
              onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full transition-transform ${c === color ? 'scale-110 ring-2 ring-zinc-300 ring-offset-2 ring-offset-zinc-950' : 'hover:scale-105'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        {error && <div className="mt-3 rounded bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</div>}
        <button
          onClick={() => void create()}
          disabled={!name.trim() || busy}
          className="mt-4 h-10 w-full rounded bg-sky-700 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </div>
    </div>
  );
}
