import { describe, expect, it } from 'vitest';
import { SNIPPET_MAX, capSnippet, changeStarts, lineMarks, stepChange } from './changes';

const marks = { path: 'a.ts', added: [[10, 12]] as [number, number][], modified: [[3, 3]] as [number, number][], deletedAfter: [0, 20] };

describe('change navigation', () => {
  it('starts are sorted, unique, and a deletion sits on the line after it (min 1)', () => {
    expect(changeStarts(marks)).toEqual([1, 3, 10, 21]);
    expect(changeStarts(null)).toEqual([]);
  });
  it('n/p step to the next/previous start and wrap', () => {
    const s = [3, 10, 21];
    expect(stepChange(s, 1, 1)).toBe(3);
    expect(stepChange(s, 3, 1)).toBe(10);
    expect(stepChange(s, 21, 1)).toBe(3);
    expect(stepChange(s, 10, -1)).toBe(3);
    expect(stepChange(s, 3, -1)).toBe(21);
    expect(stepChange([], 5, 1)).toBeNull();
  });
  it('line marks: added and modified ranges win over a deletion notch; clamped to the file', () => {
    const m = lineMarks({ path: 'a', added: [[2, 3]], modified: [[5, 99]], deletedAfter: [1, 6] }, 6);
    expect([...m.entries()].sort((a, b) => a[0] - b[0])).toEqual([[2, 'added'], [3, 'added'], [5, 'modified'], [6, 'modified']]);
    expect(lineMarks({ path: 'a', added: [], modified: [], deletedAfter: [9] }, 4).get(4)).toBe('deleted');
  });
  it('a snippet is capped at 8 KB (bytes, not characters)', () => {
    expect(capSnippet('short')).toBe('short');
    const big = 'é'.repeat(SNIPPET_MAX);
    const out = capSnippet(big);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(out.length).toBe(SNIPPET_MAX / 2);
  });
});
