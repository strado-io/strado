// Go to definition in JS/TS without a language server: follow the symbol's
// import to the file that declares it (through index re-exports), or find it
// in the same file. It reads a few files, so it answers in milliseconds, and
// following the import is as exact as the server for what it resolves. It is
// what answers while TypeScript loads a big project (~10 s on a 5k-file app),
// which is when go-to-definition used to sit and wait.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { declFor } from '../files/search.js';
import type { NavHit } from './types.js';

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const RESOLVE_EXTS = [...SOURCE_EXTS, '.d.ts'];
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** Re-export hops followed (a barrel re-exporting a barrel …). */
const MAX_HOPS = 4;

type Place = { abs: string; line: number; col: number; preview: string };
type Binding = { imported: string; spec: string };

export const isJsLike = (rel: string): boolean => SOURCE_EXTS.includes(path.extname(rel).toLowerCase());

const read = (abs: string): Promise<string | null> => fs.readFile(abs, 'utf8').catch(() => null);

const isFile = async (abs: string): Promise<boolean> => {
  try { return (await fs.stat(abs)).isFile(); } catch { return false; }
};

/** 1-based line and column of an offset, and that line's text. */
function placeAt(text: string, offset: number): { line: number; col: number; preview: string } {
  const before = text.lastIndexOf('\n', offset - 1) + 1;
  const after = text.indexOf('\n', offset);
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return { line, col: offset - before + 1, preview: text.slice(before, after === -1 ? undefined : after).trim().slice(0, 200) };
}

/** Each name a file imports, as the local name it goes by. */
function importsOf(text: string): Map<string, Binding> {
  const out = new Map<string, Binding>();
  const named = (list: string, spec: string) => {
    for (const part of list.split(',')) {
      const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (m) out.set(m[2] ?? m[1]!, { imported: m[1]!, spec });
    }
  };
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([\w$*{},\s]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1]!;
    const spec = m[2]!;
    const def = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause);
    if (def && def[1] !== 'type') out.set(def[1]!, { imported: 'default', spec });
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) out.set(ns[1]!, { imported: '*', spec });
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) named(braces[1]!, spec);
  }
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = m[1]!;
    if (target.startsWith('{')) {
      for (const part of target.slice(1, -1).split(',')) {
        const p = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/.exec(part);
        if (p) out.set(p[2] ?? p[1]!, { imported: p[1]!, spec: m[2]! });
      }
    } else out.set(target, { imported: 'default', spec: m[2]! });
  }
  return out;
}

type Aliases = { baseUrl: string | null; paths: [string, string[]][] };
const aliasCache = new Map<string, Aliases>();

/** The nearest tsconfig/jsconfig's baseUrl and paths, with the folder that holds them. */
async function aliasesFor(root: string, dir: string): Promise<{ pkgDir: string; aliases: Aliases }> {
  let pkgDir: string | null = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (!pkgDir && await isFile(path.join(d, 'package.json'))) pkgDir = d;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = path.join(d, name);
      const cached = aliasCache.get(file);
      if (cached) return { pkgDir: pkgDir ?? d, aliases: cached };
      const text = await read(file);
      if (text === null) continue;
      let aliases: Aliases = { baseUrl: null, paths: [] };
      try {
        // Comments and trailing commas are common in these files.
        const json = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')) as
          { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
        const opts = json.compilerOptions ?? {};
        const base = opts.baseUrl ? path.resolve(d, opts.baseUrl) : null;
        aliases = { baseUrl: base, paths: Object.entries(opts.paths ?? {}).map(([k, v]) => [k, v.map((t) => path.resolve(base ?? d, t))]) };
      } catch { /* unreadable config: no aliases */ }
      aliasCache.set(file, aliases);
      if (aliasCache.size > 200) aliasCache.clear();
      return { pkgDir: pkgDir ?? d, aliases };
    }
    if (d === root || path.dirname(d) === d) return { pkgDir: pkgDir ?? root, aliases: { baseUrl: null, paths: [] } };
  }
}

