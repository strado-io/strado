import { useEffect, useRef, useState } from 'react';
import type { ProcInfo } from '../../types';

/** What the hub knows about its worktree's dev server, handed to the Dock. */
export type DevState = {
  path: string;
  status: ProcInfo['status'];
  port: number | null;
  detail: string;
  remote: boolean;
  profiles: { names: string[]; current: string } | null;
  setProfile: (name: string) => void;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
};

/** ▶ dev in the Dock: the worktree's dev server in one button (start / stop,
 * what it is doing, a crash named as one), and a menu with where it serves
 * (the port-forward for a runner's worktree), start/stop, logs and the env
 * profile. Replaces the hub toolbar's Run, Logs and env-profile controls. */
export function DevServerButton({ status, port, error, remote, detail = '', profiles = null, onStart, onStop, onLogs, onProfile }: {
  status: ProcInfo['status'];
  port: number | null;
  error: string | null;
  remote?: boolean;
  /** Where it serves or why it stopped ("localhost:3101 → runner:3000", "exit code 1"). */
  detail?: string;
  /** The repo's env profiles and the active one; null when it has none. */
  profiles?: { names: string[]; current: string } | null;
  onStart: () => void;
  onStop: () => void;
  onLogs: () => void;
  onProfile?: (name: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [menu]);

  const busy = status === 'running' || status === 'starting' || status === 'stopping';
  const label = status === 'starting' ? 'Starting…' : status === 'stopping' ? 'Stopping…' : status === 'running' ? `■ ${port ? `:${port}` : 'dev'}` : status === 'crashed' ? 'Crashed ▶' : '▶ dev';
  const tone = status === 'running' ? 'text-emerald-300' : status === 'crashed' ? 'text-amber-300' : 'text-zinc-400';
  const pickProfile = (name: string) => {
    if (!profiles || name === profiles.current) return;
    if (busy && !window.confirm(`Switch env to "${name}"? This will restart the running process.`)) return;
    onProfile?.(name);
  };
  const item = 'block w-full rounded px-2 py-1 text-left text-xs text-zinc-300 hover:bg-zinc-800';
  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-0.5">
      {error && <span role="alert" title={error} className="max-w-40 truncate text-[11px] text-red-400">{error}</span>}
      <button
        type="button"
        aria-label={busy ? 'Stop dev server' : 'Start dev server'}
        title={detail || undefined}
        disabled={status === 'starting' || status === 'stopping'}
        onClick={busy ? onStop : onStart}
        className={`rounded px-1.5 py-0.5 text-[11px] hover:bg-zinc-800 disabled:cursor-default disabled:hover:bg-transparent ${tone}`}
      >
        {label}
      </button>
      <button type="button" aria-label="Dev server menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}
        className="rounded px-0.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">▾</button>
      {menu && (
        <div
          role="menu"
          aria-label="Dev server"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); } }}
          className="absolute bottom-full right-0 z-[60] mb-1 w-64 space-y-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
        >
          <div className="px-2 py-1 text-[11px] text-zinc-500">{status}{detail ? ` — ${detail}` : ''}</div>
          <button type="button" role="menuitem" className={item} disabled={status === 'starting' || status === 'stopping'}
            onClick={() => { setMenu(false); (busy ? onStop : onStart)(); }}>
            {busy ? 'Stop' : 'Start'}
          </button>
          {!remote && (
            <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); onLogs(); }}>Logs</button>
          )}
          {profiles && profiles.names.length > 0 && (
            <label className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-400">
              <span>Env</span>
              <select
                aria-label="Env profile"
                value={profiles.current}
                onChange={(e) => pickProfile(e.target.value)}
                className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-xs text-zinc-200"
              >
                {profiles.names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
