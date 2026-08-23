import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export type CarouselPane = { id: string; content: ReactNode };
export type SpaceCarouselHandle = {
  goTo: (dir: -1 | 1) => void;
  /** Put the track back on the live space — for a commit the parent refused. */
  reseat: () => void;
};

type Props = {
  panes: CarouselPane[];
  /** Index of the pane that is the live, active space. */
  centerIndex: number;
  /**
   * Called when a gesture (or goTo) lands on another pane. Contract: the
   * parent is expected to advance `centerIndex` — or otherwise change which
   * pane's `id` sits at `centerIndex` — on its next render, which is what
   * re-seats this component on the new space. A parent that doesn't (a failed
   * switch, an ignored callback) gets `HONOUR_MS` before the track goes back
   * to the live space by itself.
   */
  onCommit: (id: string) => void;
};

// The feel. Dragging is 1:1 with the fingers the whole way; the switch is not
// decided until the fingers lift (the wheel stream goes silent), and every
// constant here governs that release and the snap that follows it.
const SNAP_MS = 220; // the settle after release — unhurried, so it reads as a glide
const RELEASE_RATIO = 0.2; // dragged this far when the fingers lift → change
const COMMIT_MIN_PX = 20; // …but never on a stray nudge while scrolling
// FALLBACK release signal, used only until a real trackpad phase event has been
// seen (non-macOS, a browser, an older shell). A wheel stream carries no
// "fingers lifted" event and momentum keeps it alive after the hand is gone, so
// with nothing better we treat a gap this long with no wheel as the release.
// On macOS the native 'scroll-touch-end' replaces this and fires on the ACTUAL
// lift, so a paused-but-held drag holds instead of guessing.
const RELEASE_IDLE_MS = 140;
// Even with the native phase, the lift event cannot be trusted to arrive:
// Electron/macOS drops gestureScrollEnd outright in places (a cancelled
// gesture, a focus change mid-swipe -- the same family of quirks that keeps
// gestureFlingStart from ever firing for a trackpad wheel). A dropped 'end'
// used to park the track between two panes FOREVER, with the off-centre pane
// inert -- a dead sidebar. So native mode holds a paused drag only this long;
// a silence past it settles on whatever the drag reached. Long enough that a
// deliberate pause-and-look still reads as held, short enough that a lost
// lift never reads as a hang.
const NATIVE_IDLE_MS = 800;
// The lift, as the wheel stream itself reveals it: macOS keeps delivering the
// fling as wheel events after the hand is gone, and momentum only ever shrinks.
// A pause with the fingers still down goes SILENT instead, never shrinking — so
// this many decreasing deltas in a row means the hand has left, and it is the
// only lift signal that arrives BEFORE gestureScrollEnd, which macOS withholds
// until the whole momentum tail has run out (about a second after a flick).
const DECAY_SAMPLES = 3;
const QUIET_MS = 90; // the fling is over once no wheel has arrived for this long
const RUBBER = 0.35; // resistance past the first and last pane, and past a neighbour
// How long a commit has to be honoured before the track gives up on it. This
// is deliberately far past any plausible switch — the boot window can hold a
// request open for ~20s (see the comment by the RunnersPanel mount in
// WorkspacesPage.tsx) — because the real failure path is handled elsewhere:
// Sidebar's commitSpace catches an actual rejection and re-seats immediately.
// This timer only exists so a parent that silently never honours the commit
// (a bug, not a rejection) cannot leave the user parked on an inert pane
// forever.
const HONOUR_MS = 15_000;

// Fast out of the gate, easing into place — the opposite of the browser's
// even glide, which is what made the old snap feel slow.
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Horizontal pane track, one pane per space, driven by hand rather than by
 * CSS scroll-snap. The track follows the fingers 1:1 for the whole gesture —
 * the neighbouring space previews under the drag — and the space is NOT changed
 * until the fingers lift. A trackpad sends no lift event (the wheel stream runs
 * on as momentum after the hand is gone), so the lift is read the only
 * unambiguous way: the stream falling silent. On that release the track snaps
 * to whichever pane the drag had reached and only then commits the switch.
 */
