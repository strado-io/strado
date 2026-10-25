import { describe, expect, it } from 'vitest';
import { COUNT_CAP, countLabel, countMatches } from './findCount';

const q = (search: string, over = {}) => ({ search, caseSensitive: false, regexp: false, wholeWord: false, ...over });

describe('countMatches', () => {
  it('literal, case, whole word and regex', () => {
    const doc = 'Foo foo food (foo)';
    expect(countMatches(doc, q('foo'))).toMatchObject({ from: [0, 4, 8, 14] });
    expect(countMatches(doc, q('foo', { caseSensitive: true })).valueOf()).toMatchObject({ from: [4, 8, 14] });
    expect(countMatches(doc, q('foo', { wholeWord: true }))).toMatchObject({ from: [0, 4, 14] });
    expect(countMatches(doc, q('(foo)'))).toMatchObject({ from: [13], to: [18] }); // literal parens
    expect(countMatches(doc, q('f\\w+d', { regexp: true }))).toMatchObject({ from: [8] });
    expect(countMatches(doc, q('(', { regexp: true }))).toBe('invalid');
  });

  it('skips empty matches and stops at the cap', () => {
    expect(countMatches('abc', q('x*', { regexp: true }))).toMatchObject({ from: [] });
    const r = countMatches('a'.repeat(COUNT_CAP + 5), q('a'));
    expect(r).toMatchObject({ capped: true });
    expect((r as { from: number[] }).from).toHaveLength(COUNT_CAP);
    expect(countLabel(r as never, { from: 0, to: 1 })).toBe(`1 of ${COUNT_CAP}+`);
  });

  it('labels', () => {
    expect(countLabel({ from: [], to: [], capped: false }, { from: 0, to: 0 })).toBe('No results');
    expect(countLabel({ from: [1, 5], to: [2, 6], capped: false }, { from: 5, to: 6 })).toBe('2 of 2');
    expect(countLabel({ from: [1, 5], to: [2, 6], capped: false }, { from: 0, to: 0 })).toBe('2');
  });
});
