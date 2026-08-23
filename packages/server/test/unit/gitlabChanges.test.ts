import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeRequestChanges } from '../../src/services/gitlab';

const change = (over = {}) => ({
  old_path: 'src/a.ts', new_path: 'src/a.ts',
  new_file: false, deleted_file: false, renamed_file: false,
  diff: '@@ -1 +1 @@\n-old\n+new\n', ...over,
});
function mockFetch(handler: (url: string) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => handler(String(input)));
}
beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe('mergeRequestChanges', () => {
  it('normalizes A/M/D/R and passes the diff through', async () => {
    mockFetch((u) => {
      expect(u).toContain('/merge_requests/412/changes');
      return new Response(JSON.stringify({ changes: [
        change(),                                                        // M
        change({ new_file: true, old_path: 'src/n.ts', new_path: 'src/n.ts' }),   // A
        change({ deleted_file: true }),                                  // D
        change({ renamed_file: true, old_path: 'src/old.ts', new_path: 'src/new.ts' }), // R
      ] }), { status: 200 });
    });
    const files = await mergeRequestChanges('gitlab.com', 't', 'g/p', 412);
    expect(files.map((f) => f.status)).toEqual(['M', 'A', 'D', 'R']);
    expect(files[3]).toMatchObject({ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'R' });
    expect(files[0].diff).toContain('+new');
  });

  it('flags truncated when a non-add file has no diff', async () => {
    mockFetch(() => new Response(JSON.stringify({ changes: [change({ diff: '' })] }), { status: 200 }));
    const files = await mergeRequestChanges('gitlab.com', 't', 'g/p', 1);
    expect(files[0].truncated).toBe(true);
  });

  it('returns [] when there are no changes', async () => {
    mockFetch(() => new Response(JSON.stringify({ changes: [] }), { status: 200 }));
    expect(await mergeRequestChanges('gitlab.com', 't', 'g/p', 2)).toEqual([]);
  });
});
