import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let worktreesDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let worktree: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-proc-')));
  repo = path.join(tmp, 'repo');
  worktreesDir = path.join(tmp, 'home', 'worktrees', 'r');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'pkg.json'), '{}');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  worktree = path.join(worktreesDir, 'FD-1_hi');
  await exec('git', ['-C', repo, 'worktree', 'add', worktree, '-b', 'FD-1_hi', 'main']);
  await fs.writeFile(
    path.join(worktree, 'server.js'),
    "const p=process.env.PORT;console.log('serve on http://localhost:'+p);setInterval(()=>{},1e6);",
  );

  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'r',
      name: 'r',
      path: repo,
      projectSubdir: null,
      startCommand: 'node server.js',
      defaultPort: 9500,
      editor: 'code',
    },
  });
  await app.inject({
    method: 'POST',
    url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/adopt`,
    payload: { repoId: 'r', ticketId: 'FD-1', title: 'hi', port: 9555 },
  });
});

afterEach(async () => {
  await app
    .inject({ method: 'POST', url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/stop` })
    .catch(() => undefined);
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('process routes', () => {
  it('starts, reports status, returns logs, stops', async () => {
    const start = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/start`,
    });
    expect(start.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 500));
    const status = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/status`,
    });
    expect(status.json().status).toBe('running');

    const logs = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/logs?tail=10`,
    });
    expect(logs.statusCode).toBe(200);
    expect(Array.isArray(logs.json().lines)).toBe(true);

    const stop = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/stop`,
    });
    expect(stop.statusCode).toBe(204);
  });

  it('returns PROCESS_ALREADY_RUNNING on double start', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/start`,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(worktree)}/start`,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('PROCESS_ALREADY_RUNNING');
  });
});
