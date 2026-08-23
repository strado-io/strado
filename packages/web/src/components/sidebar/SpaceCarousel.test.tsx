import { createRef } from 'react';
import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceCarousel, type SpaceCarouselHandle } from './SpaceCarousel';

const WIDTH = 300;

const panes = [
  { id: 'a', content: <div>pane A</div> },
  { id: 'b', content: <div>pane B</div> },
  { id: 'c', content: <div>pane C</div> },
];

// jsdom has no layout, so the viewport reports clientWidth 0 and the carousel
// has no pane width to work from. That measurement is the only thing faked —
// the offset maths, the release detection and the snap are the real code.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Fake the frame clock as well as the timers: real rAF gets starved when the
// whole suite runs in parallel, and a snap that lands late is a flaky test,
// not a bug.
function fakeFrames() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
}

/** Run the release timer and every frame of the snap to completion. */
function settle() {
  act(() => { vi.advanceTimersByTime(500); });
}

function setup(centerIndex = 1, onCommit = vi.fn()) {
  const ref = createRef<SpaceCarouselHandle>();
  const { rerender } = render(
    <SpaceCarousel ref={ref} panes={panes} centerIndex={centerIndex} onCommit={onCommit} />,
  );
  return {
    ref,
    onCommit,
    rerender,
    viewport: screen.getByTestId('space-carousel'),
    track: screen.getByTestId('carousel-track'),
  };
}

function drag(viewport: HTMLElement, ...deltas: number[]) {
  const events = deltas.map((deltaX) => {
    const e = new WheelEvent('wheel', { deltaX, deltaY: 0, bubbles: true, cancelable: true });
    act(() => { viewport.dispatchEvent(e); });
    return e;
  });
  return events;
}