/** The file an import specifier names, if it is in this worktree (packages are not followed). */
async function resolveSpec(root: string, fromAbs: string, spec: string): Promise<string | null> {
  const dir = path.dirname(fromAbs);
  const bases: string[] = [];
  if (spec.startsWith('.')) bases.push(path.resolve(dir, spec));
  else {
    const { pkgDir, aliases } = await aliasesFor(root, dir);
    for (const [key, targets] of aliases.paths) {
      const star = key.indexOf('*');
      if (star === -1 ? spec === key : spec.startsWith(key.slice(0, star)) && spec.endsWith(key.slice(star + 1))) {
        const mid = star === -1 ? '' : spec.slice(star, spec.length - (key.length - star - 1));
        for (const t of targets) bases.push(t.replace('*', mid));
      }
    }
    if (aliases.baseUrl) bases.push(path.resolve(aliases.baseUrl, spec));
    // Bundler-resolved bare paths ("components/Button" from src/).
    bases.push(path.resolve(pkgDir, 'src', spec), path.resolve(pkgDir, spec));
  }
  for (const base of bases) {
    if (!base.startsWith(root + path.sep) || base.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (SOURCE_EXTS.includes(path.extname(base)) && await isFile(base)) return base;
    for (const ext of RESOLVE_EXTS) if (await isFile(base + ext)) return base + ext;
    for (const ext of RESOLVE_EXTS) if (await isFile(path.join(base, 'index' + ext))) return path.join(base, 'index' + ext);
  }
  return null;
}

/** Where `name` is declared in this file's text, if it is. */
function declIn(abs: string, text: string, name: string): Place | null {
  const decl = declFor(path.extname(abs), name);
  if (!decl) return null;
  // Also a destructured binding: `export const { useToken } = theme;`.
  const destructured = new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let|var)\s*[{[][^=]*\b${name.replaceAll('$', '\\$')}\b[^=]*[}\]]\s*=`);
  const re = { test: (line: string) => decl.test(line) || destructured.test(line) };
  const lines = text.split('\n');
  let offset = 0;
  for (const lineText of lines) {
    if (re.test(lineText)) {
      const at = lineText.search(new RegExp(`\\b${name.replaceAll('$', '\\$')}\\b`));
      return { abs, ...placeAt(text, offset + Math.max(0, at)) };
    }
    offset += lineText.length + 1;
  }
  return null;
}

/** Where a module's export named `name` ('default' for its default) is declared. */
async function exportedFrom(root: string, abs: string, name: string, hops: number): Promise<Place | null> {
  const text = await read(abs);
  if (text === null) return null;
  if (name === 'default') {
    const decl = /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?|class)\s*([\w$]+)?/.exec(text);
    if (decl) return { abs, ...placeAt(text, decl.index + (decl[1] ? decl[0].lastIndexOf(decl[1]) : 0)) };
    const ident = /\bexport\s+default\s+([\w$]+)\s*;?\s*$/m.exec(text);
    if (ident) return declIn(abs, text, ident[1]!) ?? { abs, ...placeAt(text, ident.index) };
    const named = /\bexport\s*\{[^}]*\b([\w$]+)\s+as\s+default\b/.exec(text);
    if (named) return declIn(abs, text, named[1]!);
    const any = /\bexport\s+default\b/.exec(text);
    return any ? { abs, ...placeAt(text, any.index) } : null;
  }
  // Declared here (exported inline, or exported further down by name).
  const local = declIn(abs, text, name);
  if (local) return local;
  if (hops >= MAX_HOPS) return null;
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s+['"]([^'"]+)['"])?/g)) {
    for (const part of m[1]!.split(',')) {
      const p = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (!p || (p[2] ?? p[1]) !== name) continue;
      if (!m[2]) return declIn(abs, text, p[1]!);
      const next = await resolveSpec(root, abs, m[2]);
      return next ? exportedFrom(root, next, p[1]!, hops + 1) : null;
    }
  }
  for (const m of text.matchAll(/\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
    const next = await resolveSpec(root, abs, m[1]!);
    const hit = next && await exportedFrom(root, next, name, hops + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * The definition of the word at line/col of a JS/TS file, found by following
 * imports. null = not resolvable this way (not imported from inside the
 * worktree, not declared in the file): the caller falls back.
 */
export async function importDefinition(root: string, abs: string, line: number, col: number): Promise<NavHit[] | null> {
  if (!isJsLike(abs)) return null;
  const text = await read(abs);
  if (text === null) return null;
  const lineText = text.split('\n')[line - 1] ?? '';
  const isWord = (ch: string | undefined) => !!ch && /[\w$]/.test(ch);
  let from = Math.min(Math.max(col - 1, 0), lineText.length);
  if (!isWord(lineText[from]) && isWord(lineText[from - 1])) from--;
  if (!isWord(lineText[from])) return null;
  let to = from;
  while (from > 0 && isWord(lineText[from - 1])) from--;
  while (isWord(lineText[to])) to++;
  const word = lineText.slice(from, to);
  if (!IDENT.test(word)) return null;

  const imports = importsOf(text);
  // ns.member, with ns an `import * as ns`: the member, in that module.
  const qualifier = /([\w$]+)\s*\.\s*$/.exec(lineText.slice(0, from));
  const viaNs = qualifier && imports.get(qualifier[1]!);
  // The cursor on the imported side of `import { a as b }` means `a` too.
  const byImported = () => [...imports.values()].find((b) => b.imported === word);
  const binding = viaNs?.imported === '*' ? { imported: word, spec: viaNs.spec } : imports.get(word) ?? byImported();

  let place: Place | null = null;
  if (binding && binding.imported !== '*') {
    const target = await resolveSpec(root, abs, binding.spec);
    if (target) place = await exportedFrom(root, target, binding.imported, 0);
  } else if (binding) {
    const target = await resolveSpec(root, abs, binding.spec);
    if (target) place = { abs: target, line: 1, col: 1, preview: ((await read(target)) ?? '').split('\n')[0]!.trim().slice(0, 200) };
  } else if (!qualifier) {
    place = declIn(abs, text, word);
  }
  if (!place) return null;
  const rel = path.relative(root, place.abs).split(path.sep).join('/');
  return [{ path: rel, line: place.line, col: place.col, preview: place.preview }];
}
