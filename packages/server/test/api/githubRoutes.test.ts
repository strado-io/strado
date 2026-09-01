import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';
import { AppError } from '../../src/errors';

// Wraps the real pullRequestsForBranch so a single test can override its
// resolution (mockRejectedValueOnce) without disturbing the other tests in
// this file, which exercise the real implementation via a stubbed fetch.
vi.mock('../../src/services/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/github.js')>();
  return { ...actual, pullRequestsForBranch: vi.fn(actual.pullRequestsForBranch) };
});
import { pullRequestsForBranch } from '../../src/services/github';

let tmp: string;
let repo: string;
let worktreesDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

// Builds a real temp git repo (with a commit, a branch, and an `origin`
// remote) plus a registered app + workspace so the route's `originUrl` /
// `currentBranch` helpers see real git state — only `globalThis.fetch`
// (the GitHub API call) is mocked per-test.
async function setupRepo(remoteUrl: string, branch = 'feature-x') {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-gh-')));
  repo = path.join(tmp, 'repo');
  worktreesDir = path.join(tmp, 'home', 'worktrees', 'react-app');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'pkg.json'), '{}');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });
  await exec('git', ['checkout', '-q', '-b', branch], { cwd: repo });
  await exec('git', ['remote', 'add', 'origin', remoteUrl], { cwd: repo });

  // GitHub credentials live under STRADO_HOME, independent of the
  // workspace's homeStateDir — isolate it per test so config doesn't leak.
  process.env.STRADO_HOME = path.join(tmp, 'strado-home');

  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  app = await buildApp(deps);

  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'react-app', name: 'React App', path: repo,
      projectSubdir: null, startCommand: 'true', defaultPort: 9100, editor: 'code',
    },
  });
}

function mrUrl() {
  return `/api/w/default/worktrees/${encodeURIComponent(repo)}/merge-requests`;
}