/** Pixels the track is shifted left, i.e. the current scroll offset. */
function offsetOf(track: HTMLElement): number {
  const m = /translate3d\((-?[\d.]+)px/.exec(track.style.transform);
  return m ? -Number(m[1]) : 0;
}

describe('SpaceCarousel', () => {
  it('renders every pane', () => {
    setup();
    expect(screen.getByText('pane A')).toBeInTheDocument();
    expect(screen.getByText('pane B')).toBeInTheDocument();
    expect(screen.getByText('pane C')).toBeInTheDocument();
  });

  it('marks off-centre panes inert and hidden', () => {
    setup(1);
    const [a, b, c] = screen.getAllByTestId('carousel-pane') as HTMLElement[];
    expect(a).toHaveAttribute('aria-hidden', 'true');
    expect(b).not.toHaveAttribute('aria-hidden');
    expect(c).toHaveAttribute('aria-hidden', 'true');
    expect((a as HTMLElement & { inert: boolean }).inert).toBe(true);
    expect((b as HTMLElement & { inert: boolean }).inert).toBe(false);
  });

  it('seats the active pane at the centre', () => {
    const { track } = setup(1);
    expect(offsetOf(track)).toBe(WIDTH);
  });

  it('follows the fingers 1:1 while the drag is still going', () => {
    const { viewport, track } = setup(1);
    drag(viewport, 15, 15, 15); // steady deltas: the hand is still on the glass
    expect(offsetOf(track)).toBe(WIDTH + 45);
  });

  it('leaves vertical wheels to the pane under the pointer', () => {
    const { viewport, track } = setup(1);
    const e = new WheelEvent('wheel', { deltaX: 0, deltaY: 80, bubbles: true, cancelable: true });
    act(() => { viewport.dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(false);
    expect(offsetOf(track)).toBe(WIDTH);
  });

  it('commits on release once the drag is past the threshold', () => {
    fakeFrames();
    const { viewport, onCommit } = setup(1);
    drag(viewport, 60, 60, 50); // 170px > a quarter pane, then the fingers lift
    settle();
    expect(onCommit).toHaveBeenCalledWith('c');
  });

  it('springs back on a small drag, however gently released', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    drag(viewport, 12, 12, 10); // 34px — under a quarter pane, so it never switches
    settle();
    expect(offsetOf(track)).toBe(WIDTH);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not snap until the fingers lift — it keeps following', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    drag(viewport, 60, 60, 60); // steady, past the threshold: still on the glass
    // Well inside the release window: no idle fire, no snap — the track is
    // still sitting exactly where the fingers left it, previewing the neighbour.
    act(() => { vi.advanceTimersByTime(40); });
    expect(offsetOf(track)).toBe(WIDTH + 180);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps following while the fingers are still pushing', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    drag(viewport, 40, 40, 40); // past the threshold but not slowing: still theirs
    expect(offsetOf(track)).toBe(WIDTH + 120);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('a dip mid-swipe does not switch — the fingers are still pushing', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    // Push, ease off a touch, push again — all still on the glass. The brief
    // slowdown must NOT read as a lift the way two shrinking deltas once did.
    drag(viewport, 60, 50, 45, 60, 70);
    expect(onCommit).not.toHaveBeenCalled();
    expect(offsetOf(track)).toBeGreaterThan(WIDTH); // still following the drag
    settle(); // only now do the fingers actually lift (the stream goes quiet)
    expect(onCommit).toHaveBeenCalledWith('c');
  });

  it('a hard flick is held to a single neighbour, not flung across', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    drag(viewport, 900); // a violent flick — several panes' worth of delta at once
    expect(offsetOf(track)).toBeLessThan(3 * WIDTH); // nowhere near pane 3 (900px+)
    expect(offsetOf(track)).toBeGreaterThan(WIDTH); // but the one neighbour shows
    settle();
    expect(onCommit).toHaveBeenCalledWith('c'); // lands on the neighbour only
    expect(offsetOf(track)).toBe(2 * WIDTH);
  });

  it('with the native phase, holds a paused drag and commits only on lift', () => {
    fakeFrames();
    let phaseCb: ((p: string) => void) | undefined;
    (window as unknown as { strado?: unknown }).strado = {
      onScrollTouch: (cb: (p: string) => void) => { phaseCb = cb; return () => {}; },
    };
    try {
      const { viewport, track, onCommit } = setup(1);
      act(() => phaseCb!('begin')); // a real trackpad gesture → native mode
      drag(viewport, 40, 40); // 80px, well past the 0.2 threshold
      // The fingers stop but stay down — no wheel. It holds far past the
      // 140ms fallback window: the pause reads as held, not released.
      act(() => { vi.advanceTimersByTime(500); });
      expect(onCommit).not.toHaveBeenCalled();
      expect(offsetOf(track)).toBe(WIDTH + 80); // still parked under the fingers
      // A little more, then the fingers actually lift.
      drag(viewport, 20);
      act(() => phaseCb!('end'));
      settle();
      expect(onCommit).toHaveBeenCalledWith('c');
    } finally {
      delete (window as unknown as { strado?: unknown }).strado;
    }
  });

  it('commits at the lift, not after the momentum tail has run out', () => {
    // macOS never sends gestureFlingStart for a trackpad wheel, and its
    // gestureScrollEnd only arrives once the momentum stream finishes — about a
    // second after a flick. Waiting for it left the sidebar showing the space
    // it had slid to while the header and dots still named the old one.
    fakeFrames();
    let phaseCb: ((p: string) => void) | undefined;
    (window as unknown as { strado?: unknown }).strado = {
      onScrollTouch: (cb: (p: string) => void) => { phaseCb = cb; return () => {}; },
    };
    try {
      const { viewport, onCommit } = setup(1);
      act(() => phaseCb!('begin'));
      drag(viewport, 60, 60, 60); // fingers pushing: steady deltas
      expect(onCommit).not.toHaveBeenCalled();
      // Fingers lift. macOS keeps delivering momentum, and momentum only decays.
      drag(viewport, 40, 26, 17);
      settle();
      // Committed on the decay — no 'end' was ever delivered.
      expect(onCommit).toHaveBeenCalledWith('c');
    } finally {
      delete (window as unknown as { strado?: unknown }).strado;
    }
  });

  it('still holds a paused drag, which goes silent rather than decaying', () => {
    fakeFrames();
    let phaseCb: ((p: string) => void) | undefined;
    (window as unknown as { strado?: unknown }).strado = {
      onScrollTouch: (cb: (p: string) => void) => { phaseCb = cb; return () => {}; },
    };
    try {
      const { viewport, onCommit } = setup(1);
      act(() => phaseCb!('begin'));
      drag(viewport, 40, 45, 50); // never shrinking — the hand is still moving
      act(() => { vi.advanceTimersByTime(500); }); // then simply stops: a pause
      expect(onCommit).not.toHaveBeenCalled();
      act(() => phaseCb!('end'));
      settle();
      expect(onCommit).toHaveBeenCalledWith('c');
    } finally {
      delete (window as unknown as { strado?: unknown }).strado;
    }
  });

  it('a lost native end cannot park the track — a long silence settles it', () => {
    // Electron/macOS sometimes never delivers gestureScrollEnd (cancelled
    // gesture, focus change). Before the safety window this parked the track
    // between two panes forever, with the off-centre pane inert — the bug in
    // the 2026-08-19 screenshots. A silence past NATIVE_IDLE_MS must settle
    // and commit on its own, no 'end' ever arriving.
    fakeFrames();
    let phaseCb: ((p: string) => void) | undefined;
    (window as unknown as { strado?: unknown }).strado = {
      onScrollTouch: (cb: (p: string) => void) => { phaseCb = cb; return () => {}; },
    };
    try {
      const { viewport, track, onCommit } = setup(1);
      act(() => phaseCb!('begin'));
      drag(viewport, 60, 60, 60); // 180px, past the threshold — then nothing, ever
      act(() => { vi.advanceTimersByTime(2000); }); // safety window + snap
      expect(onCommit).toHaveBeenCalledWith('c');
      expect(offsetOf(track)).toBe(2 * WIDTH); // seated, not parked mid-swipe
    } finally {
      delete (window as unknown as { strado?: unknown }).strado;
    }
  });

  it('commits a long drag on release', () => {
    fakeFrames();
    const { viewport, onCommit } = setup(1);
    drag(viewport, 100, 100); // 200px of 300 — well past the threshold
    settle();
    expect(onCommit).toHaveBeenCalledWith('c');
  });

  it('springs back without committing when the drag falls short', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    drag(viewport, 8, 4, 2, 1); // 15px, and shrinking: released, and a twitch
    settle();
    expect(offsetOf(track)).toBe(WIDTH);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('springs back when a short drag simply stops', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    drag(viewport, 5, 6, 7); // 18px, still rising when the fingers stop moving
    settle();
    expect(offsetOf(track)).toBe(WIDTH);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit until the wheel goes quiet, then ignores the tail', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    drag(viewport, 120, 80, 40); // a hard swipe — nothing commits while it flows
    expect(onCommit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(140); }); // the wheel falls silent → release
    drag(viewport, 20, 10); // a late straggler, now swallowed mid-snap
    settle();
    expect(onCommit).toHaveBeenCalledWith('c');
    expect(offsetOf(track)).toBe(2 * WIDTH);
  });

  it('stays put when the parent commits mid-snap and a straggler arrives', () => {
    // The shake: the snap lands, the space changes, the component re-seats —
    // and a stray wheel event is still arriving. It must not move the track
    // again, and it must not commit a second space.
    fakeFrames();
    const onCommit = vi.fn();
    const { viewport, track, rerender } = setup(1, onCommit);
    drag(viewport, 120, 80, 40); // a decisive swipe past the threshold
    settle(); // the wheel goes quiet → snap → lands → commit 'c'
    expect(onCommit).toHaveBeenCalledWith('c');
    // The parent does what the contract says and moves the centre.
    rerender(<SpaceCarousel panes={panes} centerIndex={2} onCommit={onCommit} />);
    drag(viewport, 6); // one last straggler after the re-seat
    settle();
    expect(offsetOf(track)).toBe(2 * WIDTH);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('takes a fresh swipe once the wheel has gone quiet', () => {
    fakeFrames();
    const { viewport, track, onCommit } = setup(0);
    drag(viewport, 90);
    settle(); // snap done, quiet timer expired inside the same advance
    expect(onCommit).toHaveBeenCalledWith('b');
    expect(offsetOf(track)).toBe(WIDTH);
    drag(viewport, 90); // a genuinely new gesture is heard again
    expect(offsetOf(track)).toBeGreaterThan(WIDTH);
    // Everything from the first `settle()` on runs with the commit still
    // unhonoured — the parent never re-rendered — so this swipe lands back on
    // the pane already asked for. Asking twice is a second workspace switch
    // for a space the user is already going to.
    settle();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('goes back to the live space when the parent never honours the commit', () => {
    // A switch that rejects (server restarting, a 500) leaves the parent's
    // centreIndex where it was — and the pane on screen is then the inert,
    // aria-hidden one, with every control in it dead and nothing said. The
    // track cannot enforce the contract, so it gives up on it instead.
    fakeFrames();
    const { viewport, track, onCommit } = setup(1);
    drag(viewport, 90);
    settle();
    expect(onCommit).toHaveBeenCalledWith('c');
    expect(offsetOf(track)).toBe(2 * WIDTH); // parked on the neighbour
    act(() => { vi.advanceTimersByTime(15_200); });
    expect(offsetOf(track)).toBe(WIDTH); // back on the space that is actually live
  });

  it('stays where the parent put it once the commit is honoured', () => {
    fakeFrames();
    const onCommit = vi.fn();
    const { viewport, track, rerender } = setup(1, onCommit);
    drag(viewport, 90);
    settle();
    rerender(<SpaceCarousel panes={panes} centerIndex={2} onCommit={onCommit} />);
    act(() => { vi.advanceTimersByTime(15_200); }); // the give-up timer must be off
    expect(offsetOf(track)).toBe(2 * WIDTH);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('a second chord before the switch lands moves on rather than re-committing', () => {
    // Cmd+Shift+→ twice: the first commit is still in flight (two HTTP round
    // trips), so counting from the parent's stale centre would re-commit the
    // space just asked for and leave the user one space short.
    fakeFrames();
    const { ref, track, onCommit } = setup(0);
    act(() => ref.current!.goTo(1));
    settle();
    expect(onCommit).toHaveBeenNthCalledWith(1, 'b');
    act(() => ref.current!.goTo(1)); // parent has not re-rendered yet
    settle();
    expect(onCommit).toHaveBeenNthCalledWith(2, 'c');
    expect(offsetOf(track)).toBe(2 * WIDTH);
  });

  it('reseat() puts the track back on the live space', () => {
    fakeFrames();
    const { ref, track, onCommit } = setup(1);
    act(() => ref.current!.goTo(1));
    settle();
    expect(onCommit).toHaveBeenCalledWith('c');
    act(() => ref.current!.reseat());
    expect(offsetOf(track)).toBe(WIDTH);
  });

  it('resists past the last pane instead of running off the end', () => {
    const { viewport, track } = setup(2);
    drag(viewport, 100, 100, 100);
    const past = offsetOf(track) - 2 * WIDTH;
    // It gives, but only a little, and each further push gives less than the
    // last — 300px of drag past the end must not read as 300px of travel.
    expect(past).toBeGreaterThan(0);
    expect(past).toBeLessThan(300 * 0.35);
  });

  it('goTo animates to the neighbour and commits on arrival', () => {
    fakeFrames();
    const { ref, track, onCommit } = setup(1);
    act(() => ref.current!.goTo(1));
    expect(offsetOf(track)).toBe(WIDTH); // still where it started: it animates
    settle();
    expect(onCommit).toHaveBeenCalledWith('c');
    expect(offsetOf(track)).toBe(2 * WIDTH);
  });

  it('goTo does nothing past the last pane', () => {
    const { ref, track, onCommit } = setup(2);
    act(() => ref.current!.goTo(1));
    expect(offsetOf(track)).toBe(2 * WIDTH);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('ignores a second goTo while the first is still animating', () => {
    fakeFrames();
    const { ref, onCommit } = setup(0);
    act(() => ref.current!.goTo(1));
    act(() => { vi.advanceTimersByTime(30); }); // mid-flight
    act(() => ref.current!.goTo(1));
    settle();
    expect(onCommit).toHaveBeenCalledWith('b');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('re-seats instantly when the centre pane changes', () => {
    const { track, rerender } = setup(1);
    const onCommit = vi.fn();
    rerender(<SpaceCarousel panes={panes} centerIndex={2} onCommit={onCommit} />);
    expect(offsetOf(track)).toBe(2 * WIDTH);
  });
});
