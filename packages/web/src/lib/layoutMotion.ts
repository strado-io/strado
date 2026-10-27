// A layout animation the whole app knows about (the sidebar's slide). While
// one runs, terminals hold their size and fit once when it settles: a resize
// per frame would SIGWINCH the program ~20 times in a quarter second, and a
// full-screen TUI (Claude, Codex, pi) redraws its whole screen on each.

let until = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const settledListeners = new Set<() => void>();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const startListeners = new Set<(dx: number) => void>();

/**
 * A layout animation starts now and lasts `ms`; overlapping ones extend it.
 * `dx` is how much wider the main area ends up (negative: narrower), so a
 * terminal can take its final size up front instead of being clipped.
 */
export function beginLayoutMotion(ms: number, dx = 0): void {
  for (const cb of [...startListeners]) cb(dx);
  until = Math.max(until, now() + ms);
  if (timer) clearTimeout(timer);
  timer = setTimeout(settle, Math.max(0, until - now()));
}

function settle(): void {
  until = 0;
  timer = undefined;
  for (const cb of [...settledListeners]) cb();
}

/** True while a declared layout animation is running. */
export const isLayoutMoving = (): boolean => now() < until;

/** Called once each time the layout settles; returns the unsubscribe. */
export function onLayoutSettled(cb: () => void): () => void {
  settledListeners.add(cb);
  return () => { settledListeners.delete(cb); };
}

/** Called as each layout animation starts, with its dx; returns the unsubscribe. */
export function onLayoutMotionStart(cb: (dx: number) => void): () => void {
  startListeners.add(cb);
  return () => { startListeners.delete(cb); };
}
