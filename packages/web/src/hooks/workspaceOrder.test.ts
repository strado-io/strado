import { describe, expect, it } from 'vitest';
import { moveId, targetIndex } from './workspaceOrder';

const ids = ['a', 'b', 'c', 'd'];
// Four 40px rows starting at y=100.
const rects = [0, 1, 2, 3].map((i) => ({ top: 100 + i * 40, height: 40 }));

describe('moveId', () => {
  it('moves a row down', () => {
    expect(moveId(ids, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a row up', () => {
    expect(moveId(ids, 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves the first row to the end and back', () => {
    const toEnd = moveId(ids, 'a', 3);
    expect(toEnd).toEqual(['b', 'c', 'd', 'a']);
    expect(moveId(toEnd, 'a', 0)).toEqual(ids);
  });

  it('is a no-op when the row is already there', () => {
    expect(moveId(ids, 'b', 1)).toEqual(ids);
  });

  it('clamps an index past either end', () => {
    expect(moveId(ids, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveId(ids, 'd', -5)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('leaves an unknown id alone', () => {
    expect(moveId(ids, 'zz', 0)).toEqual(ids);
  });
});

describe('targetIndex', () => {
  it('lands on the row whose top half the pointer is in', () => {
    expect(targetIndex(105, rects)).toBe(0); // just inside row 0
    expect(targetIndex(145, rects)).toBe(1); // past row 0's midline
  });

  it('lands on the last row when the pointer is below everything', () => {
    expect(targetIndex(9999, rects)).toBe(3);
  });

  it('lands on the first row when the pointer is above everything', () => {
    expect(targetIndex(0, rects)).toBe(0);
  });

  it('returns 0 for an empty list', () => {
    expect(targetIndex(120, [])).toBe(0);
  });
});
