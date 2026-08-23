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

// Mirrors the harness in test/api/gitlab.test.ts: a real temp git repo (with
// a commit, a branch, and an `origin` remote) plus a registered app +
// workspace so the route's `originUrl` / `currentBranch` helpers see real
// git state — only `globalThis.fetch` (the GitLab API call) is mocked.
async function setupRepo(remoteUrl: string, branch = 'feature-x') {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-gl-ch-')));
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

function changesUrl(iid: string | number) {
  return `/api/w/default/worktrees/${encodeURIComponent(repo)}/merge-requests/${iid}/changes`;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.STRADO_HOME;
  if (app) await app.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/w/:ws/worktrees/:path/merge-requests/:iid/changes', () => {
  it('returns 204 for an unrecognized origin', async () => {
    await setupRepo('git@bitbucket.org:acme/widgets.git');
    const res = await app.inject({ method: 'GET', url: changesUrl(42) });
    expect(res.statusCode).toBe(204);
  });

  it('returns { needsAuth: true, provider: "gitlab" } for a GitLab origin with no saved token', async () => {
    await setupRepo('git@gitlab.com:g/p.git');
    const res = await app.inject({ method: 'GET', url: changesUrl(42) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsAuth: true, provider: 'gitlab' });
  });

  it('returns the file changes for a GitLab origin with a saved token', async () => {
    await setupRepo('git@gitlab.com:g/p.git');

    const fetchMock = vi.fn(async (url: string) => {
      const u = url.toString();
      if (u.endsWith('/api/v4/user')) {
        return new Response(JSON.stringify({ username: 'kamlesh' }), { status: 200 });
      }
      if (u.includes('/merge_requests/42/changes')) {
        return new Response(
          JSON.stringify({
            changes: [
              {
                old_path: 'src/foo.ts',
                new_path: 'src/foo.ts',
                new_file: false,
                deleted_file: false,
                renamed_file: false,
                diff: '@@ -1,1 +1,1 @@\n-old\n+new\n',
              },
            ],
          }),
          { status: 200 },
        );
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

    const res = await app.inject({ method: 'GET', url: changesUrl(42) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      path: 'src/foo.ts',
      status: 'M',
      diff: '@@ -1,1 +1,1 @@\n-old\n+new\n',
    });
  });

  it('returns 400 for a non-integer :iid', async () => {
    await setupRepo('git@gitlab.com:g/p.git');
    const res = await app.inject({ method: 'GET', url: changesUrl('abc') });
    expect(res.statusCode).toBe(400);
  });
});
