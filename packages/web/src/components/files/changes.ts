// Where a file differs from HEAD, as the viewer walks it: n/p jump between the
// starts of these hunks. Small and pure, so it stays out of the lazy editor chunk.
import type { FileMarks } from '../../types';

/** Each change's first line, sorted and unique (a deletion sits on the line after it, min 1). */
export function changeStarts(marks: FileMarks | null): number[] {
  if (!marks) return [];
  const starts = [
    ...marks.added.map(([from]) => from),
    ...marks.modified.map(([from]) => from),
    ...marks.deletedAfter.map((after) => Math.max(1, after + 1)),
  ];
  return [...new Set(starts)].sort((a, b) => a - b);
}

/** The next (dir 1) or previous (dir -1) change start from `line`, wrapping; null when there are none. */
export function stepChange(starts: number[], line: number, dir: 1 | -1): number | null {
  if (starts.length === 0) return null;
  if (dir === 1) return starts.find((s) => s > line) ?? starts[0]!;
  return [...starts].reverse().find((s) => s < line) ?? starts[starts.length - 1]!;
}

/** Per line, what the gutter shows: added, modified, or a deletion just above it. */
export type LineMark = 'added' | 'modified' | 'deleted';
export function lineMarks(marks: FileMarks | null, lineCount: number): Map<number, LineMark> {
  const out = new Map<number, LineMark>();
  if (!marks) return out;
  const fill = (ranges: [number, number][], kind: LineMark) => {
    for (const [from, to] of ranges) for (let l = Math.max(1, from); l <= Math.min(to, lineCount); l++) out.set(l, kind);
  };
  for (const after of marks.deletedAfter) {
    const l = Math.min(Math.max(1, after + 1), Math.max(1, lineCount));
    if (!out.has(l)) out.set(l, 'deleted');
  }
  fill(marks.modified, 'modified');
  fill(marks.added, 'added');
  return out;
}

/** The selection as the agent gets it: whole lines, the text capped at 8 KB. */
export const SNIPPET_MAX = 8 * 1024;
export function capSnippet(text: string): string {
  if (new TextEncoder().encode(text).length <= SNIPPET_MAX) return text;
  let out = text.slice(0, SNIPPET_MAX);
  while (new TextEncoder().encode(out).length > SNIPPET_MAX) out = out.slice(0, -1);
  return out;
}
