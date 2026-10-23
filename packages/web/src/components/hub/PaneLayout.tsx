import type React from 'react';
import type { PaneNode } from '../../hooks/paneLayout';

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
  if (node.kind === 'leaf') return <>{renderLeaf(node.key)}</>;
  const row = node.dir === 'row';
  const child = (n: PaneNode, i: number) => <PaneLayout node={n} addr={[...addr, i]} renderLeaf={renderLeaf} onDividerPointerDown={onDividerPointerDown} />;
  return (
    <div
      data-testid="pane-split"
      data-split-dir={node.dir}
      className={`flex h-full w-full min-h-0 min-w-0 ${row ? 'flex-row' : 'flex-col'}`}
    >
      <div style={{ flexBasis: `${node.ratio * 100}%` }} className="min-h-0 min-w-0 shrink-0 grow-0 overflow-hidden">
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
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{child(node.b, 1)}</div>
    </div>
  );
}
