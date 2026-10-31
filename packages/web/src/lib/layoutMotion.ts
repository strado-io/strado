// Layout changes the whole app knows about. A jump (the sidebar toggling, in
// one frame like Warp's) lets terminals fit in that same frame and tell the
// pty at once. A motion (an animated layout change) makes them hold their
// size and fit once when it settles: a resize per frame would SIGWINCH the
// program ~20 times, and a full-screen TUI (Claude, Codex, pi) redraws its
// whole screen on each.

let until = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const settledListeners = new Set<() => void>();
const startListeners = new Set<() => void>();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A layout animation starts now and lasts `ms`; overlapping ones extend it. */
export function beginLayoutMotion(ms: number): void {
  const starting = !isLayoutMoving();
  until = Math.max(until, now() + ms);
  if (timer) clearTimeout(timer);
  timer = setTimeout(settle, Math.max(0, until - now()));
  if (starting) for (const cb of [...startListeners]) cb();
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

/** Called each time a layout motion starts (not when one is extended); returns the unsubscribe. */
export function onLayoutMotion(cb: () => void): () => void {
  startListeners.add(cb);
  return () => { startListeners.delete(cb); };
}

let jumpAt = -Infinity;

/** The layout changes in one step now (the sidebar toggling). */
export function markLayoutJump(): void { jumpAt = now(); }

/** True right after a layout jump: resizes now are the jump's, not a drag's. */
export const isLayoutJump = (): boolean => now() - jumpAt < 150;

// Native views (the Browser preview, docked DevTools) paint above the page:
// they can't fade, scale or slide with their card. While a card animates or
// is dragged they're held: parked, a snapshot standing in where it moves.
let holds = 0;
const holdListeners = new Set<(held: boolean) => void>();

/** Hold native views until the returned release is called (once; extra calls do nothing). */
export function holdNativeViews(): () => void {
  if (holds++ === 0) for (const cb of [...holdListeners]) cb(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) for (const cb of [...holdListeners]) cb(false);
  };
}

export const isNativeHeld = (): boolean => holds > 0;

/** Called with true when a hold starts, false when the last one ends; returns the unsubscribe. */
export function onNativeHold(cb: (held: boolean) => void): () => void {
  holdListeners.add(cb);
  return () => { holdListeners.delete(cb); };
}
