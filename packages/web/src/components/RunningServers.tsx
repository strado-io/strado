import { useEffect, useState } from 'react';
import type { Worktree } from '../types';
import { isRunning } from '../hooks/filters';

/**
 * Every dev server serving right now, across every worktree, in one place.
 *
 * Worktree rows say whether THAT worktree is serving; nothing answered
 * "what is up, on which port" without hunting. The
 * chip hides itself at zero, so it never becomes another empty surface.
 */
export function RunningServers({
  worktrees, onOpen, onStop, onKillExternal,
}: {
  worktrees: Worktree[];
  onOpen: (w: Worktree) => void;
  onStop: (w: Worktree) => void;
  onKillExternal: (w: Worktree) => void;
}) {
  const [open, setOpen] = useState(false);
  const running = worktrees.filter(isRunning);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (running.length === 0) return null;

  const label = (w: Worktree) => w.meta?.ticketId?.trim() || w.branch || w.path.split('/').pop() || w.path;
  // What the row says to the right of the name: the port if we have one (an
  // external one falls back to its pid — a bare ":" would read as a missing
  // value), then the one thing worth knowing beyond "up": that Strado did not
  // start it, or that it is on its way up or down.
  const where = (w: Worktree) =>
    w.process.port ? `:${w.process.port}` : w.process.external ? `pid ${w.process.pid ?? '?'}` : '';
  const stage = (w: Worktree) =>
    w.process.external ? 'detected'
      : w.process.status === 'starting' ? 'starting…'
        : w.process.status === 'stopping' ? 'stopping…'
          : '';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Running dev servers"
        aria-expanded={open}
        title="Running dev servers"
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span className="tabular-nums">{running.length}</span>
        <span className="text-zinc-500">running</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-2xl">
            {running.map((w) => (
              <div key={w.path} className="group flex items-center gap-2 rounded pr-1 hover:bg-zinc-900">
                <button
                  onClick={() => { setOpen(false); onOpen(w); }}
                  title={w.process.detectedUrl ?? w.path}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{label(w)}</span>
                  {where(w) && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">{where(w)}</span>
                  )}
                  {stage(w) && (
                    <span className="shrink-0 text-[10px] text-zinc-600">{stage(w)}</span>
                  )}
                </button>
                {/* Stopping keeps the list open — you often stop several in a
                    row; opening a worktree is what dismisses it. */}
                {w.process.external ? (
                  <button
                    onClick={() => onKillExternal(w)}
                    aria-label={`Kill external process for ${label(w)}`}
                    title="Kill external process"
                    className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-red-300"
                  >
                    <StopIcon />
                  </button>
                ) : (
                  <button
                    onClick={() => onStop(w)}
                    aria-label={`Stop ${label(w)}`}
                    title="Stop"
                    className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-red-300"
                  >
                    <StopIcon />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
