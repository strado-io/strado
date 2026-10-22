import { useEffect, useRef, useState } from 'react';
import type { RunCommand } from '../../types';

type Row = Omit<RunCommand, 'id'> & { id?: string; key: string };
/** What is saved: the list in tab order, the default first; a new row has no id (the server mints one). */
export type RunCommandDraft = { id?: string; name: string; command: string; envFile: string | null };
let seq = 0;
const newKey = () => `new-${++seq}`;

/** A repo's run commands: name, command, optional env file. Add, rename,
 * delete, and pick the default (the header's main Run). Saved as one list. */
export function RunCommandsDialog({ repoName, commands, onSave, onClose, startAdding = false }: {
  repoName: string;
  /** In order; the first is the default. */
  commands: RunCommand[];
  onSave: (commands: RunCommandDraft[]) => Promise<void>;
  onClose: () => void;
  /** Opened from "+ Add run command…": a fresh row, focused. */
  startAdding?: boolean;
}) {
  const blank = (): Row => ({ key: newKey(), name: '', command: '', envFile: null });
  const [rows, setRows] = useState<Row[]>(() => [...commands.map((c) => ({ ...c, envFile: c.envFile ?? null, key: c.id })), ...(startAdding ? [blank()] : [])]);
  // The default, by row key (a new row has no id yet).
  const [def, setDef] = useState<string | null>(commands[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const focusKey = useRef<string | null>(startAdding ? rows[rows.length - 1]!.key : null);
  const nameRefs = useRef(new Map<string, HTMLInputElement>());
  useEffect(() => {
    if (!focusKey.current) return;
    nameRefs.current.get(focusKey.current)?.focus();
    focusKey.current = null;
  });

  const set = (key: string, patch: Partial<RunCommand>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const names = rows.map((r) => r.name.trim().toLowerCase());
  const duplicate = names.some((n, i) => n && names.indexOf(n) !== i);
  const incomplete = rows.some((r) => !r.name.trim() || !r.command.trim());
  const effectiveDefault = rows.some((r) => r.key === def) ? def : rows[0]?.key ?? null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const ordered = [...rows.filter((r) => r.key === effectiveDefault), ...rows.filter((r) => r.key !== effectiveDefault)];
      await onSave(ordered.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), command: r.command.trim(), envFile: r.envFile?.trim() || null })));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none';
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`Run commands — ${repoName}`} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        className="w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-200 shadow-2xl">
        <h2 className="mb-3 text-sm font-medium">Run commands <span className="text-zinc-500">— {repoName}</span></h2>
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.key} role="group" aria-label={`Run command ${r.name || '(new)'}`} className="grid grid-cols-[8rem_1fr_auto] items-start gap-2 rounded-md border border-zinc-800 p-2">
              <label className="flex flex-col gap-1 text-[10px] text-zinc-500">Name
                <input ref={(el) => { if (el) nameRefs.current.set(r.key, el); else nameRefs.current.delete(r.key); }}
                  aria-label="Name" className={field} value={r.name} placeholder="dev" onChange={(e) => set(r.key, { name: e.target.value })} />
              </label>
              <div className="flex flex-col gap-1">
                <label className="flex flex-col gap-1 text-[10px] text-zinc-500">Command
                  <input aria-label="Command" className={`${field} font-mono`} value={r.command} placeholder="pnpm dev" onChange={(e) => set(r.key, { command: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-[10px] text-zinc-500">Env file (optional)
                  <input aria-label="Env file (optional)" className={`${field} font-mono`} value={r.envFile ?? ''} placeholder=".env.local" onChange={(e) => set(r.key, { envFile: e.target.value })} />
                </label>
              </div>
              <div className="flex flex-col items-end gap-2 pt-4">
                <label className="flex items-center gap-1 text-[10px] text-zinc-400">
                  <input type="radio" name="default-run" aria-label="Default" checked={effectiveDefault === r.key} onChange={() => setDef(r.key)} />Default
                </label>
                <button type="button" aria-label={`Delete ${r.name || 'run command'}`} onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}
                  className="rounded px-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-red-300">Delete</button>
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => { const b = blank(); focusKey.current = b.key; setRows((x) => [...x, b]); }}
          className="mt-2 rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">+ Add run command</button>
        {duplicate && <div className="mt-2 text-xs text-amber-300">Names must be unique</div>}
        {error && <div role="alert" className="mt-2 text-xs text-red-300">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800">Cancel</button>
          <button type="button" disabled={saving || duplicate || incomplete} onClick={() => void save()}
            className="rounded bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40">Save</button>
        </div>
      </div>
    </div>
  );
}

/** The server's refusal of a run-command list, in words (details.reason/index from VALIDATION). */
export function runCommandsError(err: unknown): string {
  const d = (err as { details?: { reason?: string; index?: number } } | null)?.details;
  const row = typeof d?.index === 'number' ? `Row ${d.index + 1}: ` : '';
  if (d?.reason === 'name_required') return `${row}a name is required`;
  if (d?.reason === 'name_taken') return `${row}that name is taken`;
  if (d?.reason === 'command_required') return `${row}a command is required`;
  if (d?.reason === 'id_taken') return `${row}that id is taken (rename it and save again)`;
  return (err as Error)?.message || 'Could not save the run commands';
}
