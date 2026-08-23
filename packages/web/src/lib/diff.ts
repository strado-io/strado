export type DiffLine = { kind: 'ctx' | 'add' | 'del'; oldNo: number | null; newNo: number | null; text: string };
export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  raw: string;
};
export type ParsedDiff = {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  fileHeader: string;
  hunks: DiffHunk[];
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPathPrefix(path: string): string | null {
  if (path === '/dev/null') return null;
  return path.replace(/^[ab]\//, '');
}

/**
 * Split `text` into lines the way a unified diff needs: each line keeps its
 * content without the trailing `\n`, and a final trailing `\n` in the input
 * does NOT produce a spurious empty trailing element (unlike a bare
 * `split('\n')`, which turns "a\nb\n" into ["a", "b", ""]).
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split('\n');
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = splitLines(text);
  const result: ParsedDiff = { oldPath: null, newPath: null, binary: false, fileHeader: '', hunks: [] };

  let i = 0;
  const headerLines: string[] = [];

  // File header: everything up to the first hunk (or end of input).
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (HUNK_RE.test(line)) break;
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) result.binary = true;
    if (line.startsWith('--- ')) result.oldPath = stripPathPrefix(line.slice(4));
    if (line.startsWith('+++ ')) result.newPath = stripPathPrefix(line.slice(4));
    headerLines.push(line);
  }
  result.fileHeader = headerLines.join('\n');

  while (i < lines.length) {
    const m = lines[i]!.match(HUNK_RE);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);

    const rawLines: string[] = [lines[i]!];
    const hunkLines: DiffLine[] = [];
    let oldNo = oldStart;
    let newNo = newStart;
    i++;

    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (HUNK_RE.test(line) || line.startsWith('diff --git')) break;

      const marker = line.charAt(0);
      // A body line always starts with one of ' ', '+', '-', '\'. A blank
      // line in the source diff (e.g. context representing an empty file
      // line) shows up here as an empty string with no marker at all — that
      // still belongs to the hunk and is a context line with empty text.
      if (marker === '+') {
        hunkLines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
      } else if (marker === '-') {
        hunkLines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
      } else if (marker === ' ') {
        hunkLines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
      } else if (marker === '\\') {
        // "\ No newline at end of file" — part of the raw patch, not a display line.
      } else if (line === '') {
        hunkLines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: '' });
      } else {
        break;
      }
      rawLines.push(line);
    }

    result.hunks.push({
      header: rawLines[0]!,
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      lines: hunkLines,
      raw: rawLines.join('\n'),
    });
  }

  return result;
}

export function hunkPatch(diff: ParsedDiff, hunk: DiffHunk): string {
  const patch = `${diff.fileHeader}\n${hunk.raw}`;
  return patch.endsWith('\n') ? patch : `${patch}\n`;
}
