// Floating panes: a tab lifted out of the tiled layout into a card over it.
// Each sits at a box given as fractions of the hub's pane area, so it keeps
// its place when the window resizes. Remembered per worktree, like layouts.

export type PaneFloat = { key: string; x: number; y: number; w: number; h: number };

const STORAGE_KEY = 'strado:pane-floats';
/** Smallest a floating pane may be, in px. */
export const FLOAT_MIN = { w: 280, h: 160 };

export function readPaneFloats(): Record<string, PaneFloat[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, PaneFloat[]> = {};
    for (const [path, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const floats = list.filter((f): f is PaneFloat =>
        !!f && typeof f.key === 'string' && [f.x, f.y, f.w, f.h].every((n) => typeof n === 'number' && Number.isFinite(n)));
      if (floats.length) out[path] = floats.map(clampFloat);
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberPaneFloats(path: string, floats: PaneFloat[]): void {
  try {
    const all = readPaneFloats();
    if (floats.length) all[path] = floats;
    else delete all[path];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch { /* storage full or blocked: floats last this session only */ }
}

/** Kept inside the area, at least a little of it on screen. */
export function clampFloat(f: PaneFloat): PaneFloat {
  const w = Math.min(Math.max(f.w, 0.15), 1);
  const h = Math.min(Math.max(f.h, 0.15), 1);
  return { ...f, w, h, x: Math.min(Math.max(f.x, 0), 1 - w), y: Math.min(Math.max(f.y, 0), 1 - h) };
}

/** Where a newly floated pane goes: the right half, inset, nudged down for each one already floating. */
export function nextFloatBox(key: string, existing: PaneFloat[]): PaneFloat {
  const step = existing.length * 0.04;
  return clampFloat({ key, x: 0.42 + step, y: 0.12 + step, w: 0.52, h: 0.62 });
}
