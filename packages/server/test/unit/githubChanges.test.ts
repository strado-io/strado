import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullRequestChanges } from '../../src/services/github';

afterEach(() => vi.restoreAllMocks());

describe('pullRequestChanges', () => {
  it('maps files: statuses, rename oldPath, patch, missing patch → truncated', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = String(input);
      if (!u.includes('/files')) return new Response(JSON.stringify({ changed_files: 5 }), { status: 200 });
      expect(u).toContain('/repos/octo/app/pulls/42/files');
      expect(u).toContain('per_page=100');
      return new Response(JSON.stringify([
        { filename: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' },
        { filename: 'src/mod.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
        { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-x' },
        { filename: 'src/b.ts', status: 'renamed', previous_filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' },
        { filename: 'assets/logo.png', status: 'modified' }, // binary/huge: no patch
      ]), { status: 200 });
    });
    const { files, truncated, total } = await pullRequestChanges('github.com', 't', 'octo/app', 42);
    expect(files).toEqual([
      { path: 'src/new.ts', oldPath: undefined, status: 'A', diff: '@@ -0,0 +1 @@\n+x', truncated: undefined },
      { path: 'src/mod.ts', oldPath: undefined, status: 'M', diff: '@@ -1 +1 @@\n-x\n+y', truncated: undefined },
      { path: 'src/gone.ts', oldPath: undefined, status: 'D', diff: '@@ -1 +0,0 @@\n-x', truncated: undefined },
      { path: 'src/b.ts', oldPath: 'src/a.ts', status: 'R', diff: '@@ -1 +1 @@\n-a\n+b', truncated: undefined },
      { path: 'assets/logo.png', oldPath: undefined, status: 'M', diff: '', truncated: true },
    ]);
    expect({ truncated, total }).toEqual({ truncated: false, total: 5 });
  });

  it('throws SHELL_FAILED on a non-auth API error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }));
    await expect(pullRequestChanges('github.com', 't', 'octo/app', 1)).rejects.toMatchObject({
      code: 'SHELL_FAILED',
    });
  });

  it('maps a 404 to VALIDATION (needsAuth flow), not SHELL_FAILED', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    await expect(pullRequestChanges('github.com', 't', 'octo/app', 7)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('fetches every available file page instead of stopping at 100', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/files')) {
        return new Response(JSON.stringify({ changed_files: 101 }), { status: 200 });
      }
      const page = Number(url.searchParams.get('page'));
      const size = page === 1 ? 100 : 1;
      return new Response(JSON.stringify(Array.from({ length: size }, (_, index) => ({
        filename: `src/${page}-${index}.ts`, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b',
      }))), { status: 200 });
    });

    const result = await pullRequestChanges('github.com', 't', 'octo/paged-files', 99);

    expect(result.files).toHaveLength(101);
    expect(result).toMatchObject({ truncated: false, total: 101 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // detail + two file pages
  });
});
