/**
 * Where a dragged row lands. Kept apart from the drag itself because this is
 * where an off-by-one hides, and it needs no DOM to prove.
 */

/** The list with `id` moved to `toIndex`, clamped to the ends. */
export function moveId(ids: string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return [...ids];
  const to = Math.min(ids.length - 1, Math.max(0, toIndex));
  if (to === from) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * The index the pointer is currently over: the first row whose midline it has
 * not yet passed, or the last row once it is below them all.
 */
export function targetIndex(pointerY: number, rects: { top: number; height: number }[]): number {
  if (rects.length === 0) return 0;
  const i = rects.findIndex((r) => pointerY < r.top + r.height / 2);
  return i === -1 ? rects.length - 1 : i;
}
