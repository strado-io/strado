import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import type { DebugLog } from './debugLog.js';

export type MarkdownFile = { path: string; size: number; mtimeMs: number };
export type MarkdownListing = { files: MarkdownFile[]; truncated: boolean; cap: number };

// Applied during the walk so ignored subtrees are never descended — a 30-worktree
// machine must not stat its way through every node_modules.
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.turbo', 'vendor', '.venv', 'target',
]);

export const MAX_FILES = 2000;

// Ceiling on the stderr buffered from a single `git check-ignore` run, applied
// as data arrives — not just at log time — so a runaway process can't hold an
// unbounded string in memory for the life of the child.
const CHECK_IGNORE_STDERR_LIMIT = 2000;

const MARKDOWN_EXT = new Set(['.md', '.mdx', '.markdown']);

export function isMarkdownPath(p: string): boolean {
  return MARKDOWN_EXT.has(path.extname(p).toLowerCase());
}

// Batched: one `git check-ignore` for the whole candidate list. Exit 0 = some
// paths matched, 1 = none matched, anything else (not a repo, no git binary) =
// treat as "filter unavailable" and keep everything.
async function gitIgnoredPaths(
  worktreePath: string,
  relPaths: string[],
  debugLog?: DebugLog,
): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: worktreePath });
    } catch (err) {
      debugLog?.log('kb', `git check-ignore failed to spawn for ${worktreePath}: ${(err as Error).message}`);
      resolve(new Set());
      return;
    }
    let out = '';
    let errOut = '';
    child.stdout.on('data', (b) => (out += b.toString()));
    // Buffered (not discarded) so a bad-exit-code log line below has a reason,
    // not just a numeric code. Capped as it fills so a pathological git error
    // can't hold an unbounded string in memory; the log line below trims and
    // slices it again to a tighter budget when it's actually written.
    child.stderr.on('data', (b) => {
      if (errOut.length >= CHECK_IGNORE_STDERR_LIMIT) return;
      errOut += b.toString().slice(0, CHECK_IGNORE_STDERR_LIMIT - errOut.length);
    });
    child.on('error', (err) => {
      debugLog?.log('kb', `git check-ignore errored for ${worktreePath}: ${(err as Error).message}`);
      resolve(new Set());
    });
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        const reason = errOut.trim().slice(0, 500) || '(no stderr)';
        debugLog?.log('kb', `git check-ignore exited ${code} for ${worktreePath}: ${reason}`);
        resolve(new Set());
        return;
      }
      resolve(new Set(out.split('\0').filter(Boolean)));
    });
    child.stdin.on('error', () => {});
    // -z applies to both stdin and stdout when paired with --stdin: git parses the
    // input as NUL-delimited too, not just the output. Newline-joined input under -z
    // gets treated as a single (non-matching) path, so this must be NUL-terminated
    // to match what's later parsed from stdout.
    child.stdin.end(relPaths.join('\0') + '\0');
  });
}

export async function listMarkdownFiles(
  worktreePath: string,
  debugLog?: DebugLog,
): Promise<MarkdownListing> {
  const files: MarkdownFile[] = [];
  let truncated = false;

  async function walk(dir: string, rel: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // unreadable dir is not fatal — skip it, but leave a trail so a
      // permissions issue on one worktree doesn't just look like missing files
      debugLog?.log('kb', `readdir failed for ${dir}: ${(err as Error).message}`);
      return;
    }
    // Deterministic order so the cap cuts predictably and output needs no re-sort.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      // isDirectory() is false for symlinks: dirent types are not followed, which
      // is exactly the no-symlink-descent rule.
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, relPath);
        continue;
      }
      if (!entry.isFile() || !isMarkdownPath(entry.name)) continue;
      if (files.length >= MAX_FILES) { truncated = true; return; }
      try {
        const st = await fsp.stat(full);
        files.push({ path: relPath, size: st.size, mtimeMs: st.mtimeMs });
      } catch (err) {
        // vanished between readdir and stat — skip, but log it (see above)
        debugLog?.log('kb', `stat failed for ${full}: ${(err as Error).message}`);
      }
    }
  }

  await walk(worktreePath, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // The cap is spent during the walk, before gitignored files are removed here.
  // A large gitignored markdown directory whose name isn't in SKIP_DIRS can burn
  // the whole budget on files that get filtered out anyway, leaving truncated:
  // true beside a much smaller files.length — real documents elsewhere in the
  // tree are never reached. If that ever bites, the fix is to prune ignored
  // directories during traversal instead of filtering after the walk completes.
  const ignored = await gitIgnoredPaths(worktreePath, files.map((f) => f.path), debugLog);
  return {
    files: ignored.size ? files.filter((f) => !ignored.has(f.path)) : files,
    truncated,
    cap: MAX_FILES,
  };
}

