// Search in a worktree (⌘⇧F), and the whole-word search behind go-to-definition
// when no language server answers. ripgrep when it is on PATH, else git grep.
// Literal unless a regex is asked for; never outside the worktree (no symlinks
// followed), never .git, never ignored or binary files. Capped and timed: the
// search process is killed at the cap or after 10s, and what came back so far
// is the answer, marked truncated.
//
// The declaration patterns in DECL below are ported from px0
// (github.com/px0-ai/px0, internal/symbols/symbols.go), under its MIT License:
//
//   Copyright (c) 2026 Arpit Bhayani
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../../errors.js';
import { LSP_LIMITS, type NavHit, type SearchAnswer, type SearchQuery } from '../lsp/types.js';

const TIMEOUT_MS = 10_000;
const QUERY_MAX = 1000;
const GLOB_MAX = 300;
const PREVIEW_MAX = 200;
const BAD_PATTERN = 'bad search pattern';

type Engine = SearchAnswer['engine'];

let rgOnPath: Promise<boolean> | null = null;
/** Whether `rg` runs here; asked once per process. */
function hasRg(): Promise<boolean> {
  rgOnPath ??= new Promise((resolve) => {
    const child = spawn('rg', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return rgOnPath;
}

/** For tests: ask again (after PATH changed). */
export function resetRgProbe(): void {
  rgOnPath = null;
}

function validate(q: SearchQuery): void {
  const bad = () => new AppError('VALIDATION', 'bad search');
  if (!q.q || q.q.length > QUERY_MAX || /[\r\n\0]/.test(q.q)) throw bad();
  if (q.glob !== undefined) {
    const g = q.glob;
    if (!g || g.length > GLOB_MAX || /[\r\n\0\\]/.test(g) || g.startsWith('/') || g.startsWith('!')) throw bad();
    const parts = g.split('/');
    if (parts.some((s) => s === '..' || s === '.git')) throw bad();
  }
}

/** A byte offset in a UTF-8 line → a 1-based character column. */
function charCol(line: string, byteOffset: number): number {
  return Buffer.from(line, 'utf8').subarray(0, byteOffset).toString('utf8').length + 1;
}

function hitOf(rel: string, line: number, text: string, byteOffset: number): NavHit {
  const clean = text.replace(/\r?\n$/, '');
  return { path: rel, line, col: charCol(clean, byteOffset), preview: clean.slice(0, PREVIEW_MAX) };
}

function gitGrepArgs(q: SearchQuery): string[] {
  // A glob with no slash matches at any depth, as rg's -g does.
  const glob = q.glob ? (q.glob.includes('/') ? q.glob : `**/${q.glob}`) : null;
  return [
    'grep', '-n', '--column', '-I', '-z', '--no-color', '--untracked',
    q.regex ? '-E' : '-F',
    ...(q.case ? [] : ['-i']),
    ...(q.word ? ['-w'] : []),
    '-e', q.q,
    '--', glob ? `:(glob)${glob}` : '.',
  ];
}

type Run = { hits: NavHit[]; truncated: boolean };

function run(engine: Engine, root: string, q: SearchQuery, limit: number, signal?: AbortSignal): Promise<Run> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ hits: [], truncated: true });
    const child = spawn(engine === 'rg' ? 'rg' : 'git', engineArgs(engine, q), {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const hits: NavHit[] = [];
    let truncated = false;
    let stopped = false;
    let pending = '';
    const stop = (cut: boolean) => {
      if (cut) truncated = true;
      if (stopped) return;
      stopped = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(true), TIMEOUT_MS);
    const onAbort = () => stop(true);
    signal?.addEventListener('abort', onAbort, { once: true });
    const take = (line: string) => {
      if (!line || stopped) return;
      const hit = engine === 'rg' ? parseRg(line) : parseGitGrep(line);
      if (!hit) return;
      if (hits.length >= limit) return stop(true);
      hits.push(hit);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0 && !stopped) {
        take(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new AppError('SHELL_FAILED', 'search failed'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!stopped) take(pending);
      // rg: 1 = no match, 2 = error. git grep: 1 = no match, 128 = error.
      if (!stopped && code !== 0 && code !== 1) return reject(new AppError('VALIDATION', BAD_PATTERN));
      resolve({ hits, truncated });
    });
  });
}

function engineArgs(engine: Engine, q: SearchQuery): string[] {
  if (engine === 'git-grep') return gitGrepArgs(q);
  return [
    '--json', '--no-config', '--hidden', '-g', '!.git',
    ...(q.regex ? [] : ['--fixed-strings']),
    q.case ? '--case-sensitive' : '--ignore-case',
    ...(q.word ? ['--word-regexp'] : []),
    ...(q.glob ? ['-g', q.glob] : []),
    // -e: a query starting with '-' is still the query.
    '-e', q.q,
    '--', '.',
  ];
}

type RgMatch = {
  type: string;
  data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start: number }[] };
};

