import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../types';
import { moveId, targetIndex } from '../hooks/workspaceOrder';

type Drag = { id: string; from: number; startY: number; y: number };

/**
 * The Workspaces dialog's rows. Order here is the order the sidebar dots and
 * the sidebar swipe run through, so it is worth being able to rearrange —
 * done with pointer events rather than HTML5 drag-and-drop, like the terminal
 * tab strip.
 */
export function WorkspaceRows({
  workspaces,
  activeId,
  onReorder,
  onDelete,
  disabled = false,
}: {
  workspaces: Workspace[];
  activeId: string | null;
  onReorder: (ids: string[]) => void;
  onDelete: (w: Workspace) => void;
  // Set while a previous drop's save is still in flight, so neither a second
  // drag nor a delete can clobber the order being written.
  disabled?: boolean;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const rects = useRef<{ top: number; height: number }[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const sortable = workspaces.length > 1;

  // Escape abandons a drag; the row springs back to where it started.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  const start = (e: React.PointerEvent, id: string, from: number) => {
    if (!sortable || disabled) return;
    // Measured once: the rows move under the pointer from here on, so live
    // measurement would chase its own transforms.
    rects.current = Array.from(body.current?.querySelectorAll('tr') ?? []).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, from, startY: e.clientY, y: e.clientY });
  };

  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, y: e.clientY });
  };

  const finish = (e: React.PointerEvent) => {
    if (!drag) return;
    const to = targetIndex(e.clientY, rects.current);
    const ids = workspaces.map((w) => w.id);
    const next = moveId(ids, drag.id, to);
    setDrag(null);
    if (next.some((id, i) => id !== ids[i])) onReorder(next);
  };

  // While a row is lifted, the rows it has passed shift by one row height so
  // the gap is always where it would land.
  const shiftFor = (index: number): number => {
    if (!drag) return 0;
    const to = targetIndex(drag.y, rects.current);
    const h = rects.current[index]?.height ?? 0;
    if (index === drag.from) return drag.y - drag.startY;
    if (drag.from < to && index > drag.from && index <= to) return -h;
    if (drag.from > to && index < drag.from && index >= to) return h;
    return 0;
  };

  return (
    <tbody ref={body}>
      {workspaces.map((w, i) => {
        const lifted = drag?.id === w.id;
        return (
          <tr
            key={w.id}
            data-index={i}
            data-testid={`ws-row-${w.id}`}
            className={`border-t border-zinc-900 ${lifted ? 'bg-zinc-900' : ''}`}
            style={{
              transform: `translateY(${shiftFor(i)}px)`,
              transition: drag ? 'none' : 'transform 120ms ease-out',
              position: 'relative',
              zIndex: lifted ? 10 : undefined,
            }}
          >
            <td className="px-2 py-2">
              {sortable && (
                <button
                  type="button"
                  aria-label={`Reorder ${w.name}`}
                  onPointerDown={(e) => start(e, w.id, i)}
                  onPointerMove={move}
                  onPointerUp={finish}
                  onPointerCancel={() => setDrag(null)}
                  aria-disabled={disabled}
                  className={`rounded px-1 text-zinc-600 ${
                    disabled
                      ? 'cursor-not-allowed opacity-40'
                      : 'cursor-grab hover:bg-zinc-900 hover:text-zinc-300 active:cursor-grabbing'
                  }`}
                >
                  ⠿
                </button>
              )}
            </td>
            <td className="px-2 py-2 text-base">{w.icon}</td>
            <td className="px-2 py-2">
              {w.name}
              {w.id === activeId && <span className="ml-2 text-[10px] text-emerald-400">active</span>}
            </td>
            <td className="px-2 py-2 font-mono text-[11px] text-zinc-400">{w.id}</td>
            <td className="px-2 py-2">
              <span className="inline-block h-4 w-4 rounded" style={{ background: w.color }} />
            </td>
            <td className="px-2 py-2 text-zinc-400">{w.defaultEditor}</td>
            <td className="px-2 py-2 text-zinc-400">{w.defaultPortBase}</td>
            <td className="px-2 py-2 text-right">
              {workspaces.length > 1 && (
                <button
                  onClick={() => onDelete(w)}
                  // A delete while the order is saving is refused upstream;
                  // showing it as available would make that look like a bug.
                  disabled={disabled}
                  className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:border-red-700 hover:bg-red-900/30 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-800 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
                >
                  Delete
                </button>
              )}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
