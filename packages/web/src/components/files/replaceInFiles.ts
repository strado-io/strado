// ⌘⇧F's Replace all: each file the search found is read, every match in it
// replaced, and written back through the Files tab's one write, with the
// version it was read at, so a file changed on disk since isn't overwritten.
// A file with unsaved edits in a tab is left alone (its buffer is the
// person's), and an open clean one takes the new text.
import type { FileContent, FileWriteBody, FileWriteResult, SearchQuery } from '../../types';
import { findPattern } from './findCount';

export type ReplaceReport = {
  /** Matches replaced, and in how many files. */
  replaced: number;
  files: number;
  /** Not touched: unsaved edits in a tab. */
  skipped: string[];
  /** Read-only (binary, too large, not UTF-8) or the write failed (changed on disk, …). */
  failed: string[];
};

/** The text with every match of the query replaced, and how many there were. */
export function replaceText(text: string, q: SearchQuery, replacement: string): { text: string; count: number } {
  const re = findPattern({ search: q.q, caseSensitive: !!q.case, regexp: !!q.regex, wholeWord: !!q.word });
  if (!re || !q.q) return { text, count: 0 };
  let count = 0;
  // A regex's replacement may use $1, $&, …; a plain search's is taken as typed.
  const out = text.replace(re, (...args: unknown[]) => {
    count++;
    if (!q.regex) return replacement;
    // (match, ...groups, offset, input[, namedGroups])
    const named = typeof args[args.length - 1] === 'object';
    const groups = args.slice(1, named ? -3 : -2) as (string | undefined)[];
    const match = args[0] as string;
    return replacement.replace(/\$(\$|&|\d{1,2})/g, (whole, k: string) => {
      if (k === '$') return '$';
      if (k === '&') return match;
      const g = groups[Number(k) - 1];
      return Number(k) >= 1 && Number(k) <= groups.length ? g ?? '' : whole;
    });
  });
  return { text: out, count };
}

export async function replaceInFiles(paths: string[], q: SearchQuery, replacement: string, io: {
  read: (path: string) => Promise<FileContent>;
  write: (body: FileWriteBody) => Promise<FileWriteResult>;
  /** Unsaved edits in a tab: skipped. */
  isDirty: (path: string) => boolean;
  /** Written: an open tab shows the new text. */
  written: (path: string, text: string, version: string) => void;
}): Promise<ReplaceReport> {
  const report: ReplaceReport = { replaced: 0, files: 0, skipped: [], failed: [] };
  for (const path of paths) {
    if (io.isDirty(path)) { report.skipped.push(path); continue; }
    try {
      const file = await io.read(path);
      if (file.text == null || file.version == null || file.binary || file.tooLarge || file.notUtf8) { report.failed.push(path); continue; }
      const next = replaceText(file.text, q, replacement);
      if (next.count === 0) continue;
      const res = await io.write({ path, text: next.text, baseVersion: file.version });
      io.written(path, next.text, res.version);
      report.replaced += next.count;
      report.files++;
    } catch {
      report.failed.push(path);
    }
  }
  return report;
}
