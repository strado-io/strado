// Split-pane layouts for the hub's terminal area: each worktree can own
// multiple binary trees whose leaves are dockable tab keys (`mode:id`).
// Client-side only, like tab order — persisted so splits survive reload.

export type PaneNode =
  | { kind: 'leaf'; key: string }
  | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode };

export type PaneDockSide = 'left' | 'right' | 'top' | 'bottom';

const STORE = 'strado.paneLayout';

export function leafKeys(node: PaneNode): string[] {
  if (node.kind === 'leaf') return [node.key];
  return [...leafKeys(node.a), ...leafKeys(node.b)];
}

export function hasLeaf(node: PaneNode, key: string): boolean {
  return leafKeys(node).includes(key);
}

/** replace the target leaf with a split of [target, newKey] */
export function splitLeaf(node: PaneNode, targetKey: string, newKey: string, dir: 'row' | 'col'): PaneNode {
  if (node.kind === 'leaf') {
    if (node.key !== targetKey) return node;
    return { kind: 'split', dir, ratio: 0.5, a: node, b: { kind: 'leaf', key: newKey } };
  }
  return { ...node, a: splitLeaf(node.a, targetKey, newKey, dir), b: splitLeaf(node.b, targetKey, newKey, dir) };
}

/**
 * Move an existing tab (or add a normal tab) beside a target pane.
 *
 * Removing the dragged leaf first makes this useful for rearranging an
 * existing tiled layout as well as adding a tab from the strip. The target is
 * identified by key rather than tree address because collapsing the dragged
 * leaf can change every address below its old parent.
 */
export function dockLeaf(
  node: PaneNode,
  draggedKey: string,
  targetKey: string,
  side: PaneDockSide,
): PaneNode {
  if (draggedKey === targetKey) return node;
  const withoutDragged = removeLeaf(node, draggedKey);
  if (!withoutDragged || !hasLeaf(withoutDragged, targetKey)) return node;
  const dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';

  const insert = (current: PaneNode): PaneNode => {
    if (current.kind === 'leaf') {
      if (current.key !== targetKey) return current;
      const dragged: PaneNode = { kind: 'leaf', key: draggedKey };
      return {
        kind: 'split',
        dir,
        ratio: 0.5,
        a: before ? dragged : current,
        b: before ? current : dragged,
      };
    }
    return { ...current, a: insert(current.a), b: insert(current.b) };
  };

  return insert(withoutDragged);
}

/** swap one leaf's key for another (re-target a pane) */
export function replaceLeaf(node: PaneNode, fromKey: string, toKey: string): PaneNode {
  if (node.kind === 'leaf') return node.key === fromKey ? { kind: 'leaf', key: toKey } : node;
  return { ...node, a: replaceLeaf(node.a, fromKey, toKey), b: replaceLeaf(node.b, fromKey, toKey) };
}

/** remove a leaf; its sibling takes the parent's place. null = tree gone. */
export function removeLeaf(node: PaneNode, key: string): PaneNode | null {
  if (node.kind === 'leaf') return node.key === key ? null : node;
  const a = removeLeaf(node.a, key);
  const b = removeLeaf(node.b, key);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/** drop leaves whose sessions no longer exist; null when <2 leaves remain useful */
export function pruneLeaves(node: PaneNode, valid: Set<string>): PaneNode | null {
  if (node.kind === 'leaf') return valid.has(node.key) ? node : null;
  const a = pruneLeaves(node.a, valid);
  const b = pruneLeaves(node.b, valid);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/** set the ratio of the split at an address path (0=a, 1=b per level) */
export function withRatio(node: PaneNode, addr: number[], ratio: number): PaneNode {
  if (node.kind === 'leaf') return node;
  if (addr.length === 0) return { ...node, ratio };
  const [head, ...rest] = addr;
  return head === 0
    ? { ...node, a: withRatio(node.a, rest, ratio) }
    : { ...node, b: withRatio(node.b, rest, ratio) };
}

function sane(node: unknown): node is PaneNode {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as PaneNode;
  if (n.kind === 'leaf') return typeof n.key === 'string' && n.key.length > 0;
  if (n.kind === 'split') {
    return (
      (n.dir === 'row' || n.dir === 'col') &&
      typeof n.ratio === 'number' && n.ratio > 0 && n.ratio < 1 &&
      sane(n.a) && sane(n.b)
    );
  }
  return false;
}

export function readPaneLayouts(): Record<string, PaneNode[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, unknown>;
    const out: Record<string, PaneNode[]> = {};
    for (const [path, value] of Object.entries(raw)) {
      // Backwards compatibility: versions before multi-group support stored
      // one PaneNode directly at each worktree path.
      const nodes = Array.isArray(value) ? value.filter(sane) : sane(value) ? [value] : [];
      const splits = nodes.filter((node) => node.kind === 'split');
      if (splits.length > 0) out[path] = splits;
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberPaneLayouts(path: string, nodes: PaneNode[]): void {
  try {
    const all = readPaneLayouts();
    const splits = nodes.filter((node) => node.kind === 'split');
    if (splits.length > 0) all[path] = splits;
    else delete all[path]; // single panes need no persisted group
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch { /* storage full/blocked — splits just won't persist */ }
}
