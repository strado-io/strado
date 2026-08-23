import { useEffect, useRef, useState } from 'react';

// Drag-to-resize height for a horizontal panel edge, persisted per key so the
// layout survives restarts. `edge` is which side of the panel the handle sits
// on: dragging away from the panel body always grows it. A bottom-docked drawer
// uses edge: 'top' — dragging the top handle upward makes it taller.
export function useResizableHeight({ storageKey, min, max, fallback, edge }: {
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
  edge: 'top' | 'bottom';
}) {
  const clamp = (n: number) =>
    Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  const [height, setHeight] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return fallback;
      const n = Number(raw);
      return n > 0 ? clamp(n) : fallback;
    } catch {
      return fallback;
    }
  });
  const [resizing, setResizing] = useState(false);
  const heightRef = useRef(height);
  heightRef.current = height;
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const stopResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    try { localStorage.setItem(storageKey, String(heightRef.current)); } catch { /* noop */ }
  };

  // Safety net: a release the renderer never sees (cursor over a native
  // preview view, window blur) still ends the drag and persists the height.
  useEffect(() => {
    if (!resizing) return;
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('blur', stopResize);
    return () => {
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('blur', stopResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizing]);

  const handleProps = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: heightRef.current };
      setResizing(true);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / pointer gone */ }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = edge === 'bottom' ? e.clientY - d.startY : d.startY - e.clientY;
      setHeight(clamp(d.startH + delta));
    },
    onPointerUp: stopResize,
    onLostPointerCapture: stopResize,
  };

  return { height, resizing, handleProps };
}
