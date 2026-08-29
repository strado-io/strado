import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-ocs-')));
  repo = path.join(tmp, 'repo');
  const worktreesDir = path.join(tmp, 'home', 'worktrees', 'r');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'f'), '1');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'r', name: 'R', path: repo,
      projectSubdir: null, startCommand: 'true', defaultPort: 9100, editor: 'code',
    },
  });
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('POST /api/opencode/status', () => {
  it('maps a Strado tab to its OpenCode session', async () => {
    await app.inject({
      method: 'POST', url: '/api/opencode/status',
      payload: { cwd: repo, status: 'waiting', sessionId: '2', providerSessionId: 'opencode-id' },
    });
    expect(await app.deps.agentSessions.get('opencode', repo, '2')).toMatchObject({ providerSessionId: 'opencode-id' });
  });

  it('keys status by sessionId and aggregates across sessions', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/opencode/status',
      payload: { cwd: repo, status: 'working', sessionId: '2' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/opencode/status',
      payload: { cwd: repo, status: 'waiting' }, // session 1 (default)
    });
    expect(app.deps.opencodeStatus.get(repo)).toBe('working');
    expect(app.deps.opencodeStatus.sessions(repo)).toEqual({ '2': 'working', '1': 'waiting' });
  });

  it('surfaces opencodeStatusById on the worktrees listing', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/opencode/status',
      payload: { cwd: repo, status: 'waiting', sessionId: '2' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = res.json().worktrees.find((w: any) => w.path === repo);
    expect(row.opencodeStatusById).toEqual({ '2': 'waiting' });
    expect(row.opencodeSessions).toEqual([]);
  });

  it('accepts a Shell-hosted agent session and drops it on close', async () => {
    await app.inject({ method: 'POST', url: '/api/opencode/status', payload: { cwd: repo, status: 'waiting', sessionId: 'shell:4' } });
    expect(app.deps.opencodeStatus.sessions(repo)['shell:4']).toBe('waiting');
    const res = await app.inject({ method: 'POST', url: '/api/opencode/status', payload: { cwd: repo, status: 'closed', sessionId: 'shell:4' } });
    expect(res.statusCode).toBe(200);
    expect(app.deps.opencodeStatus.sessions(repo)).not.toHaveProperty('shell:4');
  });
});
