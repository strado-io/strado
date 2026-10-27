import { describe, expect, it, vi } from 'vitest';
import type { FileContent } from '../../types';
import { replaceInFiles, replaceText } from './replaceInFiles';

const file = (path: string, text: string, extra: Partial<FileContent> = {}): FileContent =>
  ({ path, size: text.length, binary: false, tooLarge: false, text, language: null, version: `v-${path}`, ...extra });

describe('replaceText', () => {
  it('plain: every match, case-insensitive by default, $ taken as typed', () => {
    expect(replaceText('foo Foo food', { q: 'foo' }, '$1x')).toEqual({ text: '$1x $1x $1xd', count: 3 });
  });
  it('case and whole word', () => {
    expect(replaceText('foo Foo food', { q: 'foo', case: true, word: true }, 'bar')).toEqual({ text: 'bar Foo food', count: 1 });
  });
  it('regex: groups and $&', () => {
    expect(replaceText('a=1, b=2', { q: '(\\w)=(\\d)', regex: true }, '$2:$1 [$&] $$')).toEqual({ text: '1:a [a=1] $, 2:b [b=2] $', count: 2 });
  });
  it('an invalid regex replaces nothing', () => {
    expect(replaceText('abc', { q: '(', regex: true }, 'x')).toEqual({ text: 'abc', count: 0 });
  });
});

describe('replaceInFiles', () => {
  it('writes each file at the version it read, skips unsaved ones, reports failures', async () => {
    const files: Record<string, FileContent> = {
      'a.ts': file('a.ts', 'getTime(); getTime();'),
      'b.ts': file('b.ts', 'getTime'),
      'c.ts': file('c.ts', 'getTime'),
      'd.bin': file('d.bin', '', { binary: true, text: undefined }),
      'e.ts': file('e.ts', 'nothing'),
    };
    const write = vi.fn(async (b: { path: string; text: string; baseVersion: string }) => {
      if (b.path === 'c.ts') throw new Error('conflict');
      return { path: b.path, version: `new-${b.path}`, size: b.text.length };
    });
    const written = vi.fn();
    const report = await replaceInFiles(Object.keys(files), { q: 'getTime' }, 'nowTime', {
      read: async (p) => files[p]!, write, isDirty: (p) => p === 'b.ts', written,
    });
    expect(report).toEqual({ replaced: 2, files: 1, skipped: ['b.ts'], failed: ['c.ts', 'd.bin'] });
    expect(write).toHaveBeenCalledWith({ path: 'a.ts', text: 'nowTime(); nowTime();', baseVersion: 'v-a.ts' });
    expect(written).toHaveBeenCalledWith('a.ts', 'nowTime(); nowTime();', 'new-a.ts');
    expect(write).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'e.ts' }));
  });
});
