import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';
import { createTerminalManager } from '../../src/services/terminalManager';

let tmp: string;
let repo: string;
let worktreesDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let deps: Awaited<ReturnType<typeof buildDeps>>;

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

  deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  // Inject a fake interactive program so tests don't depend on `claude`.
  deps.terminal = createTerminalManager(
    () => ({ file: 'cat', args: [] }), undefined, undefined, undefined, deps.agents.envFor,
  );
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
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('STRADO_CLAUDE_HOOK');

    const claudeJsonFile = process.env.STRADO_CLAUDE_JSON!;
    let entry: { command: string; args: string[] } | undefined;
    const start2 = Date.now();
    while (Date.now() - start2 < 5_000) {
      try { entry = JSON.parse(await fsp.readFile(claudeJsonFile, 'utf8')).projects?.[repo]?.mcpServers?.strado; } catch { /* not written yet */ }
      if (entry) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(entry, 'strado MCP entry not written within 5 s').toBeDefined();
    expect(entry!.command).toBe('node');
    expect(entry!.args[0]).toMatch(/\/hooks\/strado-mcp\.mjs$/);

    ws.close();
  });

  it('shell mode installs Claude and OpenCode status integrations', async () => {
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const ws = await openSocket(`ws=default&path=${encodeURIComponent(repo)}&mode=shell`);
    const claudeSettings = pathMod.join(repo, '.claude', 'settings.local.json');
    const opencodePlugin = pathMod.join(repo, '.opencode', 'plugin', 'strado-opencode-status.js');
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      try {
        await Promise.all([fsp.access(claudeSettings), fsp.access(opencodePlugin)]);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(JSON.parse(await fsp.readFile(claudeSettings, 'utf8')).hooks.UserPromptSubmit).toBeTruthy();
    expect(await fsp.readFile(opencodePlugin, 'utf8')).toContain("'chat.message'");
    ws.close();
  });

  it('marks Enter as Codex working only while Codex is registered in that Shell', async () => {
    const ws = await openSocket(`ws=default&path=${encodeURIComponent(repo)}&mode=shell&session=2`);
    ws.send(JSON.stringify({ type: 'data', data: '\r' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(app.deps.codexStatus.get(repo)).toBeUndefined();

    await app.inject({
      method: 'POST',
      url: '/api/codex/status',
      payload: { cwd: repo, status: 'waiting', sessionId: 'shell:2' },
    });
    ws.send(JSON.stringify({ type: 'data', data: '\r' }));
    const start = Date.now();
    while (app.deps.codexStatus.get(repo) !== 'working' && Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(app.deps.codexStatus.sessions(repo)['shell:2']).toBe('working');
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

  it('registers an execution on connect and releases on exit', async () => {
    const ws = await openSocket(`ws=default&path=${encodeURIComponent(repo)}&mode=claude&session=1`);
    const { claudeKey } = await import('../../src/services/terminalManager');
    const key = claudeKey(repo, '1');
    // register runs before ensure, but the client's `open` event fires as
    // soon as the WS handshake completes — before the handler's own async
    // setup (workspace/repo lookups, hook install) reaches register(). Poll
    // like the rest of this suite does for other post-connect effects.
    let env = deps.agents.envFor(key, repo);
    {
      const pollStart = Date.now();
      while (Date.now() - pollStart < 5_000 && !env.STRADO_AGENT_TOKEN) {
        await new Promise((r) => setTimeout(r, 25));
        env = deps.agents.envFor(key, repo);
      }
    }
    expect(env.STRADO_AGENT_ID).toBe('claude-1@repo');
    expect(env.STRADO_SCOPE_ID).toBe('default');
    expect(env.STRADO_AGENT_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const listed = await app.inject({ method: 'GET', url: '/api/w/default/agents' });
    expect(listed.json().agents.map((a: any) => a.agentId)).toContain('claude-1@repo');

    app.deps.terminal.kill(key);
    const start = Date.now();
    while (Date.now() - start < 5_000 && deps.agents.envFor(key, repo).STRADO_AGENT_TOKEN) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(deps.agents.envFor(key, repo)).toEqual({});
    ws.close();
  });

  it('logs a warning when agent register fails, but still spawns the terminal', async () => {
    const warn = vi.spyOn(app.log, 'warn');
    const originalRegister = app.deps.agents.register;
    app.deps.agents.register = async () => { throw new Error('boom'); };
    try {
      const ws = await openSocket(`ws=default&path=${encodeURIComponent(repo)}`);
      let buf = '';
      ws.on('message', (d) => { buf += d.toString(); });
      ws.send(JSON.stringify({ type: 'data', data: 'ping\n' }));
      const start = Date.now();
      while (!buf.includes('ping') && Date.now() - start < 5_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(buf).toContain('ping'); // register failure never blocks the terminal
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('agent register failed'),
      );
      ws.close();
    } finally {
      app.deps.agents.register = originalRegister;
      warn.mockRestore();
    }
  });

  it('the manager receives the identity env at spawn time', async () => {
    // Capture what the manager's extraEnv hook returned when it spawned the
    // session. Task 7 proves that record reaches the process; this proves the
    // route registered BEFORE ensure(), so the record was non-empty at spawn.
    const seen: Array<{ key: string; env: Record<string, string> }> = [];
    const { createTerminalManager, shellKey } = await import('../../src/services/terminalManager');
    deps.terminal = createTerminalManager(
      () => ({ file: 'cat', args: [] }),
      undefined, undefined, undefined,
      (key, cwd) => {
        const env = deps.agents.envFor(key, cwd);
        seen.push({ key, env });
        return env;
      },
    );
    const ws = await openSocket(`ws=default&path=${encodeURIComponent(repo)}&mode=shell&session=2`);
    const key = shellKey(repo, '2');
    // Same handshake-vs-handler race as above: poll for the spawn record.
    let spawn: { key: string; env: Record<string, string> } | undefined;
    {
      const pollStart = Date.now();
      while (Date.now() - pollStart < 5_000 && !spawn) {
        spawn = seen.find((s) => s.key === key);
        if (!spawn) await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(spawn).toBeDefined();
    expect(spawn!.env.STRADO_AGENT_ID).toBe('shell-2@repo');
    expect(spawn!.env.STRADO_SCOPE_ID).toBe('default');
    expect(spawn!.env.STRADO_AGENT_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    ws.close();
  });
});