export const SpaceCarousel = forwardRef<SpaceCarouselHandle, Props>(function SpaceCarousel(
  { panes, centerIndex, onCommit },
  ref,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  // Pixels from the first pane's left edge. Kept in a ref and written
  // straight to the transform: a gesture must never wait on React.
  const offset = useRef(0);
  const animating = useRef(false);
  const animTarget = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const idle = useRef<number | null>(null);
  // True once a real trackpad phase event (strado.onScrollTouch) has been seen.
  // From then on the lift is read from that native 'end', not the wheel-idle
  // fallback — so a paused, still-held drag holds instead of settling.
  const sawNative = useRef(false);
  // Consecutive shrinking |deltaX| — see DECAY_SAMPLES.
  const decay = useRef(0);
  const lastAbs = useRef(0);
  // A gesture ends when the wheel stream goes quiet, which is long after the
  // snap has landed and the space has changed. Everything in between belongs
  // to a swipe that is already spoken for.
  const swallowing = useRef(false);
  const quiet = useRef<number | null>(null);
  // The pane this component has asked the parent to make active, from the
  // commit until the parent honours it (or the honour timer gives up). While
  // it is set the track is already sitting on that pane, so a second chord
  // counts from there and a second landing on it must not commit again.
  const committed = useRef<number | null>(null);
  const honour = useRef<number | null>(null);
  const centerId = panes[centerIndex]?.id;
  // For listeners bound once at mount (resize), which must not close over a
  // stale centre.
  const centerIndexRef = useRef(centerIndex);
  centerIndexRef.current = centerIndex;

  const paneWidth = () => viewport.current?.clientWidth ?? 0;
  const draw = () => {
    if (track.current) track.current.style.transform = `translate3d(${-offset.current}px, 0, 0)`;
  };
  const stopAnim = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    animating.current = false;
    animTarget.current = null;
  };
  const clearIdle = () => {
    if (idle.current !== null) clearTimeout(idle.current);
    idle.current = null;
  };
  const clearHonour = () => {
    if (honour.current !== null) clearTimeout(honour.current);
    honour.current = null;
  };
  // Put the track back on the pane the parent says is live, dropping whatever
  // this component thought was about to happen.
  const seatOnCentre = () => {
    committed.current = null;
    clearHonour();
    stopAnim();
    clearIdle();
    offset.current = centerIndexRef.current * paneWidth();
    draw();
  };
  // Deafen the track to the rest of this fling, and stay deaf until the wheel
  // events actually stop arriving.
  const swallowRest = () => {
    swallowing.current = true;
    if (quiet.current !== null) clearTimeout(quiet.current);
    quiet.current = window.setTimeout(() => {
      swallowing.current = false;
      quiet.current = null;
    }, QUIET_MS);
  };

  // Seat on the active pane at mount, and again whenever the parent moves the
  // centre. Instant, never animated: the gesture already moved these pixels.
  useLayoutEffect(() => {
    const seat = centerIndex * paneWidth();
    // Whatever the parent moved to, it has answered: nothing is outstanding.
    committed.current = null;
    clearHonour();
    // The commit that moved the centre came from a snap that is still
    // playing, and it is already heading for exactly this seat — cutting it
    // off here is what made the sidebar jump mid-swipe.
    if (animating.current && animTarget.current === seat) return;
    stopAnim();
    clearIdle();
    offset.current = seat;
    draw();
  }, [centerId, centerIndex]);

  // Ask the parent for the pane the track has arrived on. Once per pane: the
  // tail of a fling, a second chord, or a spring-back onto a pane already
  // asked for must not send the same switch twice.
  const commit = (index: number) => {
    const id = panes[index]?.id;
    if (index === centerIndex) {
      // Landed back on the live pane — a spring-back, or a chord that undid an
      // unhonoured one. Nothing is outstanding any more.
      committed.current = null;
      clearHonour();
      return;
    }
    if (!id || committed.current === index) return;
    committed.current = index;
    onCommit(id);
    // The parent may never honour it. A pane that isn't `centerIndex` is inert
    // and aria-hidden, so being parked on one is a sidebar with every control
    // dead and nothing said — worse than not having moved at all.
    clearHonour();
    honour.current = window.setTimeout(() => {
      honour.current = null;
      if (committed.current !== null) seatOnCentre();
    }, HONOUR_MS);
  };

  const animateTo = (index: number) => {
    const to = index * paneWidth();
    const from = offset.current;
    const land = () => commit(index);
    if (from === to) {
      land();
      return;
    }
    animating.current = true;
    animTarget.current = to;
    // Timed off the frame clock the callbacks arrive on, never a second clock.
    let start: number | null = null;
    const step = (now: number) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / SNAP_MS);
      offset.current = from + (to - from) * easeOut(t);
      draw();
      if (t < 1) {
        frame.current = requestAnimationFrame(step);
        return;
      }
      frame.current = null;
      animating.current = false;
      land();
    };
    frame.current = requestAnimationFrame(step);
  };

  // The fingers have lifted: snap to the pane the drag reached and, on landing,
  // commit it. The rest of the fling is dead to us from here — it arrives for a
  // good while after the snap has started, and letting it back in is what made
  // the sidebar judder.
  const settleOn = (dir: -1 | 0 | 1) => {
    clearIdle();
    decay.current = 0;
    lastAbs.current = 0;
    swallowRest();
    animateTo(Math.min(panes.length - 1, Math.max(0, centerIndex + dir)));
  };

  /** Which pane the drag has reached, i.e. where a release now would land. */
  const draggedTo = (): -1 | 0 | 1 => {
    const w = paneWidth();
    if (!w) return 0;
    const moved = offset.current - centerIndex * w;
    // A quarter of a pane is a deliberate swipe; below it a release springs
    // back so a small nudge (or a sideways twitch during a vertical scroll)
    // never changes the space.
    const enough = Math.max(w * RELEASE_RATIO, COMMIT_MIN_PX);
    return moved > enough ? 1 : moved < -enough ? -1 : 0;
  };

  const handleWheel = (e: WheelEvent) => {
    // A vertical scroll belongs to the pane under the pointer.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    // Ours either way — this also stops the macOS back-swipe.
    e.preventDefault();
    // The gesture has already ended and a snap is playing; hold the door shut
    // until the momentum tail stops arriving, or it starts a second swipe.
    if (swallowing.current || animating.current) {
      swallowRest();
      return;
    }
    const w = paneWidth();
    if (!w) return;
    // Follow the fingers 1:1, but never past a single neighbour: a hard flick
    // otherwise flings the track clean across several spaces before it settles.
    // Held to the pane on either side (with rubber past it), the drag only ever
    // previews the space you're swiping to, and momentum can't run away with it.
    const lo = Math.max(0, (centerIndex - 1) * w);
    const hi = Math.min((panes.length - 1) * w, (centerIndex + 1) * w);
    const raw = offset.current + e.deltaX;
    offset.current = raw < lo ? lo + (raw - lo) * RUBBER : raw > hi ? hi + (raw - hi) * RUBBER : raw;
    draw();
    // Never decide the switch mid-gesture — just follow and preview. On macOS
    // the native 'end' commits it on the real finger-lift, and the momentum
    // decay below catches the lift the stream itself reveals before that.
    const abs = Math.abs(e.deltaX);
    decay.current = abs < lastAbs.current ? decay.current + 1 : 0;
    lastAbs.current = abs;
    if (decay.current >= DECAY_SAMPLES) {
      settleOn(draggedTo());
      return;
    }
    // Fallback timers, tiered by how much the silence means: without the
    // native phase, quiet IS the lift (140ms); with it, quiet is normally a
    // held pause -- but past NATIVE_IDLE_MS it means the 'end' was lost, and
    // settling beats a track parked between panes with its controls dead.
    clearIdle();
    idle.current = window.setTimeout(
      () => settleOn(draggedTo()),
      sawNative.current ? NATIVE_IDLE_MS : RELEASE_IDLE_MS,
    );
  };

  // The trackpad's own gesture phase (macOS), the only thing that can tell a
  // paused-but-held drag from a released one. 'end' is the finger-lift.
  const handleScrollTouch = (phase: string) => {
    sawNative.current = true;
    if (phase === 'begin') {
      // A fresh gesture: cancel any fallback timer armed by the first wheel and
      // stop swallowing a previous fling's tail, so this drag is heard at once.
      clearIdle();
      decay.current = 0;
      lastAbs.current = 0;
      swallowing.current = false;
      if (quiet.current !== null) { clearTimeout(quiet.current); quiet.current = null; }
    } else if (phase === 'end') {
      // Fingers lifted — snap to where the drag reached and commit. A pure
      // vertical scroll leaves the offset at centre, so this is a no-op there.
      clearIdle();
      if (!animating.current) settleOn(draggedTo());
    }
  };

  // Bound once, reading the current render's handlers through refs: rebinding
  // per render would cancel an in-flight snap on every parent update.
  const latest = useRef(handleWheel);
  latest.current = handleWheel;
  const latestScroll = useRef(handleScrollTouch);
  latestScroll.current = handleScrollTouch;
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => latest.current(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // Subscribe to the native trackpad phase, if this shell exposes it.
  useEffect(() => {
    const bridge = (window as unknown as { strado?: { onScrollTouch?: (cb: (phase: string) => void) => () => void } }).strado;
    if (!bridge?.onScrollTouch) return;
    return bridge.onScrollTouch((phase) => latestScroll.current(phase));
  }, []);
  useEffect(() => () => {
    clearIdle();
    stopAnim();
    clearHonour();
    if (quiet.current !== null) clearTimeout(quiet.current);
  }, []);

  // The offset is in pixels, so the sidebar's resize handle would leave the
  // panes half-aligned. Re-seat on every width change.
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === last) return;
      last = w;
      if (animating.current) return; // the snap will land on the new width anyway
      offset.current = centerIndexRef.current * w;
      draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      goTo: (dir) => {
        if (animating.current) return;
        // Count from the pane already asked for, if the parent has not caught
        // up yet: a second chord means "one more from where I am now", and
        // counting from the stale centre re-committed the space just left.
        const target = (committed.current ?? centerIndex) + dir;
        if (target < 0 || target >= panes.length) return;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
        if (reduced) {
          offset.current = target * paneWidth();
          draw();
          commit(target);
          return;
        }
        clearIdle();
        animateTo(target);
      },
      reseat: seatOnCentre,
    }),
    [centerIndex, panes, onCommit],
  );

  return (
    <div
      ref={viewport}
      data-testid="space-carousel"
      className="relative min-h-0 flex-1 overflow-hidden"
    >
      <div
        ref={track}
        data-testid="carousel-track"
        className="flex h-full will-change-transform"
        style={{ width: `${panes.length * 100}%` }}
      >
        {panes.map((p, i) => (
          <Pane key={p.id} inert={i !== centerIndex} width={`${100 / panes.length}%`}>
            {p.content}
          </Pane>
        ))}
      </div>
    </div>
  );
});

function Pane({ inert, width, children }: { inert: boolean; width: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // React 18 has no `inert` prop, so set the DOM property: an off-screen pane
  // must take no clicks and no tab stops. useLayoutEffect (not useEffect) so
  // this lands pre-paint, in the same pass as the track's own move —
  // otherwise a pane stays tabbable for a frame after it slides away.
  useLayoutEffect(() => {
    if (ref.current) (ref.current as HTMLDivElement & { inert: boolean }).inert = inert;
  }, [inert]);
  return (
    <div
      ref={ref}
      data-testid="carousel-pane"
      aria-hidden={inert || undefined}
      style={{ width }}
      className="flex h-full shrink-0 flex-col overflow-y-auto"
    >
      {children}
    </div>
  );
}
