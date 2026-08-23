import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeRequestsForBranch, createMergeRequest, mergeMergeRequest, invalidateMrCache } from '../../src/services/gitlab';

const mrJson = (over: Record<string, unknown> = {}) => ({
  iid: 412, title: 'T1 FE Safety', state: 'opened', web_url: 'https://gl/mr/412',
  source_branch: 'FD-28207', target_branch: 'master', updated_at: '2026-07-23T10:00:00Z',
  head_pipeline: { status: 'success' }, ...over,
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

describe('mergeRequestsForBranch', () => {
  it('normalizes an open MR and fetches approvals', async () => {
    mockFetchSequence([
      (u) => { expect(u).toContain('source_branch=FD-28207'); return new Response(JSON.stringify([mrJson()]), { status: 200 }); },
      (u) => { expect(u).toContain('/merge_requests/412/approvals'); return new Response(JSON.stringify({ approvals_required: 2, approved_by: [{}] }), { status: 200 }); },
    ]);
    const [mr] = await mergeRequestsForBranch('gitlab.com', 't', 'g/p', 'FD-28207', { force: true });
    expect(mr).toMatchObject({
      number: 412, state: 'open', pipeline: 'success', webUrl: 'https://gl/mr/412',
      sourceBranch: 'FD-28207', targetBranch: 'master', approvals: { given: 1, required: 2 },
    });
  });

  it('maps merged state and does not fetch approvals for it', async () => {
    const fetchMock = mockFetchSequence([
      () => new Response(JSON.stringify([mrJson({ iid: 398, state: 'merged', head_pipeline: null })]), { status: 200 }),
    ]);
    const [mr] = await mergeRequestsForBranch('gitlab.com', 't', 'g/p', 'b1', { force: true });
    expect(mr).toMatchObject({ number: 398, state: 'merged', pipeline: null, approvals: null });
    expect(fetchMock).toHaveBeenCalledTimes(1); // list only, no approvals call
  });

  it('maps an unrecognized state (locked) to closed and does not fetch approvals', async () => {
    const fetchMock = mockFetchSequence([
      () => new Response(JSON.stringify([mrJson({ iid: 501, state: 'locked', head_pipeline: null })]), { status: 200 }),
    ]);
    const [mr] = await mergeRequestsForBranch('gitlab.com', 't', 'g/p', 'b2', { force: true });
    expect(mr).toMatchObject({ number: 501, state: 'closed', pipeline: null, approvals: null });
    expect(fetchMock).toHaveBeenCalledTimes(1); // list only, no approvals call
  });

  it('degrades to approvals:null when the approvals endpoint 404s (CE)', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify([mrJson()]), { status: 200 }),
      () => new Response('not found', { status: 404 }),
    ]);
    const [mr] = await mergeRequestsForBranch('gitlab.com', 't', 'g/p', 'FD-28207', { force: true });
    expect(mr.approvals).toBeNull();
  });

  it('maps a hung request (timeout abort) to a friendly VALIDATION error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(mergeRequestsForBranch('gitlab.example.com', 't', 'g/p', 'b', { force: true }))
      .rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('check your network/VPN'),
      });
  });

  it('returns [] when the branch has no MR', async () => {
    mockFetchSequence([() => new Response('[]', { status: 200 })]);
    expect(await mergeRequestsForBranch('gitlab.com', 't', 'g/p', 'none', { force: true })).toEqual([]);
  });
});

describe('createMergeRequest', () => {
  it('POSTs the MR and maps the response', async () => {
    mockFetchSequence([
      (u) => {
        expect(u).toContain('/projects/g%2Fp/merge_requests');
        return new Response(JSON.stringify(mrJson({ iid: 500, state: 'opened' })), { status: 201 });
      },
    ]);
    const mr = await createMergeRequest('gitlab.com', 't', 'g/p', {
      sourceBranch: 'FD-28207', targetBranch: 'master', title: 'T1 FE Safety', description: 'd',
    });
    expect(mr).toMatchObject({ number: 500, state: 'open', sourceBranch: 'FD-28207', targetBranch: 'master' });
  });

  it('sends source/target/title/description in the body', async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(mrJson()), { status: 201 });
    });
    await createMergeRequest('gitlab.com', 't', 'g/p', {
      sourceBranch: 's', targetBranch: 'master', title: 'T', description: 'D',
    });
    expect(body).toEqual({ source_branch: 's', target_branch: 'master', title: 'T', description: 'D' });
  });

  it('maps 409 (already exists) to VALIDATION with the provider message', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ message: ['Another open merge request already exists'] }), { status: 409 }),
    ]);
    await expect(createMergeRequest('gitlab.com', 't', 'g/p', {
      sourceBranch: 's', targetBranch: 'master', title: 'T',
    })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('already exists') });
  });
});

describe('mergeMergeRequest', () => {
  it('PUTs the merge and maps the merged MR', async () => {
    mockFetchSequence([
      (u) => {
        expect(u).toContain('/projects/g%2Fp/merge_requests/412/merge');
        return new Response(JSON.stringify(mrJson({ state: 'merged' })), { status: 200 });
      },
    ]);
    const mr = await mergeMergeRequest('gitlab.com', 't', 'g/p', 412);
    expect(mr.state).toBe('merged');
  });

  it('maps a 405 refusal to VALIDATION and keeps the message', async () => {
    mockFetchSequence([
      () => new Response(JSON.stringify({ message: 'Branch cannot be merged' }), { status: 405 }),
    ]);
    await expect(mergeMergeRequest('gitlab.com', 't', 'g/p', 412))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('cannot be merged') });
  });

  it('invalidates the list cache for the branch after create', async () => {
    // prime cache
    mockFetchSequence([
      () => new Response(JSON.stringify([mrJson()]), { status: 200 }),
      () => new Response(JSON.stringify({ approvals_required: 0, approved_by: [] }), { status: 200 }),
    ]);
    await mergeRequestsForBranch('gitlab.com', 't', 'g/p', 'FD-28207', { force: true });
    vi.restoreAllMocks();
    const fetchMock = mockFetchSequence([
      () => new Response(JSON.stringify(mrJson()), { status: 201 }),          // create
      () => new Response(JSON.stringify([mrJson()]), { status: 200 }),        // re-list must hit network
      () => new Response(JSON.stringify({ approvals_required: 0, approved_by: [] }), { status: 200 }),
    ]);
    await createMergeRequest('gitlab.com', 't', 'g/p', { sourceBranch: 'FD-28207', targetBranch: 'master', title: 'T' });
    await mergeRequestsForBranch('gitlab.com', 't', 'g/p', 'FD-28207');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // create + fresh list (cache was invalidated)
  });
});
