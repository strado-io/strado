import { beforeEach, describe, expect, it } from 'vitest';
import { dockLeaf, leafKeys, readPaneLayouts, rememberPaneLayouts, type PaneNode } from './paneLayout';

beforeEach(() => localStorage.clear());

describe('dockLeaf', () => {
  const pair: PaneNode = {
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { kind: 'leaf', key: 'shell:1' },
    b: { kind: 'leaf', key: 'shell:2' },
  };

  it('adds a normal tab on the requested side of a pane', () => {
    expect(dockLeaf(pair, 'codex:1', 'shell:1', 'top')).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: {
        kind: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { kind: 'leaf', key: 'codex:1' },
        b: { kind: 'leaf', key: 'shell:1' },
      },
      b: { kind: 'leaf', key: 'shell:2' },
    });
  });

  it('moves an existing pane without duplicating its tab', () => {
    const moved = dockLeaf(pair, 'shell:1', 'shell:2', 'bottom');
    expect(moved).toEqual({
      kind: 'split',
      dir: 'col',
      ratio: 0.5,
      a: { kind: 'leaf', key: 'shell:2' },
      b: { kind: 'leaf', key: 'shell:1' },
    });
    expect(leafKeys(moved)).toEqual(['shell:2', 'shell:1']);
  });

  it('does nothing when a pane is dropped onto itself', () => {
    expect(dockLeaf(pair, 'shell:1', 'shell:1', 'right')).toBe(pair);
  });
});

describe('pane layout persistence', () => {
  const first: PaneNode = {
    kind: 'split', dir: 'row', ratio: 0.5,
    a: { kind: 'leaf', key: 'shell:1' },
    b: { kind: 'leaf', key: 'shell:2' },
  };
  const second: PaneNode = {
    kind: 'split', dir: 'col', ratio: 0.5,
    a: { kind: 'leaf', key: 'shell:3' },
    b: { kind: 'leaf', key: 'shell:4' },
  };

  it('reads the legacy single-tree format as one group', () => {
    localStorage.setItem('strado.paneLayout', JSON.stringify({ '/repo': first }));
    expect(readPaneLayouts()).toEqual({ '/repo': [first] });
  });

  it('persists multiple groups for one worktree', () => {
    rememberPaneLayouts('/repo', [first, second]);
    expect(readPaneLayouts()).toEqual({ '/repo': [first, second] });
  });
});
