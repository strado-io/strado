import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullRequestsForBranch, createPullRequest, mergePullRequest } from '../../src/services/github';
import { AuthError } from '../../src/errors';

const prJson = (over: Record<string, unknown> = {}) => ({
  number: 42, title: 'Add export', state: 'open', merged_at: null,
  html_url: 'https://github.com/o/r/pull/42',
  head: { ref: 'FD-1', sha: 'abc123' }, base: { ref: 'main' },
  updated_at: '2026-07-24T10:00:00Z',
  ...over,
});

function mockFetchSequence(handlers: Array<(url: string) => Response>) {
  let i = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    return handlers[Math.min(i++, handlers.length - 1)](url);
  });
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe('pullRequestsForBranch', () => {
  it('lists PRs by owner-qualified head and maps an open PR with passing checks', async () => {
    mockFetchSequence([
      (u) => {
        expect(u).toContain('/repos/octo/app/pulls?');
        expect(u).toContain(`head=${encodeURIComponent('octo:FD-1')}`);
        expect(u).toContain('state=all');
        return new Response(JSON.stringify([prJson()]), { status: 200 });
      },
      (u) => {
        expect(u).toContain('/repos/octo/app/commits/abc123/check-runs');
        return new Response(JSON.stringify({
          check_runs: [{ status: 'completed', conclusion: 'success' }],
        }), { status: 200 });
      },
    ]);
    const [pr] = await pullRequestsForBranch('github.com', 't', 'octo/app', 'FD-1', { force: true });
    expect(pr).toMatchObject({
      number: 42, title: 'Add export', state: 'open', pipeline: 'success',
      webUrl: 'https://github.com/o/r/pull/42', approvals: null,
      sourceBranch: 'FD-1', targetBranch: 'main', updatedAt: '2026-07-24T10:00:00Z',
    });
  });

  it('maps a hung request (timeout abort) to a friendly VALIDATION error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(pullRequestsForBranch('github.com', 't', 'octo/app', 'b', { force: true }))
      .rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('check your network/VPN'),
      });
  });

  it('maps merged (via merged_at) and closed states; no check-runs call for them', async () => {
    const fetchMock = mockFetchSequence([
      () => new Response(JSON.stringify([
        prJson({ number: 1, state: 'closed', merged_at: '2026-07-01T00:00:00Z' }),
        prJson({ number: 2, state: 'closed', updated_at: '2026-07-02T00:00:00Z' }),
      ]), { status: 200 }),
    ]);
    const prs = await pullRequestsForBranch('github.com', 't', 'octo/app', 'b', { force: true });
    expect(prs.find((p) => p.number === 1)?.state).toBe('merged');
    expect(prs.find((p) => p.number === 2)?.state).toBe('closed');
    expect(prs.every((p) => p.pipeline === null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aggregates check runs: any failure wins, else any running, else success, empty → null', async () => {
    const run = (status: string, conclusion: string | null) => ({ status, conclusion });
    const cases: Array<{ runs: unknown[]; want: string | null }> = [
      { runs: [run('completed', 'success'), run('completed', 'failure')], want: 'failed' },
      { runs: [run('in_progress', null), run('completed', 'success')], want: 'running' },
      { runs: [run('queued', null)], want: 'running' },
      { runs: [run('completed', 'cancelled')], want: 'canceled' },
      { runs: [run('completed', 'startup_failure')], want: 'failed' },
      { runs: [run('completed', 'success'), run('completed', 'neutral'), run('completed', 'skipped')], want: 'success' },
      { runs: [], want: null },
    ];
    for (const c of cases) {
      mockFetchSequence([
        () => new Response(JSON.stringify([prJson()]), { status: 200 }),
        () => new Response(JSON.stringify({ check_runs: c.runs }), { status: 200 }),
      ]);
      const [pr] = await pullRequestsForBranch('github.com', 't', 'octo/app', 'FD-1', { force: true });
      expect(pr.pipeline).toBe(c.want);
      vi.restoreAllMocks();
    }
  });

  it('degrades pipeline to null when the check-runs call fails', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify([prJson()]), { status: 200 }),
      () => new Response('', { status: 500 }),
    ]);
    const [pr] = await pullRequestsForBranch('github.com', 't', 'octo/app', 'FD-1', { force: true });
    expect(pr.pipeline).toBeNull();
  });

  it('sorts open first, then most recently updated', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify([
        prJson({ number: 1, state: 'closed', updated_at: '2026-07-03T00:00:00Z' }),
        prJson({ number: 2, state: 'open', head: { ref: 'b', sha: 's2' }, updated_at: '2026-07-01T00:00:00Z' }),
      ]), { status: 200 }),
      () => new Response(JSON.stringify({ check_runs: [] }), { status: 200 }),
    ]);
    const prs = await pullRequestsForBranch('github.com', 't', 'octo/app', 'b', { force: true });
    expect(prs.map((p) => p.number)).toEqual([2, 1]);
  });

  it('throws VALIDATION on 401 so routes can map it to needsAuth', async () => {
    mockFetchSequence([() => new Response('', { status: 401 })]);
    await expect(
      pullRequestsForBranch('github.com', 'bad', 'octo/app', 'b', { force: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('maps a 404 (token cannot see the repo) to VALIDATION', async () => {
    mockFetchSequence([() => new Response('', { status: 404 })]);
    await expect(
      pullRequestsForBranch('github.com', 't', 'octo/app', 'b', { force: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('throws AuthError (not plain AppError) on 401 and on 404', async () => {
    mockFetchSequence([() => new Response('', { status: 401 })]);
    await expect(pullRequestsForBranch('github.com', 't', 'o/r', 'b', { force: true }))
      .rejects.toBeInstanceOf(AuthError);
    vi.restoreAllMocks();
    mockFetchSequence([() => new Response('', { status: 404 })]);
    await expect(pullRequestsForBranch('github.com', 't', 'o/r', 'b2', { force: true }))
      .rejects.toBeInstanceOf(AuthError);
  });
});

describe('createPullRequest', () => {
  it('POSTs head owner:branch / base and maps the response', async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u, init) => {
      expect(String(u)).toContain('/repos/octo/app/pulls');
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(prJson({ number: 77 })), { status: 201 });
    });
    const pr = await createPullRequest('github.com', 't', 'octo/app', {
      sourceBranch: 'FD-1', targetBranch: 'main', title: 'T', description: 'D',
    });
    expect(body).toEqual({ title: 'T', head: 'octo:FD-1', base: 'main', body: 'D' });
    expect(pr).toMatchObject({ number: 77, state: 'open', targetBranch: 'main' });
  });

  it('maps 422 to VALIDATION with GitHub’s first error message', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({
        message: 'Validation Failed',
        errors: [{ message: 'A pull request already exists for octo:FD-1.' }],
      }), { status: 422 }),
    ]);
    await expect(createPullRequest('github.com', 't', 'octo/app', {
      sourceBranch: 'FD-1', targetBranch: 'main', title: 'T',
    })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('already exists') });
  });

  it('maps 404 to AuthError', async () => {
    mockFetchSequence([() => new Response('', { status: 404 })]);
    await expect(createPullRequest('github.com', 't', 'octo/app', {
      sourceBranch: 'b', targetBranch: 'main', title: 'T',
    })).rejects.toBeInstanceOf(AuthError);
  });
});

