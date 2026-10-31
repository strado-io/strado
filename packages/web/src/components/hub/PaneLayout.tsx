import { useLayoutEffect, useRef } from 'react';
import type React from 'react';
import { leafKeys, type PaneNode } from '../../hooks/paneLayout';
import { beginLayoutMotion } from '../../lib/layoutMotion';

/** How long a pane takes to grow open or shrink shut. */
export const PANE_MOTION_MS = 220;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

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
  const prevLeaf = useRef<string | null>(node.kind === 'leaf' ? node.key : null);
  useLayoutEffect(() => {
    const was = prevLeaf.current;
    prevLeaf.current = node.kind === 'leaf' ? node.key : null;
    const el = firstRef.current;
    if (!was || node.kind !== 'split' || !el || typeof el.animate !== 'function' || reducedMotion()) return;
    const inA = leafKeys(node.a).includes(was);
    if (!inA && !leafKeys(node.b).includes(was)) return;
    beginLayoutMotion(PANE_MOTION_MS);
    el.animate([{ flexBasis: inA ? '100%' : '0%' }, { flexBasis: `${node.ratio * 100}%` }], { duration: PANE_MOTION_MS, easing: EASE });
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
      <div data-pane-side="b" className="min-h-0 min-w-0 flex-1 overflow-hidden">{child(node.b, 1)}</div>
    </div>
  );
}

/** A pane about to close shrinks shut and its neighbour grows over the room.
 * `leaf` is the closing pane's element. Resolves with an undo (for a pane that
 * stayed after all) once done; null when it isn't in a split or can't animate. */
export function animatePaneOut(leaf: HTMLElement | null | undefined): Promise<() => void> | null {
  const side = leaf?.closest<HTMLElement>('[data-pane-side]');
  const first = side?.dataset.paneSide === 'a' ? side : side?.parentElement?.querySelector<HTMLElement>(':scope > [data-pane-side="a"]');
  if (!side || !first || typeof first.animate !== 'function' || reducedMotion()) return null;
  beginLayoutMotion(PANE_MOTION_MS);
  const a = first.animate(
    [{ flexBasis: getComputedStyle(first).flexBasis }, { flexBasis: side === first ? '0%' : '100%' }],
    { duration: PANE_MOTION_MS, easing: EASE, fill: 'forwards' },
  );
  const fade = side.animate([{ opacity: 1 }, { opacity: 0 }], { duration: PANE_MOTION_MS, easing: EASE, fill: 'forwards' });
  const undo = () => { a.cancel(); fade.cancel(); };
  return a.finished.then(() => undo, () => undo);
}
