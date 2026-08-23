import { useCallback, useEffect, useRef, useState } from 'react';

export type ColumnId = 'ticket' | 'workflow' | 'branch' | 'changes' | 'spent' | 'status';

export type ColumnWidths = Record<ColumnId, number>;

const STORAGE_KEY = 'strado:column-widths';

const DEFAULTS: ColumnWidths = {
  ticket: 110,
  workflow: 130,
  branch: 300,
  changes: 110,
  spent: 90,
  status: 88,
};

const MIN_WIDTH: Record<ColumnId, number> = {
  ticket: 60,
  workflow: 90,
  branch: 100,
  changes: 70,
  spent: 56,
  status: 76,
};

function readStored(): ColumnWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // stored data may carry widths for columns that no longer exist
    // (link/env/actions) — merge only the keys we still render
    const parsed = JSON.parse(raw) as Partial<Record<string, number>>;
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as ColumnId[]) {
      // clamp: a column's minimum may have grown since the width was stored
      if (typeof parsed[key] === 'number') merged[key] = Math.max(MIN_WIDTH[key], parsed[key]!);
    }
    return merged;
  } catch {
    return DEFAULTS;
  }
}

export function useColumnWidths() {
  const [widths, setWidths] = useState<ColumnWidths>(() => readStored());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // quota / disabled storage — ignore
    }
  }, [widths]);

  const dragRef = useRef<{ col: ColumnId; startX: number; startWidth: number } | null>(null);

  const startResize = useCallback((col: ColumnId, e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { col, startX: e.clientX, startWidth: widths[col] };
    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = ev.clientX - drag.startX;
      const min = MIN_WIDTH[drag.col];
      const next = Math.max(min, drag.startWidth + delta);
      setWidths((w) => (w[drag.col] === next ? w : { ...w, [drag.col]: next }));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [widths]);

  const gridTemplate = `${widths.ticket}px ${widths.spent}px ${widths.workflow}px minmax(${widths.branch}px, 1fr) ${widths.changes}px ${widths.status}px`;
  const totalWidth =
    widths.ticket + widths.workflow + widths.branch + widths.changes + widths.spent + widths.status;

  return { widths, gridTemplate, totalWidth, startResize };
}
