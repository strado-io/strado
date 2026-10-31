import { describe, expect, it } from 'vitest';
import { homeOf, type PaneNode } from './paneLayout';

const leaf = (key: string): PaneNode => ({ kind: 'leaf', key });
const split = (dir: 'row' | 'col', a: PaneNode, b: PaneNode): PaneNode => ({ kind: 'split', dir, ratio: 0.5, a, b });

describe('homeOf', () => {
  it('a pane on the right goes back right of its neighbour', () => {
    expect(homeOf(split('row', leaf('a'), leaf('b')), 'b')).toEqual({ target: 'a', side: 'right' });
  });
  it('a pane on top goes back above its neighbour', () => {
    expect(homeOf(split('col', leaf('a'), leaf('b')), 'a')).toEqual({ target: 'b', side: 'top' });
  });
  it('picks the neighbour leaf nearest it in a nested split', () => {
    const tree = split('row', split('col', leaf('a'), leaf('b')), leaf('c'));
    expect(homeOf(tree, 'c')).toEqual({ target: 'b', side: 'right' });
    expect(homeOf(tree, 'b')).toEqual({ target: 'a', side: 'bottom' });
  });
  it('a lone pane has no home', () => {
    expect(homeOf(leaf('a'), 'a')).toBeNull();
  });
});