// Minimal GitHub PR JSON shape, with overrides for the fields each test cares
// about — mirrors the raw payloads GitHub's REST API returns.
function prJson(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'T',
    state: 'open',
    merged_at: null,
    html_url: 'https://github.com/octo/app/pull/1',
    head: { ref: 'feature-x', sha: 'abc123' },
    base: { ref: 'main' },
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

async function writeGithubToken(token = 'ghp_abc') {
  await fs.mkdir(path.dirname(process.env.STRADO_HOME!), { recursive: true });
  await fs.mkdir(process.env.STRADO_HOME!, { recursive: true });
  await fs.writeFile(
    path.join(process.env.STRADO_HOME!, 'github.json'),
    JSON.stringify({ 'github.com': { token } }),
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.STRADO_HOME;
  if (app) await app.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/w/:ws/worktrees/:path/merge-requests (GitHub)', () => {
  it('returns { needsAuth: true, provider: "github" } for a github.com origin with no saved token', async () => {
    await setupRepo('git@github.com:octo/app.git');
    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsAuth: true, provider: 'github' });
  });

  it('returns pull requests for a github.com origin with a saved token', async () => {
    await setupRepo('git@github.com:octo/app.git');

    // Write github.json directly under STRADO_HOME — sidesteps needing to
    // mock the /user validation call the /api/github/config write path makes.
    await fs.mkdir(path.dirname(process.env.STRADO_HOME!), { recursive: true });
    await fs.mkdir(process.env.STRADO_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.STRADO_HOME!, 'github.json'),
      JSON.stringify({ 'github.com': { token: 'ghp_abc' } }),
    );

    const fetchMock = vi.fn(async (url: string) => {
      const u = url.toString();
      if (u.includes('/repos/octo/app/pulls?')) {
        return new Response(
          JSON.stringify([
            {
              number: 42,
              title: 'Add feature',
              state: 'open',
              merged_at: null,
              html_url: 'https://github.com/octo/app/pull/42',
              head: { ref: 'feature-x', sha: 'abc123' },
              updated_at: '2026-07-01T00:00:00Z',
            },
          ]),
          { status: 200 },
        );
      }
      if (u.includes('/repos/octo/app/commits/abc123/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('github');
    expect(body.mergeRequests).toEqual([
      expect.objectContaining({ number: 42, provider: 'github' }),
    ]);
  });

  it('serves PRs with an owner-scoped token when no host default exists', async () => {
    // Distinct branch name — pullRequestsForBranch's in-process cache is
    // keyed by host+projectPath+branch and this route doesn't force-bust it,
    // so reusing 'feature-x' would return another test's cached PR list.
    await setupRepo('git@github.com:octo/app.git', 'owner-scoped-branch');

    // Only a composite `host/owner` key exists — no bare `github.com` entry —
    // proving host classification works from the composite key alone AND
    // the owner-scoped token is the one selected.
    await fs.mkdir(path.dirname(process.env.STRADO_HOME!), { recursive: true });
    await fs.mkdir(process.env.STRADO_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.STRADO_HOME!, 'github.json'),
      JSON.stringify({ 'github.com/octo': { token: 'ghp_work' } }),
    );

    const fetchMock = vi.fn(async (url: string) => {
      const u = url.toString();
      if (u.includes('/repos/octo/app/pulls?')) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              title: 'Owner-scoped PR',
              state: 'open',
              merged_at: null,
              html_url: 'https://github.com/octo/app/pull/7',
              head: { ref: 'feature-x', sha: 'def456' },
              updated_at: '2026-07-02T00:00:00Z',
            },
          ]),
          { status: 200 },
        );
      }
      if (u.includes('/repos/octo/app/commits/def456/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('github');
    expect(body.mergeRequests).toEqual([
      expect.objectContaining({ number: 7, provider: 'github' }),
    ]);
  });

  it('needsAuth when only a different owner has a token', async () => {
    await setupRepo('git@github.com:octo/app.git');

    await fs.mkdir(path.dirname(process.env.STRADO_HOME!), { recursive: true });
    await fs.mkdir(process.env.STRADO_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.STRADO_HOME!, 'github.json'),
      JSON.stringify({ 'github.com/someoneelse': { token: 'ghp_other' } }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsAuth: true, provider: 'github' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-auth VALIDATION error (merge conflict) does not surface as needsAuth', async () => {
    await setupRepo('git@github.com:octo/app.git', 'non-auth-validation-branch');

    await fs.mkdir(path.dirname(process.env.STRADO_HOME!), { recursive: true });
    await fs.mkdir(process.env.STRADO_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.STRADO_HOME!, 'github.json'),
      JSON.stringify({ 'github.com': { token: 'ghp_abc' } }),
    );

    (pullRequestsForBranch as unknown as Mock).mockRejectedValueOnce(
      new AppError('VALIDATION', 'merge conflict'),
    );

    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION', message: 'merge conflict' } });
  });

  it('404 from the PR list surfaces as needsAuth over the route', async () => {
    // Distinct branch name — see the cache note above.
    await setupRepo('git@github.com:octo/app.git', 'four-oh-four-branch');

    await fs.mkdir(path.dirname(process.env.STRADO_HOME!), { recursive: true });
    await fs.mkdir(process.env.STRADO_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.STRADO_HOME!, 'github.json'),
      JSON.stringify({ 'github.com': { token: 'ghp_abc' } }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsAuth: true, provider: 'github' });
  });
});

