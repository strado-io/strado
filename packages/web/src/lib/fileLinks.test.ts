import { describe, expect, it } from 'vitest';
import { findFileLinks } from './fileLinks';

const ROOT = '/Users/me/wt/app';
const pick = (text: string, files?: Set<string>) =>
  findFileLinks(text, { root: ROOT, files }).map(({ path, line, col, text: t }) => ({ path, line, col, text: t }));

describe('findFileLinks', () => {
  it('a relative path with a line, and with a line and column', () => {
    expect(pick('error in src/app.ts:42 here')).toEqual([{ path: 'src/app.ts', line: 42, col: undefined, text: 'src/app.ts:42' }]);
    expect(pick('src/app.ts:42:7 - error TS2322')).toEqual([{ path: 'src/app.ts', line: 42, col: 7, text: 'src/app.ts:42:7' }]);
  });

  it('the TypeScript (line,col) form', () => {
    expect(pick('src/app.ts(12,5): error')).toEqual([{ path: 'src/app.ts', line: 12, col: 5, text: 'src/app.ts(12,5)' }]);
  });

  it('a bare file name with an extension, no line', () => {
    expect(pick('Updated README.md and package.json.')).toEqual([
      { path: 'README.md', line: undefined, col: undefined, text: 'README.md' },
      { path: 'package.json', line: undefined, col: undefined, text: 'package.json' },
    ]);
  });

  it('start/end are columns in the line, covering the link text exactly', () => {
    const text = '  at fn (src/a.ts:3:1)';
    const [l] = findFileLinks(text, { root: ROOT });
    expect(text.slice(l!.start, l!.end)).toBe('src/a.ts:3:1');
  });

  it('./ is dropped; an absolute path inside the worktree becomes relative; one outside is no link', () => {
    expect(pick('./src/a.ts:1').map((l) => l.path)).toEqual(['src/a.ts']);
    expect(pick(`${ROOT}/src/a.ts:9`)).toEqual([{ path: 'src/a.ts', line: 9, col: undefined, text: `${ROOT}/src/a.ts:9` }]);
    expect(pick('/etc/hosts.conf:1')).toEqual([]);
    expect(pick('/Users/me/wt/app-other/src/a.ts')).toEqual([]);
  });

  it('never a URL, a version number, or a path that climbs out', () => {
    expect(pick('see https://example.com/docs/a.html and v1.2.3')).toEqual([]);
    expect(pick('../secrets/key.pem:1')).toEqual([]);
    expect(pick('src/../../x.ts')).toEqual([]);
  });

  it('with the worktree file list: only files that exist, trying git diff a/ b/ prefixes', () => {
    const files = new Set(['src/app.ts', 'README.md']);
    expect(pick('--- a/src/app.ts\n', files).map((l) => l.path)).toEqual(['src/app.ts']);
    expect(pick('src/app.ts:4 and src/gone.ts:5 and e.g. foo.bar', files).map((l) => l.path)).toEqual(['src/app.ts']);
  });

  it('a line number of 0 or absurdly large is dropped, the path kept', () => {
    expect(pick('src/a.ts:0')).toEqual([{ path: 'src/a.ts', line: undefined, col: undefined, text: 'src/a.ts' }]);
  });
});
