// GET /api/w/:ws/remote-worktrees decides WHERE a runner worktree shows up:
// nested under the matching local repo of the workspace being asked about,
// omitted entirely when its repo lives in a DIFFERENT workspace (it shows
// nested there instead — the same rows must never appear twice across
// spaces), and returned unmatched only when no workspace has the repo.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../app.js';

let tmp: string;
let home: string;
let prevHome: string | undefined;
let prevInprocPty: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;

const RUNNER_HTTP_BASE = 'https://fake-runner.test';

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runners-remote-route-')));
  home = path.join(tmp, 'strado-home');
  await fs.mkdir(home, { recursive: true });
  // token() reads ~/.strado/license.json straight off disk — no network — so a
  // well-formed license here is enough to get past it without mocking fetch.
  await fs.writeFile(
    path.join(home, 'license.json'),
    JSON.stringify({
      token: 'a'.repeat(64),
      name: 'Test User',
      deviceId: 'device-1234',
      email: 'test@example.com',
    }),
  );
  prevHome = process.env.STRADO_HOME;
  prevInprocPty = process.env.STRADO_INPROC_PTY;
  process.env.STRADO_HOME = home;
  process.env.STRADO_INPROC_PTY = '1';

  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'state') });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  if (prevInprocPty === undefined) delete process.env.STRADO_INPROC_PTY;
  else process.env.STRADO_INPROC_PTY = prevInprocPty;
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

function repoConfig(id: string, cloneUrl: string | null) {
  return {
    id,
    name: id,
    path: path.join(tmp, 'repos', id),
    cloneUrl,
    projectSubdir: null,
    startCommand: 'npm run dev',
    defaultPort: 3000,
    editor: 'code' as const,
  };
}

/**
 * Stub every network hop the route makes: the cloud runner list, the
 * socket-ticket mint, and the runner's own workspace/repo/worktree APIs.
 */
function stubRunnerApis(o: {
  repos: { id: string; path: string; cloneUrl: string | null }[];
  worktrees: { path: string; repoId: string | null; branch: string | null; head: string }[];
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = url.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('/v1/runners/socket-ticket')) {
        return json({
          ticket: 'tkt-1',
          httpBase: RUNNER_HTTP_BASE,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
      }
      if (u.includes('/v1/runners?')) {
        return json({
          runners: [{
            runnerId: 'runner-1', name: 'runner-dev', online: true,
            lastOnlineAt: null, createdAt: '2026-01-01T00:00:00Z', runnerVersion: '0.1.0',
          }],
        });
      }
      if (u.startsWith(`${RUNNER_HTTP_BASE}/api/workspaces`)) {
        return json({ activeWorkspaceId: 'rws', workspaces: [{ id: 'rws' }] });
      }
      if (u.startsWith(`${RUNNER_HTTP_BASE}/api/w/rws/repos`)) {
        return json({ repos: o.repos });
      }
      if (u.startsWith(`${RUNNER_HTTP_BASE}/api/w/rws/worktrees`)) {
        return json({ worktrees: o.worktrees });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }),
  );
}

describe('GET /api/w/:ws/remote-worktrees', () => {
  it('hides the runner repository root and returns only real worktrees', async () => {
    const stores = await app.deps.registry.get('default');
    await stores.repos.add(repoConfig('r-local', 'https://github.com/o/local.git'));
    stubRunnerApis({
      repos: [{ id: 'local', path: '/home/strado/repos/local', cloneUrl: 'https://github.com/o/local.git' }],
      worktrees: [
        { path: '/home/strado/repos/local', repoId: 'local', branch: 'main', head: 'abc' },
        { path: '/home/strado/.strado/worktrees/local/feature', repoId: 'local', branch: 'feature', head: 'def' },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/w/default/remote-worktrees' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { worktrees: { path: string; isRepoRoot: boolean }[] };
    expect(body.worktrees).toEqual([
      expect.objectContaining({
        path: '/home/strado/.strado/worktrees/local/feature',
        isRepoRoot: false,
      }),
    ]);
  });

  it('keeps a worktree matched in the asked-about workspace, with its repo name', async () => {
    const stores = await app.deps.registry.get('default');
    await stores.repos.add(repoConfig('r-local', 'https://github.com/o/local.git'));
    stubRunnerApis({
      repos: [{ id: 'local', path: '/home/strado/local', cloneUrl: 'git@github.com:o/local.git' }],
      worktrees: [{ path: '/home/strado/local.worktrees/feat', repoId: 'local', branch: 'feat', head: 'abc' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/w/default/remote-worktrees' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { worktrees: { localRepoId: string | null; remoteRepoName: string | null }[] };
    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0]).toMatchObject({ localRepoId: 'r-local', remoteRepoName: 'local' });
  });

  it('omits a worktree whose repo lives in a DIFFERENT workspace — it shows nested there', async () => {
    await app.deps.workspaces.add({
      id: 'other', name: 'Other', color: '#112233', icon: 'O',
      defaultEditor: 'code', defaultPortBase: 9080, logDir: null,
    });
    const other = await app.deps.registry.get('other');
    await other.repos.add(repoConfig('r-site', 'https://github.com/o/site.git'));
    stubRunnerApis({
      repos: [{ id: 'site', path: '/home/strado/site', cloneUrl: 'https://github.com/o/site.git' }],
      worktrees: [{ path: '/home/strado/site.worktrees/feat', repoId: 'site', branch: 'feat', head: 'abc' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/w/default/remote-worktrees' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { worktrees: unknown[] };
    expect(body.worktrees).toHaveLength(0);
  });

  it('returns a worktree matched NOWHERE as unmatched, named after its remote repo', async () => {
    // No local repo in any workspace: hiding it would hide real work.
    stubRunnerApis({
      repos: [{ id: 'lone', path: '/home/strado/lone', cloneUrl: 'https://github.com/o/lone.git' }],
      worktrees: [{ path: '/home/strado/lone.worktrees/feat', repoId: 'lone', branch: 'feat', head: 'abc' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/w/default/remote-worktrees' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { worktrees: { localRepoId: string | null; remoteRepoName: string | null }[] };
    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0]).toMatchObject({ localRepoId: null, remoteRepoName: 'lone' });
  });

  it('falls back to the remote repo directory name when there is no clone URL', async () => {
    stubRunnerApis({
      repos: [{ id: 'bare', path: '/home/strado/bare-repo', cloneUrl: null }],
      worktrees: [{ path: '/home/strado/bare-repo.worktrees/feat', repoId: 'bare', branch: 'feat', head: 'abc' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/w/default/remote-worktrees' });

    const body = res.json() as { worktrees: { localRepoId: string | null; remoteRepoName: string | null }[] };
    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0]).toMatchObject({ localRepoId: null, remoteRepoName: 'bare-repo' });
  });
});

describe('POST /api/w/:ws/remote-worktrees', () => {
  it('accepts a blank ticket and reports the actual missing-remote problem', async () => {
    const stores = await app.deps.registry.get('default');
    await stores.repos.add(repoConfig('local-only', null));

    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/remote-worktrees',
      payload: {
        runnerId: 'runner-1',
        repoId: 'local-only',
        ticketId: '',
        title: 'Title-only worktree',
        sourceBranch: 'main',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/has no git remote/i);
    expect(res.json().error.message).not.toBe('invalid request body');
  });
});
