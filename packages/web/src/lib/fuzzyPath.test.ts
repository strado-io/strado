import { describe, expect, it } from 'vitest';
import { fuzzyFiles, matchPath } from './fuzzyPath';

describe('matchPath', () => {
  it('a case-insensitive subsequence, with the matched positions', () => {
    expect(matchPath('apts', 'src/app.ts')?.positions).toEqual([4, 5, 8, 9]);
    expect(matchPath('xyz', 'src/app.ts')).toBeNull();
    expect(matchPath('APP', 'src/app.ts')).not.toBeNull();
  });

  it('an empty query matches everything with score 0', () => {
    expect(matchPath('', 'a.ts')).toEqual({ score: 0, positions: [] });
  });
});

describe('fuzzyFiles', () => {
  const files = [
    'packages/web/src/components/files/FilesTab.tsx',
    'packages/web/src/pages/TerminalView.tsx',
    'packages/server/src/routes/files.ts',
    'docs/terminal-view-notes.md',
    'src/tv.ts',
  ];

  it('the file name beats the folders: "tv" ranks src/tv.ts over a path that only spells it out', () => {
    expect(fuzzyFiles('tv', files)[0]!.path).toBe('src/tv.ts');
  });

  it('word starts and runs win: "termview" finds TerminalView first', () => {
    expect(fuzzyFiles('termview', files)[0]!.path).toBe('packages/web/src/pages/TerminalView.tsx');
  });

  it('a slash in the query matches through folders', () => {
    expect(fuzzyFiles('routes/files', files).map((m) => m.path)).toEqual(['packages/server/src/routes/files.ts']);
  });

  it('caps the results; an empty query keeps the given order', () => {
    expect(fuzzyFiles('', files, 2).map((m) => m.path)).toEqual(files.slice(0, 2));
    expect(fuzzyFiles('s', files, 3)).toHaveLength(3);
  });
});
