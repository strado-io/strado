import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitChanges as githubCommitChanges, postPullRequestLineComment, postPullRequestReview, pullRequestCommits, pullRequestDiscussion } from './github.js';
import { commitChanges as gitlabCommitChanges, mergeRequestCommits, mergeRequestDiscussion, postMergeRequestLineComment, postMergeRequestReview } from './gitlab.js';

afterEach(() => { vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('review conversations', () => {
  it('merges GitHub issue comments, review verdicts and inline notes into one thread', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/issues/7/comments')) {
        return json([{ id: 1, body: 'ship it', created_at: '2026-08-02T00:00:00Z', user: { login: 'ada' } }]);
      }
      if (u.includes('/pulls/7/reviews')) {
        return json([
          { id: 2, state: 'APPROVED', body: '', submitted_at: '2026-08-03T00:00:00Z', user: { login: 'lin' } },
          // Bodiless COMMENTED review: just the envelope around the inline note.
          { id: 3, state: 'COMMENTED', body: '', submitted_at: '2026-08-04T00:00:00Z', user: { login: 'lin' } },
          { id: 8, state: 'PENDING', body: 'draft', submitted_at: null, user: { login: 'lin' } },
        ]);
      }
      if (u.includes('/pulls/7/comments')) {
        return json([{
          id: 4, body: 'nit: rename', created_at: '2026-08-01T00:00:00Z',
          user: { login: 'sam' }, path: 'src/app.ts', line: 12,
        }]);
      }
      if (u.endsWith('/pulls/7')) return json({ body: 'Why this change exists', head: { sha: 'head7' } });
      throw new Error(`unexpected request: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const discussion = await pullRequestDiscussion('github.com', 'token', 'acme/discussion-github', 7);

    expect(discussion.description).toBe('Why this change exists');
    expect(discussion.anchor).toEqual({ headSha: 'head7', baseSha: null, startSha: null });
    expect(discussion.comments.map((c) => [c.author, c.kind, c.path, c.line])).toEqual([
      ['sam', 'comment', 'src/app.ts', 12],
      ['ada', 'comment', null, null],
      ['lin', 'approved', null, null],
    ]);
  });

  it('keeps GitLab system notes out of the conversation', async () => {
    const webUrl = 'https://gitlab.example.com/acme/project/-/merge_requests/11';
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/notes')) {
        return json([
          { id: 1, body: 'assigned to @kamlesh', system: true, created_at: '2026-08-01T00:00:00Z', author: { name: 'bot' } },
          {
            id: 2, body: 'looks good', system: false, created_at: '2026-08-02T00:00:00Z',
            author: { name: 'Ada Lovelace' }, position: { new_path: 'src/a.ts', new_line: 3 },
          },
        ]);
      }
      return json({
        description: 'MR body', web_url: webUrl,
        diff_refs: { base_sha: 'base1', head_sha: 'head1', start_sha: 'start1' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const discussion = await mergeRequestDiscussion('gitlab.example.com', 'token', 'acme/discussion-gitlab', 11);

    expect(discussion.description).toBe('MR body');
    expect(discussion.anchor).toEqual({ headSha: 'head1', baseSha: 'base1', startSha: 'start1' });
    expect(discussion.comments).toEqual([{
      id: '2',
      author: 'Ada Lovelace',
      body: 'looks good',
      createdAt: '2026-08-02T00:00:00Z',
      path: 'src/a.ts',
      line: 3,
      side: 'new',
      kind: 'comment',
      webUrl: `${webUrl}#note_2`,
    }]);
  });

  it('reports an empty description rather than a blank body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
      String(url).includes('/notes') ? json([]) : json({ description: '   ', web_url: 'https://g/x' })));

    const discussion = await mergeRequestDiscussion('gitlab.example.com', 'token', 'acme/discussion-blank', 12);
    expect(discussion.description).toBeNull();
    expect(discussion.comments).toEqual([]);
  });

  it('sends a GitHub comment to the issue thread and a verdict to the reviews API', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await postPullRequestReview('github.com', 'token', 'acme/post', 7, { body: 'a note', event: 'comment' });
    await postPullRequestReview('github.com', 'token', 'acme/post', 7, { body: '', event: 'approve' });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/issues/7/comments');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ body: 'a note' });
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/pulls/7/reviews');
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ body: '', event: 'APPROVE' });
  });

  it('relays GitHub\u2019s reason when it refuses a review', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Can not approve your own pull request' }), { status: 422 },
    )));

    await expect(postPullRequestReview('github.com', 'token', 'acme/post', 8, { body: '', event: 'approve' }))
      .rejects.toThrow('Can not approve your own pull request');
  });

  it('approves then posts the note, and refuses request-changes outright', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await postMergeRequestReview('gitlab.example.com', 'token', 'acme/post', 11, { body: 'ok by me', event: 'approve' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/merge_requests/11/approve');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/merge_requests/11/notes');

    await expect(postMergeRequestReview('gitlab.example.com', 'token', 'acme/post', 11, { body: 'no', event: 'request-changes' }))
      .rejects.toThrow(/no .request changes. verdict/);
  });

  it('explains a GitLab instance without approvals rather than a bare 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));

    await expect(postMergeRequestReview('gitlab.example.com', 'token', 'acme/post', 12, { body: '', event: 'approve' }))
      .rejects.toThrow('This GitLab instance does not offer merge request approvals');
  });

  it('reduces provider commit shapes to a subject, author and short sha', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([{
      sha: 'aaaaaaaabbbbccccdddd',
      html_url: 'https://github.com/acme/p/commit/aaaaaaaabbbbccccdddd',
      commit: { message: 'fix: reconnect\n\nlonger body', author: { name: 'Ada', date: '2026-08-01T00:00:00Z' } },
      author: { login: 'ada' },
    }])));
    const [github] = await pullRequestCommits('github.com', 'token', 'acme/commits-github', 7);
    expect(github).toEqual({
      sha: 'aaaaaaaabbbbccccdddd',
      shortSha: 'aaaaaaaa',
      title: 'fix: reconnect',
      author: 'ada',
      createdAt: '2026-08-01T00:00:00Z',
      webUrl: 'https://github.com/acme/p/commit/aaaaaaaabbbbccccdddd',
    });

    vi.stubGlobal('fetch', vi.fn(async () => json([{
      id: 'ffffffff11112222', short_id: 'ffffffff', title: 'chore: bump',
      author_name: 'Lin', created_at: '2026-08-02T00:00:00Z', web_url: 'https://gitlab/x/-/commit/ffffffff11112222',
    }])));
    const [gitlab] = await mergeRequestCommits('gitlab.example.com', 'token', 'acme/commits-gitlab', 11);
    expect(gitlab).toMatchObject({ shortSha: 'ffffffff', title: 'chore: bump', author: 'Lin' });
  });

  it('reads a single commit\u2019s diff in the same shape as the review-wide changes', async () => {
    const githubFetch = vi.fn(async (..._args: unknown[]) => json({
      files: [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\\n-a\\n+b' }],
    }));
    vi.stubGlobal('fetch', githubFetch);
    const github = await githubCommitChanges('github.com', 'token', 'acme/commit-diff-gh', 'aaaaaaa');
    expect(String(githubFetch.mock.calls[0]![0])).toContain('/repos/acme/commit-diff-gh/commits/aaaaaaa');
    expect(github).toEqual([{ path: 'src/a.ts', oldPath: undefined, status: 'M', diff: '@@ -1 +1 @@\\n-a\\n+b', truncated: undefined }]);

    const gitlabFetch = vi.fn(async (..._args: unknown[]) => json([
      { new_path: 'src/b.ts', old_path: 'src/b.ts', diff: '@@ -1 +1 @@\\n-a\\n+b' },
    ]));
    vi.stubGlobal('fetch', gitlabFetch);
    const gitlab = await gitlabCommitChanges('gitlab.example.com', 'token', 'acme/commit-diff-gl', 'bbbbbbb');
    expect(String(gitlabFetch.mock.calls[0]![0])).toContain('/repository/commits/bbbbbbb/diff');
    expect(gitlab[0]).toMatchObject({ path: 'src/b.ts', status: 'M' });
  });

  it('pins a line comment to the provider position each API demands', async () => {
    const githubFetch = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', githubFetch);
    await postPullRequestLineComment(
      'github.com', 'token', 'acme/line', 7,
      { body: 'nit', path: 'src/a.ts', line: 12, side: 'new' },
      { headSha: 'head7', baseSha: null, startSha: null },
    );
    expect(String(githubFetch.mock.calls[0]![0])).toContain('/pulls/7/comments');
    expect(JSON.parse(String((githubFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      body: 'nit', commit_id: 'head7', path: 'src/a.ts', line: 12, side: 'RIGHT',
    });

    const gitlabFetch = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', gitlabFetch);
    await postMergeRequestLineComment(
      'gitlab.example.com', 'token', 'acme/line', 11,
      { body: 'nit', path: 'src/a.ts', line: 12, side: 'old' },
      { headSha: 'head1', baseSha: 'base1', startSha: 'start1' },
    );
    expect(String(gitlabFetch.mock.calls[0]![0])).toContain('/merge_requests/11/discussions');
    const posted = JSON.parse(String((gitlabFetch.mock.calls[0]![1] as RequestInit).body));
    expect(posted.position).toMatchObject({
      position_type: 'text', base_sha: 'base1', start_sha: 'start1', head_sha: 'head1',
      new_path: 'src/a.ts', old_path: 'src/a.ts', old_line: 12,
    });
    expect(posted.position.new_line).toBeUndefined();
  });

  it('explains a line the provider will not accept', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'line must be part of the diff' }), { status: 422 },
    )));
    await expect(postPullRequestLineComment(
      'github.com', 'token', 'acme/line', 8,
      { body: 'nit', path: 'src/a.ts', line: 999, side: 'new' },
      { headSha: 'head7', baseSha: null, startSha: null },
    )).rejects.toThrow('line must be part of the diff');
  });

  it('names the permission GitHub wanted instead of asking for a reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Resource not accessible by personal access token' }),
      { status: 403, headers: { 'x-accepted-github-permissions': 'pull_requests=write' } },
    )));

    await expect(postPullRequestReview('github.com', 'token', 'acme/forbidden', 7, { body: 'hi', event: 'comment' }))
      .rejects.toThrow(/needs "pull_requests=write"/);
    // Not an AuthError: a read-only token is working fine, it just cannot write.
    await expect(postPullRequestReview('github.com', 'token', 'acme/forbidden', 7, { body: 'hi', event: 'comment' }))
      .rejects.toThrow(/Resource not accessible/);
  });

  it('calls a GitHub rate limit a rate limit', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    })));

    await expect(postPullRequestReview('github.com', 'token', 'acme/limited', 7, { body: 'hi', event: 'comment' }))
      .rejects.toThrow(/rate limit reached — try again in about 10 min/);
  });

  it('points a GitLab write refusal at the api scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: '403 Forbidden' }), { status: 403 })));

    await expect(postMergeRequestLineComment(
      'gitlab.example.com', 'token', 'acme/forbidden', 11,
      { body: 'nit', path: 'src/a.ts', line: 3, side: 'new' },
      { headSha: 'head1', baseSha: 'base1', startSha: 'start1' },
    )).rejects.toThrow(/"api" scope/);
  });

  it('approves before commenting, so a refused approval leaves no orphan note', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ message: '403 Forbidden' }), { status: 403 });
    }));

    await expect(postMergeRequestReview(
      'gitlab.example.com', 'token', 'acme/order', 11, { body: 'looks good', event: 'approve' },
    )).rejects.toThrow(/"api" scope/);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/approve');
    expect(calls.some((url) => url.includes('/notes'))).toBe(false);
  });

  it('keeps a renamed file\u2019s old path in the GitLab position', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await postMergeRequestLineComment(
      'gitlab.example.com', 'token', 'acme/rename', 11,
      { body: 'nit', path: 'src/new.ts', oldPath: 'src/old.ts', line: 3, side: 'new' },
      { headSha: 'head1', baseSha: 'base1', startSha: 'start1' },
    );

    const posted = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(posted.position).toMatchObject({ new_path: 'src/new.ts', old_path: 'src/old.ts' });
  });

  it('namespaces comment ids so issue and review ids cannot collide', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      // The same numeric id in both lists — independent GitHub sequences.
      if (u.includes('/issues/9/comments')) {
        return json([{ id: 5, body: 'general', created_at: '2026-08-02T00:00:00Z', user: { login: 'ada' } }]);
      }
      if (u.includes('/pulls/9/reviews')) return json([]);
      if (u.includes('/pulls/9/comments')) {
        return json([{ id: 5, body: 'inline', created_at: '2026-08-01T00:00:00Z', user: { login: 'sam' }, path: 'a.ts', line: 1 }]);
      }
      return json({ body: null, head: { sha: 'head9' } });
    }));

    const { comments } = await pullRequestDiscussion('github.com', 'token', 'acme/ids', 9);
    expect(comments).toHaveLength(2);
    expect(new Set(comments.map((c) => c.id)).size).toBe(2);
  });
});
