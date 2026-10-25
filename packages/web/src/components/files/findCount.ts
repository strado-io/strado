// Counting find matches off the main thread. The person's regex runs over the
// whole file here, so a pattern like (a+)+$ can take seconds; findPanel.ts
// runs this in a Worker and gives up after FIND_TIMEOUT_MS instead of freezing.

/** Counting stops here; a bigger file says "1000+". */
export const COUNT_CAP = 1000;
/** A count slower than this is abandoned (the worker is ended). */
export const FIND_TIMEOUT_MS = 250;

export type FindSpec = { search: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean };
/** Where each match starts and ends, up to the cap. */
export type FindCount = { from: number[]; to: number[]; capped: boolean };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern a spec searches for, or null when it isn't a valid regex. */
export function findPattern(q: FindSpec): RegExp | null {
  try {
    let src = q.regexp ? q.search : escape(q.search);
    if (q.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    return new RegExp(src, `gu${q.caseSensitive ? '' : 'i'}`);
  } catch {
    return null;
  }
}

export function countMatches(doc: string, q: FindSpec, cap = COUNT_CAP): FindCount | 'invalid' {
  const out: FindCount = { from: [], to: [], capped: false };
  if (!q.search) return out;
  const re = findPattern(q);
  if (!re) return 'invalid';
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    if (m[0].length === 0) { re.lastIndex++; continue; } // CodeMirror skips empty matches too
    if (out.from.length >= cap) { out.capped = true; break; }
    out.from.push(m.index);
    out.to.push(m.index + m[0].length);
  }
  return out;
}

/** "3 of 12", "12" (cursor not on one), "1000+", or "No results". */
export function countLabel(c: FindCount, sel: { from: number; to: number }): string {
  const total = c.from.length;
  if (!total) return 'No results';
  const i = c.from.findIndex((f, j) => f === sel.from && c.to[j] === sel.to);
  const of = c.capped ? `${total}+` : String(total);
  return i >= 0 ? `${i + 1} of ${of}` : of;
}
