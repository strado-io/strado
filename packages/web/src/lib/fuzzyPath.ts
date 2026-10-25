// ⌘P's matcher: the query as a case-insensitive subsequence of the path,
// matched from the right so the file name wins over folders that happen to
// spell it out. Word starts (after / - _ . or a camelCase hump) and runs of
// consecutive letters score up; gaps inside the match and long paths score down.

export type PathMatch = { score: number; positions: number[] };

const SEPARATORS = new Set(['/', '-', '_', '.', ' ']);

function wordStart(path: string, i: number): boolean {
  if (i === 0) return true;
  const prev = path[i - 1]!;
  if (SEPARATORS.has(prev)) return true;
  const ch = path[i]!;
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

export function matchPath(query: string, path: string): PathMatch | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const positions: number[] = [];
  let at = p.length;
  for (let qi = q.length - 1; qi >= 0; qi--) {
    at = p.lastIndexOf(q[qi]!, at - 1);
    if (at < 0) return null;
    positions.push(at);
  }
  positions.reverse();
  // Then left to right from the first hit: the same window, its letters as
  // tight as they go (src/app.ts highlights "ap", not "a" and a later "p").
  for (let qi = 1, from = positions[0]!; qi < q.length; qi++) {
    from = p.indexOf(q[qi]!, from + 1);
    positions[qi] = from;
  }
  const nameStart = path.lastIndexOf('/') + 1;
  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    const i = positions[k]!;
    score += 1;
    if (wordStart(path, i)) score += 8;
    if (k > 0 && positions[k - 1] === i - 1) score += 5;
    if (i >= nameStart) score += 2;
  }
  const gaps = positions[positions.length - 1]! - positions[0]! + 1 - positions.length;
  return { score: score - gaps * 2 - path.length * 0.05, positions };
}

export function fuzzyFiles(query: string, files: readonly string[], limit = 50): Array<PathMatch & { path: string }> {
  if (!query) return files.slice(0, limit).map((path) => ({ path, score: 0, positions: [] }));
  const out: Array<PathMatch & { path: string }> = [];
  for (const path of files) {
    const m = matchPath(query, path);
    if (m) out.push({ path, ...m });
  }
  return out.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, limit);
}
