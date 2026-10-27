// The Files tab's server side: a view of one worktree, and in-place edits of
// its existing text files. Every path in and out is relative to the worktree
// root; nothing is read or written outside the root (symlinks included) or
// inside .git. The only write replaces an existing file's text.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.js';
import {
  FILES_LIMITS,
  type FileChange,
  type FileContent,
  type FileList,
  type FileMarks,
  type FileTreeEntry,
  type FileWriteConflict,
  type FileWriteResult,
  type FileTreePage,
} from './types.js';

const BINARY_SNIFF = 8192;
const GIT_TIMEOUT_MS = 30_000;

/** A client-supplied relative path, normalized ('' = the root). Refuses
 *  anything that could name a place outside the root or inside .git. */
export function safeRel(p: string): string {
  if (p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw new AppError('VALIDATION', 'bad path');
  }
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.some((s) => s === '..' || s === '.git')) throw new AppError('VALIDATION', 'bad path');
  return parts.join('/');
}

type GitResult = { code: number; stdout: string; truncated: boolean };

/** git with literal pathspecs (a file named ":(glob)*" is just a name), no
 *  optional locks (a read must not contend with the user's own git), and an
 *  optional stop after `maxRecords` NUL-terminated records. */
function runGit(
  cwd: string,
  args: string[],
  opts: { input?: string; maxRecords?: number; literal?: boolean } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_LITERAL_PATHSPECS: opts.literal === false ? '0' : '1',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let records = 0;
    let truncated = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      chunks.push(b);
      if (opts.maxRecords !== undefined) {
        for (const byte of b) if (byte === 0) records++;
        if (records > opts.maxRecords) {
          truncated = true;
          child.kill('SIGKILL');
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', truncated: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: truncated ? 0 : (code ?? -1), stdout: Buffer.concat(chunks).toString('utf8'), truncated });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

const records = (s: string) => s.split('\0').filter(Boolean);

function changeOf(xy: string): FileChange {
  if (xy === '??') return '?';
  if (xy.includes('R')) return 'R';
  if (xy[0] === 'A') return 'A';
  if (xy.includes('D')) return 'D';
  return 'M';
}

type GitStatus = {
  /** Path (relative to the worktree root) → its change. */
  files: Map<string, FileChange>;
  /** Untracked folders git collapsed to "dir/": everything under them is '?'. */
  untrackedDirs: string[];
  /** Folder → the changes somewhere under it. */
  dirs: Map<string, Set<FileChange>>;
};

/** null when the root is not in a git work tree. `scope` limits the status
 *  to one folder or file ('' = the whole worktree): a folder expand in a big
 *  repo must not cost a whole-repo status. `allUntracked` lists files inside
 *  untracked folders instead of collapsing them. */
async function gitStatus(root: string, scope: string, allUntracked = false): Promise<GitStatus | null> {
  const prefix = await runGit(root, ['rev-parse', '--show-prefix']);
  if (prefix.code !== 0) return null;
  const pre = prefix.stdout.trim();
  const args = ['status', '--porcelain=v1', '-z'];
  if (allUntracked) args.push('--untracked-files=all');
  if (scope) args.push('--', scope);
  const r = await runGit(root, args);
  if (r.code !== 0) return null;
  const st: GitStatus = { files: new Map(), untrackedDirs: [], dirs: new Map() };
  const recs = records(r.stdout);
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    const xy = rec.slice(0, 2);
    // A rename or copy carries its source as the next record.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    let p = rec.slice(3);
    if (!p.startsWith(pre)) continue;
    p = p.slice(pre.length);
    const change = changeOf(xy);
    if (p.endsWith('/')) {
      p = p.slice(0, -1);
      st.untrackedDirs.push(p);
    } else {
      st.files.set(p, change);
    }
    for (let d = path.posix.dirname(p); d !== '.'; d = path.posix.dirname(d)) {
      const set = st.dirs.get(d) ?? new Set<FileChange>();
      set.add(change);
      st.dirs.set(d, set);
    }
  }
  return st;
}

function changeFor(st: GitStatus | null, rel: string, kind: 'dir' | 'file'): FileChange | undefined {
  if (!st) return undefined;
  if (st.untrackedDirs.some((d) => rel === d || rel.startsWith(`${d}/`))) return '?';
  if (kind === 'file') return st.files.get(rel);
  const under = st.dirs.get(rel);
  if (!under?.size) return undefined;
  return under.size === 1 ? [...under][0] : 'M';
}

/** Resolves `rel` through symlinks and refuses anything that lands outside
 *  the root or inside .git (403). Missing → 404. */
export async function resolveInside(root: string, rel: string): Promise<{ realRoot: string; real: string }> {
  const realRoot = await fs.realpath(root);
  let real: string;
  try {
    real = await fs.realpath(path.join(realRoot, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', 'no such path');
    throw err;
  }
  const inside = path.relative(realRoot, real);
  if (
    inside === '..' ||
    inside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(inside) ||
    inside.split(path.sep).includes('.git')
  ) {
    throw new AppError('PATH_FORBIDDEN', 'path is not under an allowed root');
  }
  return { realRoot, real };
}

export async function readTree(root: string, dirIn: string, withIgnored: boolean): Promise<FileTreePage> {
  const dir = safeRel(dirIn);
  const { realRoot, real } = await resolveInside(root, dir);
  if (!(await fs.stat(real)).isDirectory()) throw new AppError('VALIDATION', 'not a folder');
  const dirents = await fs.readdir(real, { withFileTypes: true });
  let entries: FileTreeEntry[] = [];
  for (const d of dirents) {
    if (d.name === '.git') continue;
    const rel = dir ? `${dir}/${d.name}` : d.name;
    let isDir = d.isDirectory();
    let size: number | undefined;
    if (d.isSymbolicLink()) {
      // A symlink shows as what it points at, but only when that stays inside:
      // the kind and size of something outside the worktree are not ours to
      // show (and opening it is refused).
      const target = await resolveInside(realRoot, rel).catch(() => null);
      const s = target && (await fs.stat(target.real).catch(() => null));
      isDir = !!s?.isDirectory();
      if (!isDir && s) size = s.size;
    } else if (d.isFile()) {
      size = (await fs.stat(path.join(real, d.name)).catch(() => null))?.size ?? 0;
    } else if (!isDir) {
      continue; // sockets, fifos, devices
    }
    entries.push(
      isDir
        ? { name: d.name, path: rel, kind: 'dir' }
        : { name: d.name, path: rel, kind: 'file', ...(size === undefined ? {} : { size }) },
    );
  }

  const st = await gitStatus(root, dir);
  if (st) {
    // check-ignore refuses literal pathspecs, so a leading ':' (pathspec
    // magic) is defused with './' instead and stripped from the answer.
    const check = await runGit(root, ['check-ignore', '-z', '--stdin'], {
      literal: false,
      input: entries.map((e) => `./${e.path}${e.kind === 'dir' ? '/' : ''}\0`).join(''),
    });
    // check-ignore exits 1 when nothing matched.
    const ignored = new Set(
      check.code === 0 ? records(check.stdout).map((p) => p.replace(/^\.\//, '').replace(/\/$/, '')) : [],
    );
    entries = entries.flatMap((e) => {
      if (ignored.has(e.path)) return withIgnored ? [{ ...e, ignored: true }] : [];
      const change = changeFor(st, e.path, e.kind);
      return [change ? { ...e, change } : e];
    });
  }

  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  const truncated = entries.length > FILES_LIMITS.treeEntries;
  return { dir, entries: truncated ? entries.slice(0, FILES_LIMITS.treeEntries) : entries, truncated };
}

export async function listFiles(root: string, limit: number = FILES_LIMITS.listFiles): Promise<FileList> {
  const r = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    maxRecords: limit * 2,
  });
  if (r.code !== 0) return { files: [], truncated: false };
  // An unmerged path is listed once per stage.
  const files = [...new Set(records(r.stdout))];
  const truncated = r.truncated || files.length > limit;
  return { files: files.slice(0, limit), truncated };
}

const BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'json', json5: 'json', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp',
  rb: 'ruby', php: 'php', lua: 'lua', scala: 'scala', dart: 'dart', ex: 'elixir', exs: 'elixir',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', html: 'html', htm: 'html', vue: 'vue',
  xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', properties: 'properties',
  sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', proto: 'protobuf', diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile',
};

/** A name CodeMirror's language-data resolves (matchLanguageName); null = plain text. */
export function languageFor(rel: string): string | null {
  const base = path.posix.basename(rel);
  if (/^Dockerfile(\..+)?$/i.test(base)) return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null;
}

const isBinary = (buf: Buffer) => buf.subarray(0, BINARY_SNIFF).includes(0);

export async function readFile(root: string, relIn: string): Promise<FileContent> {
  const rel = safeRel(relIn);
  if (!rel) throw new AppError('VALIDATION', 'path is required');
  const { real } = await resolveInside(root, rel);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new AppError('VALIDATION', 'not a file');
  const st = await gitStatus(root, rel, true);
  const change = changeFor(st, rel, 'file');
  const base = { path: rel, size: stat.size, language: languageFor(rel), ...(change ? { change } : {}) };
  if (stat.size > FILES_LIMITS.readBytes) return { ...base, binary: false, tooLarge: true };
  const buf = await fs.readFile(real);
  if (buf.length > FILES_LIMITS.readBytes) return { ...base, size: buf.length, binary: false, tooLarge: true };
  if (isBinary(buf)) return { ...base, size: buf.length, binary: true, tooLarge: false };
  return {
    path: rel, size: buf.length, binary: false, tooLarge: false, text: buf.toString('utf8'), language: base.language,
    ...(change ? { change } : {}), version: versionOf(buf), ...(isUtf8(buf) ? {} : { notUtf8: true as const }),
  };
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
/** Valid UTF-8: its text round-trips. A file that is not shows lossy text and
 *  is never written back (a save would change bytes the person never touched). */
function isUtf8(buf: Buffer): boolean {
  try {
    strictUtf8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** FileContent.version: the sha-256 of the exact bytes. */
const versionOf = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

export type WriteOutcome =
  | { ok: true; result: FileWriteResult; /** The file written (symlinks resolved). */ real: string }
  | { ok: false; conflict: FileWriteConflict };

/** Replaces an existing text file's contents. Refused unless the file on disk
 *  is still `baseVersion` (or `force`). Written to a temp file beside it and
 *  renamed over it, keeping its mode: a reader never sees half a file, and a
 *  failure leaves the old one whole. A symlink is written through to its
 *  target, which must stay inside the worktree. */
export async function writeFile(root: string, relIn: string, text: string, baseVersion: string, force = false): Promise<WriteOutcome> {
  const rel = safeRel(relIn);
  if (!rel) throw new AppError('VALIDATION', 'path is required');
  const { real } = await resolveInside(root, rel);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new AppError('VALIDATION', 'not a file');
  if (stat.size > FILES_LIMITS.readBytes) throw new AppError('VALIDATION', 'file too large');
  const data = Buffer.from(text, 'utf8');
  if (data.length > FILES_LIMITS.readBytes) throw new AppError('VALIDATION', 'text too large');
  if (data.includes(0)) throw new AppError('VALIDATION', 'binary text');
  const current = await fs.readFile(real);
  if (current.length > FILES_LIMITS.readBytes) throw new AppError('VALIDATION', 'file too large');
  if (isBinary(current)) throw new AppError('VALIDATION', 'binary file');
  if (!isUtf8(current)) throw new AppError('VALIDATION', 'file is not utf-8');
  // A file the person made read-only stays so (a rename would replace it anyway).
  if (!(stat.mode & 0o200)) throw new AppError('VALIDATION', 'file is read-only');
  const now = versionOf(current);
  if (now !== baseVersion && !force) return { ok: false, conflict: { error: 'conflict', path: rel, version: now } };
  const mode = stat.mode & 0o7777;
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.strado-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, data, { flag: 'wx', mode });
    await fs.chmod(tmp, mode); // the umask may have narrowed it
    await fs.rename(tmp, real);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new AppError('VALIDATION', 'could not write the file');
  }
  return { ok: true, result: { path: rel, version: versionOf(data), size: data.length }, real };
}

/** `git diff -U0` output → line marks in the new file. */
export function parseMarks(rel: string, diff: string): FileMarks {
  const marks: FileMarks = { path: rel, added: [], modified: [], deletedAfter: [] };
  for (const m of diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = m[1] === undefined ? 1 : Number(m[1]);
    const start = Number(m[2]);
    const newCount = m[3] === undefined ? 1 : Number(m[3]);
    if (newCount === 0) marks.deletedAfter.push(start);
    else if (oldCount === 0) marks.added.push([start, start + newCount - 1]);
    else marks.modified.push([start, start + newCount - 1]);
  }
  return marks;
}

function lineCount(buf: Buffer): number {
  if (!buf.length) return 0;
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

export async function readMarks(root: string, relIn: string): Promise<FileMarks> {
  const rel = safeRel(relIn);
  if (!rel) throw new AppError('VALIDATION', 'path is required');
  const none: FileMarks = { path: rel, added: [], modified: [], deletedAfter: [] };
  let real: string;
  try {
    ({ real } = await resolveInside(root, rel));
  } catch (err) {
    // Deleted in the working copy: nothing left to mark.
    if (err instanceof AppError && err.code === 'NOT_FOUND') return none;
    throw err;
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new AppError('VALIDATION', 'not a file');
  const allAdded = async (): Promise<FileMarks> => {
    if (stat.size > FILES_LIMITS.readBytes) return none;
    const buf = await fs.readFile(real);
    const n = isBinary(buf) ? 0 : lineCount(buf);
    return n ? { ...none, added: [[1, n]] } : none;
  };
  const st = await gitStatus(root, rel, true);
  if (!st) return none;
  if (changeFor(st, rel, 'file') === '?') return allAdded();
  const r = await runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', 'HEAD', '--', rel]);
  // No HEAD yet (a fresh repo): everything in the file is new.
  if (r.code !== 0) return allAdded();
  return parseMarks(rel, r.stdout);
}
