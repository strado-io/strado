// File paths in terminal and agent output (`src/app.ts:42:7`, `src/a.ts(12,5)`,
// `README.md`), as links into the Files tab. Only paths inside the worktree:
// relative ones, or absolute ones under its root (made relative); never a URL,
// never one that climbs out with '..'. Given the worktree's file list, only
// files that exist, trying a git diff's a/ and b/ prefixes too.

export type FileLink = {
  /** Columns in the text: text.slice(start, end) is the link. */
  start: number;
  end: number;
  text: string;
  /** Relative to the worktree root. */
  path: string;
  line?: number;
  col?: number;
};

const MAX_LINE = 10_000_000;

// A path: optional ./ or / start, '/'-joined segments, ending in a name with an
// extension that starts with a letter (so v1.2.3 is no file). Then :line[:col]
// or the TypeScript (line,col). The lookbehind stops a match starting inside a
// word, a URL (after "://" or a host) or a longer path.
const CANDIDATE = /(?<![\w@+.:/-])((?:\.\/|\/)?(?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?![\w@+/-])(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?/g;

function lineNo(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LINE ? n : undefined;
}

/** The worktree-relative form, or null for anything outside it. */
function relative(raw: string, root: string): string | null {
  let p = raw;
  if (p.startsWith('/')) {
    const base = root.endsWith('/') ? root : `${root}/`;
    if (!p.startsWith(base)) return null;
    p = p.slice(base.length);
  }
  if (p.startsWith('./')) p = p.slice(2);
  if (!p || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  return p;
}

function resolve(p: string, files: Set<string> | undefined): string | null {
  if (!files) return p;
  if (files.has(p)) return p;
  const unprefixed = /^[ab]\//.test(p) ? p.slice(2) : null;
  return unprefixed && files.has(unprefixed) ? unprefixed : null;
}

export function findFileLinks(text: string, opts: { root: string; files?: Set<string> }): FileLink[] {
  const out: FileLink[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const rel = relative(m[1]!, opts.root);
    const path = rel === null ? null : resolve(rel, opts.files);
    if (!path) continue;
    const line = lineNo(m[2] ?? m[4]);
    const col = line === undefined ? undefined : lineNo(m[3] ?? m[5]);
    // A dropped line number takes its suffix with it: the link is the path alone.
    const linkText = line === undefined ? m[1]! : m[0];
    const start = m.index!;
    out.push({ start, end: start + linkText.length, text: linkText, path, line, col });
  }
  return out;
}
