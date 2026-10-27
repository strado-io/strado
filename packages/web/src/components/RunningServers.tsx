import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Worktree } from '../types';
import { isRunning } from '../hooks/filters';
import { useRendererOverlay } from '../contexts/RendererOverlay';

/**
 * Every dev server serving right now, across every worktree, in one place.
 *
 * Worktree rows say whether THAT worktree is serving; nothing answered
 * "what is up, on which port" without hunting. The
 * chip hides itself at zero, so it never becomes another empty surface.
 */
export function RunningServers({
  worktrees, onOpen, onStop, onKillExternal, placement = 'down',
}: {
  worktrees: Worktree[];
  onOpen: (w: Worktree) => void;
  onStop: (w: Worktree) => void;
  onKillExternal: (w: Worktree) => void;
  /** Where the list opens: under the chip, or above the bar it sits in, at that
   *  bar's width (the sidebar's bottom bar: its nearest positioned box), so it
   *  stays over the sidebar, clear of a Browser tab's native view. */
  placement?: 'down' | 'up';
}) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  // Up, the list is portalled to the body at the chip's spot: inside the
  // sidebar's glass bar (its own stacking context) it would sit under the panes.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; mid: number } | null>(null);
  const toggle = () => {
    const r = chip.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.left, bottom: window.innerHeight - r.top, mid: r.width / 2 });
    setOpen((v) => !v);
  };
  const running = worktrees.filter(isRunning);
  // A Browser tab's native view paints over the DOM: it steps aside while the list shows.
  useRendererOverlay(open && running.length > 0);

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

  // Up, it floats over the icon like a tooltip, its arrow on the icon, so it
  // never reads as part of the sidebar; opaque (menu-solid), as frosted glass
  // over the bar's own glass composites see-through.
  const list = (
    <div className={placement === 'up'
      ? 'menu-solid fixed z-[91] w-max min-w-56 max-w-[320px] rounded-lg p-1 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.6)]'
      : 'surface-pop absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md p-1'}
      style={placement === 'up' && anchor ? { left: anchor.left, bottom: anchor.bottom + 10 } : undefined}>
      {running.map((w) => (
        <div key={w.path} className="group flex items-center gap-2 rounded pr-1 hover:bg-zinc-900">
          <button
            onClick={() => { setOpen(false); onOpen(w); }}
            title={w.process.proxyUrl ?? w.process.detectedUrl ?? w.path}
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
      {placement === 'up' && (
        <span aria-hidden data-testid="running-arrow"
          style={{ left: (anchor?.mid ?? 14) - 5 }}
          className="absolute -bottom-[5px] h-2.5 w-2.5 rotate-45 border-b border-r border-white/[0.09] bg-[rgb(20_21_25)] [:root[data-theme=light]_&]:border-black/[0.12] [:root[data-theme=light]_&]:bg-white" />
      )}
    </div>
  );

  return (
    <div className="relative shrink-0 self-center">
      {placement === 'up' ? (
        // In the sidebar's bottom bar: an icon like its neighbours, and the count.
        <button
          ref={chip}
          onClick={toggle}
          aria-label="Running dev servers"
          aria-expanded={open}
          title={`${running.length} running`}
          className={`flex h-7 shrink-0 items-center gap-1 rounded-md border px-1.5 transition-colors ${
            open ? 'tab-pill text-zinc-100' : 'border-transparent text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'}`}
        >
          <ActivityIcon />
          <span className="text-[11px] tabular-nums text-emerald-400">{running.length}</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Running dev servers"
          aria-expanded={open}
          title="Running dev servers"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="tabular-nums">{running.length}</span>
          <span className="text-zinc-500">running</span>
        </button>
      )}
      {open && placement !== 'up' && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {list}
        </>
      )}
      {open && placement === 'up' && anchor && createPortal(
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} />
          {list}
        </>,
        document.body,
      )}
    </div>
  );
}

// Lucide "activity": something live. Not "server", which stands for a
// machine (a runner) elsewhere in the app.
function ActivityIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
