import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, hunkPatch } from './diff';

const SAMPLE = `diff --git a/a.txt b/a.txt
index 1234567..89abcde 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
-one
+ONE
 two
 three
@@ -10,2 +10,3 @@ context header
 ten
+ten point five
 eleven
`;

describe('parseUnifiedDiff', () => {
  it('parses paths, hunks and line numbers', () => {
    const d = parseUnifiedDiff(SAMPLE);
    expect(d.oldPath).toBe('a.txt');
    expect(d.newPath).toBe('a.txt');
    expect(d.binary).toBe(false);
    expect(d.hunks).toHaveLength(2);

    const h1 = d.hunks[0]!;
    expect(h1).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(h1.lines).toEqual([
      { kind: 'del', oldNo: 1, newNo: null, text: 'one' },
      { kind: 'add', oldNo: null, newNo: 1, text: 'ONE' },
      { kind: 'ctx', oldNo: 2, newNo: 2, text: 'two' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'three' },
    ]);

    const h2 = d.hunks[1]!;
    expect(h2.lines[1]).toEqual({ kind: 'add', oldNo: null, newNo: 11, text: 'ten point five' });
  });

  it('flags binary diffs', () => {
    const d = parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n');
    expect(d.binary).toBe(true);
    expect(d.hunks).toEqual([]);
  });

  it('handles empty input', () => {
    const d = parseUnifiedDiff('');
    expect(d.hunks).toEqual([]);
    expect(d.binary).toBe(false);
  });

  it('parses /dev/null sides (new files)', () => {
    const text = 'diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1,1 @@\n+new\n';
    const d = parseUnifiedDiff(text);
    expect(d.oldPath).toBeNull();
    expect(d.newPath).toBe('b.txt');
    expect(d.hunks[0]!.lines[0]).toEqual({ kind: 'add', oldNo: null, newNo: 1, text: 'new' });
  });
});

// Fixtures shaped like real git output. A blank context line is a single
// space (" ") — the diff marker column followed by empty line content.
const BLANK_CTX_SAMPLE =
  'diff --git a/c.txt b/c.txt\n' +
  'index 1111111..2222222 100644\n' +
  '--- a/c.txt\n' +
  '+++ b/c.txt\n' +
  '@@ -1,3 +1,3 @@\n' +
  ' alpha\n' +
  '-beta\n' +
  '+BETA\n' +
  ' \n'; // blank context line: space then nothing

const NO_NEWLINE_SAMPLE =
  'diff --git a/d.txt b/d.txt\n' +
  'index 3333333..4444444 100644\n' +
  '--- a/d.txt\n' +
  '+++ b/d.txt\n' +
  '@@ -1,1 +1,1 @@\n' +
  '-old\n' +
  '+new\n' +
  '\\ No newline at end of file\n';

describe('parseUnifiedDiff edge cases', () => {
  it('preserves a trailing blank context line (" ") byte-exactly through hunkPatch', () => {
    const d = parseUnifiedDiff(BLANK_CTX_SAMPLE);
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0]!;

    // The blank line is a real context line with empty text.
    expect(h.lines[3]).toEqual({ kind: 'ctx', oldNo: 3, newNo: 3, text: '' });

    // Raw hunk text keeps the " " line verbatim (not dropped, not trimmed).
    expect(h.raw).toBe('@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n ');

    // hunkPatch round-trips the whole patch byte-exactly.
    const p = hunkPatch(d, h);
    expect(p).toBe(BLANK_CTX_SAMPLE);
    expect(p.endsWith(' \n')).toBe(true);
  });

  it('keeps "\\ No newline at end of file" in raw/patch but not in lines', () => {
    const d = parseUnifiedDiff(NO_NEWLINE_SAMPLE);
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0]!;

    // The marker is not a display line.
    expect(h.lines).toEqual([
      { kind: 'del', oldNo: 1, newNo: null, text: 'old' },
      { kind: 'add', oldNo: null, newNo: 1, text: 'new' },
    ]);
    expect(h.lines.some((l) => l.text.includes('No newline'))).toBe(false);

    // The marker is preserved verbatim in the raw hunk and hunkPatch output.
    expect(h.raw).toBe('@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file');
    const p = hunkPatch(d, h);
    expect(p).toBe(NO_NEWLINE_SAMPLE);
    expect(p.endsWith('\\ No newline at end of file\n')).toBe(true);
  });
});

describe('hunkPatch', () => {
  it('rebuilds a single-hunk patch that starts with the file header', () => {
    const d = parseUnifiedDiff(SAMPLE);
    const p = hunkPatch(d, d.hunks[1]!);
    expect(p.startsWith('diff --git a/a.txt b/a.txt')).toBe(true);
    expect(p).toContain('@@ -10,2 +10,3 @@');
    expect(p).not.toContain('@@ -1,3 +1,3 @@');
    expect(p.endsWith('\n')).toBe(true);
  });
});
