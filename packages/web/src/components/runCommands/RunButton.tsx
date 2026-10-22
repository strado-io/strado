import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, PlayIcon, StopIcon } from '../hub/icons';

export type RunStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
export type RunEntry = { id: string; name: string; status: RunStatus; port?: number | null };

const live = (s: RunStatus) => s === 'starting' || s === 'running' || s === 'stopping';
const short = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name);
const STATE_WORD: Partial<Record<RunStatus, string>> = { starting: 'starting', running: 'running', stopping: 'stopping', crashed: 'crashed' };

/** The worktree header's Run, split: the main part runs (or stops) the
 * repo's default run command; ▾ lists every run command with its state. */
export function RunButton({ entries, defaultId, onStart, onStop, onOpenTab, onAdd, menu = true, detail = '' }: {
  entries: RunEntry[];
  defaultId: string | null;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  /** A running command's own tab. */
  onOpenTab: (id: string) => void;
  /** "+ Add run command…": the repo's run-command editor. */
  onAdd: () => void;
  /** The ▾ menu of every run command (off for a worktree on a runner). */
  menu?: boolean;
  /** Where it serves (URL or port), for the title. */
  detail?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);

  const base = 'flex shrink-0 items-center gap-1.5 self-start border px-2 py-1 text-[11px] font-medium transition';
  const def = entries.find((x) => x.id === defaultId) ?? entries[0];
  if (!def) {
    return (
      <button type="button" aria-label="Add run command" title="Add a run command for this repo" onClick={onAdd}
        className={`${base} rounded-md border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-100`}>
        <PlayIcon /><span>Add run</span>
      </button>
    );
  }
  const busy = live(def.status);
  const label = def.status === 'starting' ? 'Starting…'
    : def.status === 'running' ? (def.port ? `Stop :${def.port}` : 'Stop')
      : def.status === 'stopping' ? 'Stopping…'
        : def.status === 'crashed' ? 'Crashed'
          : def.name ? `Run ${short(def.name)}` : 'Run';
  // One pill: the border and colour are the group's; the halves only shade on hover.
  const tone = def.status === 'running' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : def.status === 'starting' ? 'animate-pulse border-amber-500/30 bg-amber-500/10 text-amber-300'
      : def.status === 'stopping' ? 'animate-pulse border-zinc-700 bg-zinc-900 text-zinc-400'
        : def.status === 'crashed' ? 'border-red-500/30 bg-red-500/10 text-red-300'
          : 'border-zinc-800 text-zinc-300 hover:border-zinc-600';
  const half = 'flex items-center gap-1.5 py-1 text-[11px] font-medium transition hover:bg-white/5 hover:text-zinc-100 disabled:hover:bg-transparent';
  return (
    <div ref={rootRef} className={`relative flex shrink-0 self-start overflow-visible rounded-md border ${tone}`}>
      <button
        type="button"
        aria-label={[busy ? 'Stop' : 'Run', def.name].filter(Boolean).join(' ')}
        title={`${[busy ? 'Stop' : 'Run', def.name].filter(Boolean).join(' ')} — ${def.status}${detail ? ` (${detail})` : ''}`}
        disabled={def.status === 'stopping'}
        onClick={() => (busy ? onStop(def.id) : onStart(def.id))}
        className={`${half} px-2 ${menu ? 'rounded-l-[5px]' : 'rounded-[5px]'}`}
      >
        {busy ? <StopIcon /> : <PlayIcon />}
        <span>{label}</span>
      </button>
      {menu && <>
        <span aria-hidden className="my-1 w-px bg-current opacity-20" />
        <button type="button" aria-label="Run commands" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
          className={`${half} rounded-r-[5px] px-1 ${open ? 'bg-white/5' : ''}`}><ChevronDownIcon size={12} /></button>
      </>}
      {open && (
        <div role="menu" aria-label="Run commands" tabIndex={-1}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
          className="surface-pop absolute right-0 top-full z-50 mt-1 min-w-48 rounded-md p-1 text-[11px]">
          {entries.map((x) => (
            <div key={x.id} className="flex items-center gap-1">
              <button type="button" role="menuitem"
                aria-label={[x.name, STATE_WORD[x.status]].filter(Boolean).join(' · ')}
                onClick={() => { setOpen(false); if (live(x.status)) onOpenTab(x.id); else onStart(x.id); }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800">
                <span className="truncate">{x.name}</span>
                {x.id === def.id && <span className="text-[10px] text-zinc-600">default</span>}
                {STATE_WORD[x.status] && (
                  <span className={`ml-auto shrink-0 ${x.status === 'crashed' ? 'text-red-300' : 'text-emerald-300'}`}>{STATE_WORD[x.status]}</span>
                )}
              </button>
              {live(x.status) && (
                <button type="button" aria-label={`Stop ${x.name}`} disabled={x.status === 'stopping'} onClick={() => { setOpen(false); onStop(x.id); }}
                  className="shrink-0 rounded px-1 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-300"><StopIcon /></button>
              )}
            </div>
          ))}
          <div className="my-1 border-t border-zinc-800" />
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onAdd(); }}
            className="w-full rounded px-2 py-1 text-left text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">+ Add run command…</button>
        </div>
      )}
    </div>
  );
}
