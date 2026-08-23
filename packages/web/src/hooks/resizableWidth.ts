import { useEffect, useRef, useState } from 'react';

// Drag-to-resize width for a vertical panel edge, persisted per key so the
// layout survives restarts. `edge` is which side of the panel the handle sits
// on: dragging away from the panel body always grows it.
export function useResizableWidth({ storageKey, min, max, fallback, edge }: {
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
  edge: 'left' | 'right';
}) {
  const clamp = (n: number) =>
    Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  const [width, setWidth] = useState(() => {
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
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const stopResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    try { localStorage.setItem(storageKey, String(widthRef.current)); } catch { /* noop */ }
  };

  // Safety net: a release the renderer never sees (cursor over a native
  // preview view, window blur) still ends the drag and persists the width.
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
      dragRef.current = { startX: e.clientX, startW: widthRef.current };
      setResizing(true);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / pointer gone */ }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = edge === 'right' ? e.clientX - d.startX : d.startX - e.clientX;
      setWidth(clamp(d.startW + delta));
    },
    onPointerUp: stopResize,
    onLostPointerCapture: stopResize,
  };

  return { width, resizing, handleProps };
}
