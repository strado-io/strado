import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergePullRequest, pullRequestCountsForProject, pullRequestsForProject } from './github.js';
import { mergeRequestCountsForProject, mergeRequestsForProject, postMergeRequestReview } from './gitlab.js';

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

  it('does not reuse a shorter GitHub window when aggregate pagination grows', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const size = Number(new URL(url).searchParams.get('per_page'));
      return Promise.resolve(new Response(JSON.stringify(Array.from({ length: size }, (_, index) => ({
        number: index + 1,
        title: `PR ${index + 1}`,
        state: 'open',
        updated_at: '2026-08-01T00:00:00Z',
        head: { ref: `feature/${index + 1}` },
      }))), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await pullRequestsForProject('github.com', 'token', 'acme/window-cache-github', {
      state: 'open', page: 1, limit: 20,
    });
    const grown = await pullRequestsForProject('github.com', 'token', 'acme/window-cache-github', {
      state: 'open', page: 1, limit: 40,
    });

    expect(first).toHaveLength(20);
    expect(grown).toHaveLength(40);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a shorter GitLab window when aggregate pagination grows', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const size = Number(new URL(url).searchParams.get('per_page'));
      return Promise.resolve(new Response(JSON.stringify(Array.from({ length: size }, (_, index) => ({
        iid: index + 1,
        title: `MR ${index + 1}`,
        state: 'merged',
        updated_at: '2026-08-01T00:00:00Z',
        source_branch: `feature/${index + 1}`,
      }))), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await mergeRequestsForProject('gitlab.example.com', 'token', 'acme/window-cache-gitlab', {
      state: 'merged', page: 1, limit: 20,
    });
    const grown = await mergeRequestsForProject('gitlab.example.com', 'token', 'acme/window-cache-gitlab', {
      state: 'merged', page: 1, limit: 40,
    });

    expect(first).toHaveLength(20);
    expect(grown).toHaveLength(40);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates the GitHub project inbox immediately after a merge', async () => {
    let merged = false;
    let listCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/merge') && init?.method === 'PUT') {
        merged = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (url.includes('/pulls?')) {
        listCalls += 1;
        return Promise.resolve(new Response(JSON.stringify(merged ? [] : [{
          number: 1, title: 'Open before merge', state: 'open', updated_at: '2026-08-01T00:00:00Z',
          head: { ref: 'feature/merge' },
        }]), { status: 200 }));
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await pullRequestsForProject('github.com', 'token', 'acme/invalidate-merge', { state: 'open' })).toHaveLength(1);
    await mergePullRequest('github.com', 'token', 'acme/invalidate-merge', 1);
    expect(await pullRequestsForProject('github.com', 'token', 'acme/invalidate-merge', { state: 'open' })).toHaveLength(0);
    expect(listCalls).toBe(2);
  });

  it('invalidates GitLab approval chips immediately after approval', async () => {
    let approved = false;
    let listCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/approve') && init?.method === 'POST') {
        approved = true;
        return Promise.resolve(new Response('{}', { status: 201 }));
      }
      if (url.endsWith('/approvals')) {
        return Promise.resolve(new Response(JSON.stringify({
          approvals_required: 1, approved_by: approved ? [{}] : [],
        }), { status: 200 }));
      }
      if (url.includes('/merge_requests?')) {
        listCalls += 1;
        return Promise.resolve(new Response(JSON.stringify([{
          iid: 1, title: 'Approve me', state: 'opened', updated_at: '2026-08-01T00:00:00Z',
          source_branch: 'feature/approve',
        }]), { status: 200 }));
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = await mergeRequestsForProject('gitlab.example.com', 'token', 'acme/invalidate-approve', { state: 'open' });
    await postMergeRequestReview('gitlab.example.com', 'token', 'acme/invalidate-approve', 1, { body: '', event: 'approve' });
    const after = await mergeRequestsForProject('gitlab.example.com', 'token', 'acme/invalidate-approve', { state: 'open' });

    expect(before[0]?.approvals?.given).toBe(0);
    expect(after[0]?.approvals?.given).toBe(1);
    expect(listCalls).toBe(2);
  });
});
