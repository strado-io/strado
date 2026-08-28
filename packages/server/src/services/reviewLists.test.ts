import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullRequestCountsForProject, pullRequestsForProject } from './github.js';
import { mergeRequestCountsForProject, mergeRequestsForProject } from './gitlab.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('repository-wide code review lists', () => {
  it('lists GitHub PRs without restricting them to a worktree branch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      number: 7,
      title: 'Orphan branch PR',
      state: 'closed',
      merged_at: '2026-08-01T00:00:00Z',
      html_url: 'https://github.com/acme/project/pull/7',
      updated_at: '2026-08-01T00:00:00Z',
      head: { ref: 'fork/feature' },
      base: { ref: 'main' },
    }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const reviews = await pullRequestsForProject('github.com', 'token', 'acme/project-repo-wide-test');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/pulls?state=all');
    expect(url).not.toContain('head=');
    expect(reviews[0]).toMatchObject({ number: 7, sourceBranch: 'fork/feature', state: 'merged' });
  });

  it('lists GitLab MRs without restricting them to a worktree branch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      iid: 11,
      title: 'Removed local worktree',
      state: 'merged',
      web_url: 'https://gitlab.example.com/acme/project/-/merge_requests/11',
      updated_at: '2026-08-02T00:00:00Z',
      source_branch: 'feature/removed',
      target_branch: 'main',
    }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const reviews = await mergeRequestsForProject('gitlab.example.com', 'token', 'acme/project-repo-wide-test');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('merge_requests?state=all');
    expect(url).not.toContain('source_branch=');
    expect(reviews[0]).toMatchObject({ number: 11, sourceBranch: 'feature/removed', state: 'merged' });
  });

  it('reads exact GitLab state totals from pagination headers', async () => {
    const totals: Record<string, string> = { opened: '36', merged: '21020', closed: '977' };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'x-total': totals[state] ?? '0' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const counts = await mergeRequestCountsForProject('gitlab.example.com', 'token', 'acme/counts-test');

    expect(counts).toEqual({ open: 36, merged: 21020, closed: 977 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('still counts GitLab collections above 10,000 when X-Total is omitted', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const parsed = new URL(url);
      const state = parsed.searchParams.get('state') ?? '';
      const perPage = Number(parsed.searchParams.get('per_page'));
      const page = Number(parsed.searchParams.get('page'));
      if (state !== 'merged') {
        const total = state === 'opened' ? '36' : '977';
        return Promise.resolve(new Response('[{}]', { status: 200, headers: { 'x-total': total } }));
      }
      if (perPage === 1) return Promise.resolve(new Response('[{}]', { status: 200 }));
      const size = page <= 210 ? 100 : page === 211 ? 20 : 0;
      return Promise.resolve(new Response(JSON.stringify(Array.from({ length: size }, () => ({}))), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const counts = await mergeRequestCountsForProject('gitlab.example.com', 'token', 'acme/large-counts-test');

    expect(counts).toEqual({ open: 36, merged: 21020, closed: 977 });
    // Logarithmic probes, not 211 sequential page downloads.
    expect(fetchMock.mock.calls.length).toBeLessThan(25);
  });

  it('reads exact GitHub state totals from search counts', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const query = new URL(url).searchParams.get('q') ?? '';
      const total = query.includes('is:merged') ? 80 : query.includes('is:unmerged') ? 9 : 12;
      return Promise.resolve(new Response(JSON.stringify({ total_count: total }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const counts = await pullRequestCountsForProject('github.com', 'token', 'acme/counts-test');

    expect(counts).toEqual({ open: 12, merged: 80, closed: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps GitLab state, page, and search together', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await mergeRequestsForProject('gitlab.example.com', 'token', 'acme/paged-search-test', {
      state: 'merged', page: 3, search: 'vehicle fuel',
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('state')).toBe('merged');
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('per_page')).toBe('20');
    expect(url.searchParams.get('search')).toBe('vehicle fuel');
  });

  it('uses GitHub search across the remote collection, then resolves PR details', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/search/issues')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [{ number: 71 }] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        number: 71, title: 'Remote result', state: 'closed', merged_at: '2026-08-01T00:00:00Z',
        head: { ref: 'feature/remote' }, base: { ref: 'main' },
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const reviews = await pullRequestsForProject('github.com', 'token', 'acme/paged-search-test', {
      state: 'merged', page: 2, search: 'remote result',
    });

    const searchUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(searchUrl.searchParams.get('page')).toBe('2');
    expect(searchUrl.searchParams.get('per_page')).toBe('20');
    expect(searchUrl.searchParams.get('q')).toContain('remote result');
    expect(reviews[0]).toMatchObject({ number: 71, sourceBranch: 'feature/remote', state: 'merged' });
  });
});
