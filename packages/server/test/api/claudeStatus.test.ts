import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';
import { claudeKey } from '../../src/services/terminalManager';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-cs-')));
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

describe('POST /api/claude/status', () => {
  it('accepts a known worktree cwd, stores status, emits on the bus', async () => {
    const events: any[] = [];
    app.deps.bus.on('worktrees', (e) => events.push(e));

    const res = await app.inject({
      method: 'POST',
      url: '/api/claude/status',
      payload: { cwd: repo, status: 'working' },
    });

    expect(res.statusCode).toBe(200);
    expect(app.deps.claudeStatus.get(repo)).toBe('working');
    expect(events).toContainEqual({
      type: 'worktree.updated',
      data: { path: repo, claudeStatus: 'working', claudeStatusById: { '1': 'working' } },
    });
  });

  it('keys status by sessionId and aggregates across sessions', async () => {
    const events: any[] = [];
    app.deps.bus.on('worktrees', (e) => events.push(e));

    await app.inject({
      method: 'POST',
      url: '/api/claude/status',
      payload: { cwd: repo, status: 'working', sessionId: '2' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/claude/status',
      payload: { cwd: repo, status: 'waiting' }, // session 1 (default)
    });

    expect(app.deps.claudeStatus.get(repo)).toBe('working'); // session 2 still working
    expect(events.at(-1).data.claudeStatusById).toEqual({ '2': 'working', '1': 'waiting' });
  });

  it('accepts a Shell-hosted agent session and drops it on close', async () => {
    await app.inject({ method: 'POST', url: '/api/claude/status', payload: { cwd: repo, status: 'waiting', sessionId: 'shell:2' } });
    expect(app.deps.claudeStatus.sessions(repo)['shell:2']).toBe('waiting');
    const res = await app.inject({ method: 'POST', url: '/api/claude/status', payload: { cwd: repo, status: 'closed', sessionId: 'shell:2' } });
    expect(res.statusCode).toBe(200);
    expect(app.deps.claudeStatus.sessions(repo)).not.toHaveProperty('shell:2');
  });

  it('rejects a cwd no repo owns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/claude/status',
      payload: { cwd: '/etc', status: 'idle' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('surfaces claudeStatus on the worktrees listing', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/claude/status',
      payload: { cwd: repo, status: 'waiting' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = res.json().worktrees.find((w: any) => w.path === repo);
    expect(row.claudeStatus).toBe('waiting');
    expect(row.claudeStatusById).toEqual({ '1': 'waiting' });
  });

  it('lists live claude session ids on the worktrees listing', async () => {
    // Two live Claude sessions (id 1 = bare-path key, id 2 = suffixed key).
    const sleep = { file: 'sleep', args: ['30'] };
    await app.deps.terminal.ensure(repo, repo, sleep);
    await app.deps.terminal.ensure(claudeKey(repo, '2'), repo, sleep);
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const row = res.json().worktrees.find((w: any) => w.path === repo);
    expect(row.claudeSessions).toEqual(['1', '2']);
    expect(row.hasClaudeSession).toBe(true);
    app.deps.terminal.killUnder(repo);
  });
});
