import { useLayoutEffect, useRef } from 'react';
import type React from 'react';
import { leafKeys, type PaneNode } from '../../hooks/paneLayout';
import { beginLayoutMotion } from '../../lib/layoutMotion';

/** How long a pane takes to grow open (a spring, settling with a small overshoot). */
export const PANE_MOTION_MS = 320;
/** Closing is quicker than opening: you're done with it. */
const PANE_CLOSE_MS = 130;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
// A stiff, well-damped spring (about 4% overshoot): quick out of the gate, a
// small bounce past the mark, settled well before the end. As macOS moves windows.
const SPRING = 'linear(0, 0.2 6%, 0.51 13%, 0.78 21%, 0.95 29%, 1.03 37%, 1.04 44%, 1.025 52%, 1.008 62%, 0.999 74%, 1)';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// The tiled pane tree: splits, with the resize handle in the gap between two
// cards (invisible until hovered). Leaves are drawn by the caller (a PaneCard);
// the live surfaces (xterm, iframes, browser views) are positioned over each
// leaf's body from a separate persistent layer.
export function PaneLayout({ node, addr = [], renderLeaf, onDividerPointerDown }: {
  node: PaneNode;
  addr?: number[];
  renderLeaf: (key: string) => React.ReactNode;
  onDividerPointerDown: (e: React.PointerEvent<HTMLDivElement>, addr: number[], dir: 'row' | 'col') => void;
}) {
  // A pane that was one leaf and is now split: the new side grows out of the
  // old one instead of appearing at full size.
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const prevLeaf = useRef<string | null>(node.kind === 'leaf' ? node.key : null);
  const prevShape = useRef(shapeOf(node));
  useLayoutEffect(() => {
    // A close left its pane shrunk shut (fill: forwards). The commit that
    // removes the pane drops that, before paint: these wrappers may now hold
    // a different pane, and undone a frame later the old one flashed back.
    const shape = shapeOf(node);
    if (shape !== prevShape.current) {
      prevShape.current = shape;
      for (const el of [firstRef.current, secondRef.current]) el?.getAnimations?.().forEach((a) => a.cancel());
    }
    const was = prevLeaf.current;
    prevLeaf.current = node.kind === 'leaf' ? node.key : null;
    const el = firstRef.current;
    if (!was || node.kind !== 'split' || !el || typeof el.animate !== 'function' || reducedMotion()) return;
    const inA = leafKeys(node.a).includes(was);
    if (!inA && !leafKeys(node.b).includes(was)) return;
    beginLayoutMotion(PANE_MOTION_MS);
    el.animate([{ flexBasis: inA ? '100%' : '0%' }, { flexBasis: `${node.ratio * 100}%` }], { duration: PANE_MOTION_MS, easing: SPRING });
  });
  if (node.kind === 'leaf') return <>{renderLeaf(node.key)}</>;
  const row = node.dir === 'row';
  const child = (n: PaneNode, i: number) => <PaneLayout node={n} addr={[...addr, i]} renderLeaf={renderLeaf} onDividerPointerDown={onDividerPointerDown} />;
  return (
    <div
      data-testid="pane-split"
      data-split-dir={node.dir}
      className={`flex h-full w-full min-h-0 min-w-0 ${row ? 'flex-row' : 'flex-col'}`}
    >
      <div ref={firstRef} data-pane-side="a" style={{ flexBasis: `${node.ratio * 100}%` }} className="min-h-0 min-w-0 shrink-0 grow-0 overflow-hidden">
        {child(node.a, 0)}
      </div>
      <div
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        aria-label="Resize panes"
        className={`group/sep flex shrink-0 items-center justify-center ${row ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'}`}
        onPointerDown={(e) => onDividerPointerDown(e, addr, node.dir)}
      >
        <div className={`rounded-full bg-transparent transition-colors group-hover/sep:bg-sky-500/60 ${row ? 'h-full max-h-24 w-0.5' : 'h-0.5 w-full max-w-24'}`} />
      </div>
      <div ref={secondRef} data-pane-side="b" className="min-h-0 min-w-0 flex-1 overflow-hidden">{child(node.b, 1)}</div>
    </div>
  );
}