export type MarkdownFileContent = { content: string; size: number; mtimeMs: number };

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function readMarkdownFile(
  worktreePath: string,
  relPath: string,
): Promise<MarkdownFileContent> {
  if (!isMarkdownPath(relPath)) {
    throw new AppError('VALIDATION', `not a markdown file: ${relPath}`);
  }
  const root = path.resolve(worktreePath);
  // path.resolve collapses ../ and makes an absolute relPath win — assertPathUnder
  // then rejects anything that escaped.
  const joined = path.resolve(root, relPath);
  // assertPathUnder's own AppError carries the resolved absolute target and the
  // allowed roots in `details`, which errors.ts ships verbatim to the client —
  // that would leak the worktree's host filesystem path. Catch and rethrow with
  // only the caller-supplied relPath, no details.
  try {
    assertPathUnder(joined, [root]);
  } catch {
    throw new AppError('PATH_FORBIDDEN', `path escapes the worktree: ${relPath}`);
  }

  let real: string;
  try {
    real = await fsp.realpath(joined);
  } catch {
    throw new AppError('NOT_FOUND', `no such file: ${relPath}`);
  }
  // realpath(root) has its own try/catch, separate from the assertPathUnder guard
  // below: if the worktree itself vanished (e.g. removed while a KB tab was open),
  // that's a missing-file condition, not an escape — folding it into the guard's
  // catch would mislabel it PATH_FORBIDDEN (403) instead of NOT_FOUND (404).
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(root);
  } catch {
    throw new AppError('NOT_FOUND', `no such file: ${relPath}`);
  }
  // Second check after realpath: an in-worktree symlink pointing out is an escape.
  try {
    assertPathUnder(real, [rootReal]);
  } catch {
    throw new AppError('PATH_FORBIDDEN', `path escapes the worktree: ${relPath}`);
  }

  // stat/readFile errno errors (permission denied, vanished between realpath and
  // here, etc.) are plain Errors — unwrapped, errors.ts maps them to SHELL_FAILED
  // (HTTP 500) and ships the absolute host path in the message. Wrap both so every
  // failure here surfaces as NOT_FOUND with a message that only ever names relPath.
  // EACCES/EPERM collapse to NOT_FOUND too — the caller shouldn't be able to tell
  // "exists but unreadable" from "doesn't exist".
  let st: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    st = await fsp.stat(real);
  } catch {
    throw new AppError('NOT_FOUND', `no such file: ${relPath}`);
  }
  if (!st.isFile()) throw new AppError('NOT_FOUND', `not a file: ${relPath}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new AppError('VALIDATION', `file is larger than ${MAX_FILE_BYTES} bytes`, {
      size: st.size, max: MAX_FILE_BYTES,
    });
  }
  let content: string;
  try {
    content = await fsp.readFile(real, 'utf8');
  } catch {
    throw new AppError('NOT_FOUND', `no such file: ${relPath}`);
  }
  return { content, size: st.size, mtimeMs: st.mtimeMs };
}