describe('mergePullRequest', () => {
  it('PUTs the merge and resolves on success', async () => {
    mockFetchSequence([
      (u) => {
        expect(u).toContain('/repos/octo/app/pulls/77/merge');
        return new Response(JSON.stringify({ merged: true }), { status: 200 });
      },
    ]);
    await expect(mergePullRequest('github.com', 't', 'octo/app', 77)).resolves.toBeUndefined();
  });

  it('maps 405/409 to VALIDATION keeping GitHub’s message', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ message: 'Pull Request is not mergeable' }), { status: 405 }),
    ]);
    await expect(mergePullRequest('github.com', 't', 'octo/app', 77))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('not mergeable') });
  });

  it('invalidates the list cache for the branch after create', async () => {
    // prime cache: list (open PR) + check-runs
    mockFetchSequence([
      () => new Response(JSON.stringify([prJson()]), { status: 200 }),
      () => new Response(JSON.stringify({ check_runs: [] }), { status: 200 }),
    ]);
    await pullRequestsForBranch('github.com', 't', 'octo/app', 'FD-1', { force: true });
    vi.restoreAllMocks();
    const fetchMock = mockFetchSequence([
      () => new Response(JSON.stringify(prJson({ number: 77 })), { status: 201 }), // create
      () => new Response(JSON.stringify([prJson({ number: 77 })]), { status: 200 }), // re-list must hit network
      () => new Response(JSON.stringify({ check_runs: [] }), { status: 200 }),
    ]);
    await createPullRequest('github.com', 't', 'octo/app', {
      sourceBranch: 'FD-1', targetBranch: 'main', title: 'T',
    });
    await pullRequestsForBranch('github.com', 't', 'octo/app', 'FD-1');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // create + fresh list (cache was invalidated)
  });
});
