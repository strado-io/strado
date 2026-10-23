import { beforeEach, describe, expect, it } from 'vitest';
import { carryNames, dockLeaf, groupName, leafKeys, readPaneLayouts, rememberPaneLayouts, removeLeaf, withGroupName, type PaneNode } from './paneLayout';

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

describe('group names', () => {
  const leaf = (key: string): PaneNode => ({ kind: 'leaf', key });
  const split = (a: PaneNode, b: PaneNode, name?: string): PaneNode => ({ kind: 'split', dir: 'row', ratio: 0.5, a, b, ...(name ? { name } : {}) });

  it('a name lives on the layout\'s root; blank clears it; a lone leaf has none', () => {
    const g = withGroupName(split(leaf('shell:1'), leaf('claude:1')), '  Review  ');
    expect(groupName(g)).toBe('Review');
    expect(groupName(withGroupName(g, '   '))).toBeNull();
    expect(withGroupName(leaf('shell:1'), 'x')).toEqual(leaf('shell:1'));
  });

  it('survives a reload', () => {
    rememberPaneLayouts('/w', [withGroupName(split(leaf('shell:1'), leaf('claude:1')), 'Review')]);
    expect(groupName(readPaneLayouts()['/w']![0]!)).toBe('Review');
  });

  it('carryNames: a rewritten layout keeps its group\'s name (the root collapsed, a pane added or removed)', () => {
    const named = split(split(leaf('a'), leaf('b')), leaf('c'), 'Review');
    const other = split(leaf('x'), leaf('y'), 'Logs');
    // Removing c collapses the root to the inner split: the name moves with it.
    const after = [removeLeaf(named, 'c')!, other];
    expect(carryNames([named, other], after).map(groupName)).toEqual(['Review', 'Logs']);
    // A brand-new group gets no name; one name is never given to two groups.
    const fresh = split(leaf('p'), leaf('q'));
    expect(carryNames([named], [split(leaf('a'), leaf('d')), split(leaf('b'), leaf('e')), fresh]).map(groupName)).toEqual(['Review', null, null]);
    // A name set on the new layout wins.
    expect(carryNames([named], [split(leaf('a'), leaf('b'), 'New')]).map(groupName)).toEqual(['New']);
  });
});