describe('POST /api/w/:ws/worktrees/:path/merge-requests (GitHub)', () => {
  it('creates a PR and returns it with provider', async () => {
    await setupRepo('git@github.com:octo/app.git', 'create-mr-branch');
    await writeGithubToken();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/repos/octo/app/pulls') && init?.method === 'POST') {
        return new Response(JSON.stringify(prJson({ number: 9, base: { ref: 'main' } })), { status: 201 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({
      method: 'POST',
      url: mrUrl(),
      payload: { target: 'main', title: 'T' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mergeRequest).toMatchObject({ number: 9, provider: 'github', targetBranch: 'main' });
  });

  it('accepts, re-lists, and returns the merged PR', async () => {
    await setupRepo('git@github.com:octo/app.git', 'merge-mr-branch');
    await writeGithubToken();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/repos/octo/app/pulls/9/merge') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ merged: true }), { status: 200 });
      }
      if (u.includes('/repos/octo/app/pulls?')) {
        return new Response(
          JSON.stringify([prJson({ number: 9, state: 'closed', merged_at: '2026-07-03T00:00:00Z' })]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({ method: 'POST', url: `${mrUrl()}/9/merge` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mergeRequest.state).toBe('merged');
    expect(body.mergeRequest.provider).toBe('github');
    expect(body.mergeRequest.number).toBe(9);
  });

  it('a successful merge survives the freshness re-list failing (500) — still returns the synthesized merged PR, not an error', async () => {
    await setupRepo('git@github.com:octo/app.git', 'merge-relist-fails-branch');
    await writeGithubToken();

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/repos/octo/app/pulls/9/merge') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ merged: true }), { status: 200 });
      }
      if (u.includes('/repos/octo/app/pulls?')) {
        // The merge itself already succeeded on GitHub — a flaky 500 on the
        // follow-up re-list must not turn a completed merge into an error.
        return new Response('', { status: 500 });
      }
      return new Response('not found', { status: 404 });
    }));

    const res = await app.inject({ method: 'POST', url: `${mrUrl()}/9/merge` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty('needsAuth');
    expect(body).not.toHaveProperty('error');
    expect(body.mergeRequest.state).toBe('merged');
    expect(body.mergeRequest.provider).toBe('github');
    expect(body.mergeRequest.number).toBe(9);
  });

  it('merge conflict surfaces as a 400 VALIDATION error, not needsAuth', async () => {
    await setupRepo('git@github.com:octo/app.git', 'merge-conflict-branch');
    await writeGithubToken();

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ message: 'Pull Request is not mergeable' }), { status: 405 });
      }
      return new Response('not found', { status: 404 });
    }));

    const res = await app.inject({ method: 'POST', url: `${mrUrl()}/9/merge` });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('not mergeable');
    expect(body).not.toHaveProperty('needsAuth');
  });

  it('create with an expired token answers needsAuth', async () => {
    await setupRepo('git@github.com:octo/app.git', 'needs-auth-create-branch');
    await writeGithubToken();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const res = await app.inject({
      method: 'POST',
      url: mrUrl(),
      payload: { target: 'main', title: 'T' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsAuth: true, provider: 'github' });
  });
});

describe('/api/github/config', () => {
  it('round-trips a per-owner token: save with owner, delete by composite key, gone from GET', async () => {
    await setupRepo('git@github.com:octo/app.git'); // repo unused here, just needs a running app
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ login: 'kamlesh' }), { status: 200 })),
    );

    const write = await app.inject({
      method: 'POST',
      url: '/api/github/config',
      payload: { host: 'github.com', token: 'ghp_work', owner: 'workorg' },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toMatchObject({ ok: true, host: 'github.com/workorg', username: 'kamlesh' });

    const read1 = await app.inject({ method: 'GET', url: '/api/github/config' });
    expect(read1.json()).toEqual({ hosts: ['github.com/workorg'] });

    const test = await app.inject({ method: 'POST', url: '/api/github/config/test' });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toEqual({ ok: true, accounts: 1 });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/github/config/${encodeURIComponent('github.com/workorg')}`,
    });
    expect(del.statusCode).toBe(200);

    const read2 = await app.inject({ method: 'GET', url: '/api/github/config' });
    expect(read2.json()).toEqual({ hosts: [] });
  });
});

describe('POST /api/w/:ws/merge-requests/batch', () => {
  it('answers every requested path in one round trip', async () => {
    await setupRepo('git@github.com:octo/app.git');
    await writeGithubToken();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = url.toString();
      if (u.includes('/repos/octo/app/pulls?')) {
        return new Response(JSON.stringify([prJson({ number: 42 })]), { status: 200 });
      }
      if (u.includes('/check-runs')) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      return new Response('not found', { status: 404 });
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/merge-requests/batch',
      payload: { paths: [repo, path.join(tmp, 'not-a-repo')] },
    });

    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results[repo]).toMatchObject({
      kind: 'list',
      provider: 'github',
      mergeRequests: [expect.objectContaining({ number: 42, provider: 'github' })],
    });
    expect(results[path.join(tmp, 'not-a-repo')]).toEqual({ kind: 'absent' });
  });

  it('reports a failing path without sinking the rest of the batch', async () => {
    await setupRepo('git@github.com:octo/app.git');
    await writeGithubToken();
    (pullRequestsForBranch as unknown as Mock).mockRejectedValueOnce(
      new AppError('VALIDATION', 'GitHub at github.com is unreachable — check your network/VPN'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/merge-requests/batch',
      payload: { paths: [repo] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results[repo]).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('unreachable'),
    });
  });
});
