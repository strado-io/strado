import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let worktreesDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

// Builds a real temp git repo (with a commit, a branch, and an `origin`
// remote) plus a registered app + workspace so the route's `originUrl` /
// `currentBranch` helpers see real git state — only `globalThis.fetch`
// (the GitLab API call) is mocked per-test.
async function setupRepo(remoteUrl: string, branch = 'feature-x') {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-gl-')));
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

  // GitLab credentials live under STRADO_HOME, independent of the
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

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.STRADO_HOME;
  if (app) await app.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/w/:ws/worktrees/:path/merge-requests', () => {
  it('returns 204 for an unrecognized origin', async () => {
    await setupRepo('git@bitbucket.org:acme/widgets.git');
    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(204);
  });

  it('returns { needsAuth: true, provider: "gitlab" } for a GitLab origin with no saved token', async () => {
    await setupRepo('git@gitlab.com:g/p.git');
    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsAuth: true, provider: 'gitlab' });
  });

  it('returns merge requests for a GitLab origin with a saved token', async () => {
    await setupRepo('git@gitlab.com:g/p.git');

    const fetchMock = vi.fn(async (url: string) => {
      const u = url.toString();
      if (u.endsWith('/api/v4/user')) {
        return new Response(JSON.stringify({ username: 'kamlesh' }), { status: 200 });
      }
      if (u.includes('/merge_requests?')) {
        return new Response(
          JSON.stringify([
            {
              iid: 42,
              title: 'Add feature',
              state: 'opened',
              web_url: 'https://gitlab.com/g/p/-/merge_requests/42',
              source_branch: 'feature-x',
              updated_at: '2026-07-01T00:00:00Z',
            },
          ]),
          { status: 200 },
        );
      }
      if (u.includes('/approvals')) {
        return new Response(JSON.stringify({ approvals_required: 2, approved_by: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const write = await app.inject({
      method: 'POST',
      url: '/api/gitlab/config',
      payload: { host: 'gitlab.com', token: 'glpat-abc' },
    });
    expect(write.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mergeRequests).toHaveLength(1);
    expect(body.mergeRequests[0]).toMatchObject({
      number: 42,
      title: 'Add feature',
      state: 'open',
      sourceBranch: 'feature-x',
    });
  });

  it('returns 204 for a GitLab origin with a saved token but no current branch (detached HEAD)', async () => {
    await setupRepo('git@gitlab.com:g/p.git');
    await exec('git', ['checkout', '-q', '--detach'], { cwd: repo });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ username: 'kamlesh' }), { status: 200 })),
    );
    const write = await app.inject({
      method: 'POST',
      url: '/api/gitlab/config',
      payload: { host: 'gitlab.com', token: 'glpat-abc' },
    });
    expect(write.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: mrUrl() });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });
});

describe('/api/gitlab/config', () => {
  it('validates the token, persists it, and never leaks it back on read', async () => {
    await setupRepo('git@github.com:acme/widgets.git'); // repo unused here, just needs a running app
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ username: 'kamlesh' }), { status: 200 })),
    );

    const write = await app.inject({
      method: 'POST',
      url: '/api/gitlab/config',
      payload: { host: 'gitlab.com', token: 'glpat-abc' },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toMatchObject({ ok: true, host: 'gitlab.com', username: 'kamlesh' });

    const read = await app.inject({ method: 'GET', url: '/api/gitlab/config' });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ hosts: ['gitlab.com'] });
    expect(JSON.stringify(read.json())).not.toContain('glpat-abc');

    const test = await app.inject({ method: 'POST', url: '/api/gitlab/config/test' });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toEqual({ ok: true, accounts: 1 });
  });

  it('rejects a bad token with 400 and does not persist it', async () => {
    await setupRepo('git@github.com:acme/widgets.git');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));

    const res = await app.inject({
      method: 'POST',
      url: '/api/gitlab/config',
      payload: { host: 'gitlab.com', token: 'bad' },
    });
    expect(res.statusCode).toBe(400);

    const read = await app.inject({ method: 'GET', url: '/api/gitlab/config' });
    expect(read.json()).toEqual({ hosts: [] });
  });
});