function parseRg(line: string): NavHit | null {
  let m: RgMatch;
  try {
    m = JSON.parse(line) as RgMatch;
  } catch {
    return null;
  }
  if (m.type !== 'match' || !m.data) return null;
  const p = m.data.path?.text;
  const text = m.data.lines?.text;
  const n = m.data.line_number;
  // Paths rg could not print as UTF-8 come as bytes; they are skipped.
  if (!p || text === undefined || !n) return null;
  const rel = path.posix.normalize(p.replace(/^\.\//, ''));
  if (rel.startsWith('../') || rel.startsWith('/')) return null;
  return hitOf(rel, n, text, m.data.submatches?.[0]?.start ?? 0);
}

/** `path\0line\0col\0text` (git grep -z -n --column; col is a 1-based byte offset). */
function parseGitGrep(line: string): NavHit | null {
  const [rel, n, col, ...rest] = line.split('\0');
  if (!rel || !n || !col || !rest.length || !/^\d+$/.test(n) || !/^\d+$/.test(col)) return null;
  if (rel.startsWith('../') || rel.startsWith('/')) return null;
  return hitOf(rel, Number(n), rest.join('\0'), Number(col) - 1);
}

const byPlace = (a: NavHit, b: NavHit) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.col - b.col);

/** ⌘⇧F. `limit` defaults to LSP_LIMITS.maxHits; `engine` is for tests. */
export async function searchFiles(
  root: string,
  q: SearchQuery,
  opts: { signal?: AbortSignal; limit?: number; engine?: Engine } = {},
): Promise<SearchAnswer> {
  validate(q);
  const engine = opts.engine ?? ((await hasRg()) ? 'rg' : 'git-grep');
  const { hits, truncated } = await run(engine, root, q, opts.limit ?? LSP_LIMITS.maxHits, opts.signal);
  return { hits: hits.sort(byPlace), truncated, engine };
}

/** Whole word, case-sensitive, literal: the go-to-definition fallback. */
export function searchWord(root: string, sym: string, opts: { signal?: AbortSignal } = {}): Promise<SearchAnswer> {
  return searchFiles(root, { q: sym, word: true, case: true }, { signal: opts.signal });
}

// ---- definitions first (px0's declaration templates; NAME = the symbol) ----

const IDENT = /^[A-Za-z_$][\w$]*$/;

const DECL: Record<string, string> = {
  go: String.raw`^\s*(?:func\s+(?:\([^)]*\)\s*)?NAME\b|type\s+NAME\b|(?:var|const)\s+NAME\b|\tNAME\s*=)`,
  py: String.raw`^\s*(?:(?:async\s+)?def|class)\s+NAME\b|^NAME\s*(?::[^=]+)?=`,
  js: String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*NAME\b|class\s+NAME\b|(?:const|let|var|type|interface|enum)\s+NAME\b)|^\s*(?:(?:public|private|protected|static|async|get|set|readonly)\s+)*NAME\s*\([^;]*\{\s*$`,
  rs: String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe)\s+)*(?:fn|struct|enum|trait|type|const|static|mod|union)\s+NAME\b|^\s*macro_rules!\s*NAME\b`,
  c: String.raw`^\s*#\s*define\s+NAME\b|^\s*(?:typedef\s+.*\bNAME\s*;|(?:struct|enum|union|class|namespace)\s+NAME\b)|^[A-Za-z_][\w\s*&<>:]*\bNAME\s*\([^;]*$`,
  jvm: String.raw`^\s*(?:(?:public|private|protected|internal|open|abstract|final|static|override|suspend|data|sealed|value|inline)\s+)*(?:class|interface|enum|record|object|fun|val|var|def|trait|type)\s+NAME\b|^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|native)\s+)+[\w<>?,\[\]\s]+\s+NAME\s*\(`,
  rb: String.raw`^\s*(?:def\s+(?:self\.)?NAME\b|(?:class|module)\s+NAME\b|NAME\s*=)`,
  sh: String.raw`^\s*(?:function\s+NAME\b|NAME\s*\(\s*\))`,
  php: String.raw`^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?\s*NAME\b|^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+NAME\b`,
  lua: String.raw`^\s*(?:local\s+)?function\s+(?:[\w.]+\.)?NAME\b|^\s*(?:local\s+)?NAME\s*=\s*function\b`,
  zig: String.raw`^\s*(?:pub\s+)?(?:fn|const|var)\s+NAME\b`,
  ex: String.raw`^\s*(?:def|defp|defmodule|defmacro|defmacrop|defprotocol)\s+NAME\b`,
  hs: String.raw`^NAME\s*::|^\s*(?:data|type|newtype|class)\s+NAME\b`,
};

const FAMILY: Record<string, string> = {
  '.go': 'go',
  '.py': 'py', '.pyi': 'py',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.rs': 'rs',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.cxx': 'c', '.hpp': 'c', '.hh': 'c',
  '.java': 'jvm', '.kt': 'jvm', '.kts': 'jvm', '.scala': 'jvm', '.cs': 'jvm', '.swift': 'jvm',
  '.rb': 'rb',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh',
  '.php': 'php',
  '.lua': 'lua',
  '.zig': 'zig',
  '.ex': 'ex', '.exs': 'ex',
  '.hs': 'hs',
};

const declCache = new Map<string, RegExp>();
function declFor(ext: string, sym: string): RegExp | null {
  const fam = FAMILY[ext.toLowerCase()];
  // Only a bare identifier ever goes into a pattern.
  if (!fam || !IDENT.test(sym)) return null;
  const key = `${fam}\0${sym}`;
  let re = declCache.get(key);
  if (!re) {
    // '$' is the one identifier character that is special in a pattern.
    re = new RegExp(DECL[fam]!.replaceAll('NAME', sym.replaceAll('$', '\\$')));
    if (declCache.size > 500) declCache.clear();
    declCache.set(key, re);
  }
  return re;
}

/** Does this hit's line look like a declaration of `sym`, in its file's language? */
export function isDefinition(hit: NavHit, sym: string): boolean {
  return declFor(path.posix.extname(hit.path), sym)?.test(hit.preview) ?? false;
}

/** Definitions first; otherwise the order is kept. */
export function classifyDefinitions(hits: NavHit[], sym: string): NavHit[] {
  const defs: NavHit[] = [];
  const rest: NavHit[] = [];
  for (const h of hits) (isDefinition(h, sym) ? defs : rest).push(h);
  return [...defs, ...rest];
}
