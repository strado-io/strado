import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';
import { createTerminalManager } from '../../src/services/terminalManager';

let tmp: string;
let repo: string;
let worktreesDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-term-')));
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

  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  // Inject a fake interactive program so tests don't depend on `claude`.
  deps.terminal = createTerminalManager(() => ({ file: 'cat', args: [] }));
  app = await buildApp(deps);

  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'react-app', name: 'React App', path: repo,
      projectSubdir: null, startCommand: 'true', defaultPort: 9100, editor: 'code',
    },
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

function openSocket(query: string): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl}/ws/terminal?${query}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('GET /ws/terminal', () => {
  it('spawns a session and echoes input back', async () => {
    const q = `ws=default&path=${encodeURIComponent(repo)}`;
    const ws = await openSocket(q);
    let buf = '';
    ws.on('message', (d) => { buf += d.toString(); });
    ws.send(JSON.stringify({ type: 'data', data: 'ping\n' }));
    // Poll instead of a fixed sleep — robust when the suite saturates the CPU.
    const start = Date.now();
    while (!buf.includes('ping') && Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(buf).toContain('ping');
    ws.close();
  });

  it('rejects an unknown workspace', async () => {
    const ws = new WebSocket(`${baseUrl}/ws/terminal?ws=nope&path=${encodeURIComponent(repo)}`);
    const msg: string = await new Promise((resolve) => {
      let acc = '';
      ws.on('message', (d) => { acc += d.toString(); });
      ws.on('close', () => resolve(acc));
    });
    expect(msg).toContain('workspace');
  });

  it('rejects a path no repo owns', async () => {
    const ws = new WebSocket(`${baseUrl}/ws/terminal?ws=default&path=${encodeURIComponent('/etc')}`);
    const msg: string = await new Promise((resolve) => {
      let acc = '';
      ws.on('message', (d) => { acc += d.toString(); });
      ws.on('close', () => resolve(acc));
    });
    expect(msg.toLowerCase()).toContain('no repo');
  });

  it('installs Claude status hooks into the worktree on connect', async () => {
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const ws = await openSocket(`ws=default&path=${encodeURIComponent(repo)}`);
    const settingsFile = pathMod.join(repo, '.claude', 'settings.local.json');
    // Poll for the async hook install instead of a fixed sleep.
    let raw = '';
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      try { raw = await fsp.readFile(settingsFile, 'utf8'); break; } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const settings = JSON.parse(raw);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('claude-status-hook.mjs');
    ws.close();
  });

  it('shell mode does not install Claude hooks', async () => {
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const ws = await openSocket(`ws=default&path=${encodeURIComponent(repo)}&mode=shell`);
    // End the spawned login shell so it doesn't linger past the test.
    ws.send(JSON.stringify({ type: 'data', data: 'exit\n' }));
    // Wait a moment, then confirm no settings.local.json was written.
    await new Promise((r) => setTimeout(r, 600));
    let exists = true;
    try {
      await fsp.access(pathMod.join(repo, '.claude', 'settings.local.json'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
    ws.close();
  });

  it('marks the worktree as having a Claude session in the listing', async () => {
    const ws = await openSocket(`ws=default&path=${encodeURIComponent(repo)}`);
    // poll the listing until the session flag shows up
    let row: any;
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
      row = res.json().worktrees.find((w: any) => w.path === repo);
      if (row?.hasClaudeSession) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row.hasClaudeSession).toBe(true);
    expect(row.hasShellSession).toBe(false);
    ws.close();
  });
});