// The tree's structure (which panes, how nested), not its ratios.
function shapeOf(node: PaneNode): string {
  return node.kind === 'leaf' ? node.key : `(${shapeOf(node.a)}${node.dir === 'row' ? '|' : '-'}${shapeOf(node.b)})`;
}

/** A pane about to close shrinks shut and its neighbour grows over the room.
 * `leaf` is the closing pane's element, `surface` its live terminal (drawn in
 * a layer above the card, so it fades too). Resolves with an undo (for a pane
 * that stayed after all) once done; null when it isn't in a split or can't animate. */
export function animatePaneOut(leaf: HTMLElement | null | undefined, surface?: HTMLElement | null): Promise<() => void> | null {
  const side = leaf?.closest<HTMLElement>('[data-pane-side]');
  const first = side?.dataset.paneSide === 'a' ? side : side?.parentElement?.querySelector<HTMLElement>(':scope > [data-pane-side="a"]');
  if (!side || !first || typeof first.animate !== 'function' || reducedMotion()) return null;
  beginLayoutMotion(PANE_CLOSE_MS);
  const a = first.animate(
    [{ flexBasis: getComputedStyle(first).flexBasis }, { flexBasis: side === first ? '0%' : '100%' }],
    { duration: PANE_CLOSE_MS, easing: EASE, fill: 'forwards' },
  );
  const fades = [side, surface].filter((el): el is HTMLElement => !!el).map((el) =>
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: PANE_CLOSE_MS, easing: EASE, fill: 'forwards' }));
  const undo = () => { a.cancel(); fades.forEach((f) => f.cancel()); };
  return a.finished.then(() => undo, () => undo);
}

/** Zoom: every split above the pane gives it the whole room — its side grows
 * to all of it, the other shrinks and fades (with the live surfaces drawn over
 * its cards) — then the caller swaps the tree for the pane alone. Resolves
 * with an undo for the fades, to run once that swap has committed; null when
 * it isn't in a split or can't animate. */
export function animatePaneZoom(leaf: HTMLElement | null | undefined): Promise<() => void> | null {
  if (!leaf || typeof leaf.animate !== 'function' || reducedMotion()) return null;
  const ms = PANE_CLOSE_MS + 40;
  const anims: Animation[] = [];
  const fade = (el: HTMLElement) => anims.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: EASE, fill: 'forwards' }));
  let el: HTMLElement | null = leaf;
  while (el) {
    const side: HTMLElement | null = el.closest<HTMLElement>('[data-pane-side]');
    const split: HTMLElement | null | undefined = side?.parentElement;
    const first = split?.querySelector<HTMLElement>(':scope > [data-pane-side="a"]');
    const other = split?.querySelector<HTMLElement>(`:scope > [data-pane-side="${side?.dataset.paneSide === 'a' ? 'b' : 'a'}"]`);
    if (!side || !split || !first) break;
    anims.push(first.animate(
      [{ flexBasis: getComputedStyle(first).flexBasis }, { flexBasis: side === first ? '100%' : '0%' }],
      { duration: ms, easing: EASE, fill: 'forwards' },
    ));
    if (other) {
      fade(other);
      for (const card of other.querySelectorAll<HTMLElement>('[data-pane-key]')) {
        for (const s of document.querySelectorAll<HTMLElement>(`[data-surface-key="${CSS.escape(card.dataset.paneKey ?? '')}"]`)) fade(s);
      }
    }
    el = split;
  }
  if (!anims.length) return null;
  beginLayoutMotion(ms);
  const undo = () => anims.forEach((a) => a.cancel());
  return Promise.all(anims.map((a) => a.finished)).then(() => undo, () => undo);
}
