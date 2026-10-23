import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';
import { shellKey } from '../../src/services/terminalManager';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-pis-')));
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

describe('POST /api/pi/status', () => {
  it('keys status by sessionId and aggregates across sessions', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/pi/status',
      payload: { cwd: repo, status: 'working', sessionId: '2' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/pi/status',
      payload: { cwd: repo, status: 'waiting' }, // session 1 (default)
    });
    expect(app.deps.piStatus.get(repo)).toBe('working');
    expect(app.deps.piStatus.sessions(repo)).toEqual({ '2': 'working', '1': 'waiting' });
  });

  it('maps a Strado tab to Pi session metadata', async () => {
    await app.inject({
      method: 'POST', url: '/api/pi/status',
      payload: {
        cwd: repo, status: 'waiting', sessionId: '2', providerSessionId: 'pi-id',
        transcriptPath: '/tmp/pi-id.jsonl',
      },
    });
    expect(await app.deps.agentSessions.get('pi', repo, '2')).toMatchObject({
      providerSessionId: 'pi-id', transcriptPath: '/tmp/pi-id.jsonl',
    });
  });

  it('surfaces piStatusById on the worktrees listing', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/pi/status',
      payload: { cwd: repo, status: 'waiting', sessionId: '2' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = res.json().worktrees.find((w: any) => w.path === repo);
    expect(row.piStatusById).toEqual({ '2': 'waiting' });
    expect(row.piSessions).toEqual([]);
  });

  it('accepts a Shell-hosted agent session and drops it on close', async () => {
    await app.inject({ method: 'POST', url: '/api/pi/status', payload: { cwd: repo, status: 'waiting', sessionId: 'shell:4' } });
    expect(app.deps.piStatus.sessions(repo)['shell:4']).toBe('waiting');
    const res = await app.inject({ method: 'POST', url: '/api/pi/status', payload: { cwd: repo, status: 'closed', sessionId: 'shell:4' } });
    expect(res.statusCode).toBe(200);
    expect(app.deps.piStatus.sessions(repo)).not.toHaveProperty('shell:4');
  });

  it('a Shell that exits with no tab attached drops the agent it hosted (the next Shell 4 is a plain shell)', async () => {
    const key = shellKey(repo, '4');
    await app.deps.terminal.ensure(key, repo, { file: 'sleep', args: ['30'] });
    // The launcher registered Pi, then the shell was killed with it: no 'closed' ever came.
    await app.inject({ method: 'POST', url: '/api/pi/status', payload: { cwd: repo, status: 'waiting', sessionId: 'shell:4' } });
    app.deps.terminal.kill(key);
    await vi.waitFor(() => expect(app.deps.piStatus.sessions(repo)).not.toHaveProperty('shell:4'));
  });
});
