import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installClaudeHooks, claudeHookCommand } from '../../src/services/claudeHooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function readSettings(): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(tmp, '.claude', 'settings.local.json'), 'utf8'));
}

describe('installClaudeHooks', () => {
  it('creates settings.local.json with the four status hooks', async () => {
    await installClaudeHooks(tmp);
    const s = await readSettings();
    expect(Object.keys(s.hooks).sort()).toEqual(['Notification', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const stopCmd = s.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toContain('$STRADO_CLAUDE_HOOK');
    expect(stopCmd).toContain(' idle ');
    expect(s.hooks.SessionStart[0].hooks[0].command).toContain(' idle ');
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain(' working ');
    expect(s.hooks.Notification[0].hooks[0].command).toContain(' waiting ');
  });

  // The command must be a machine-independent constant: a path baked in here
  // outlives the worktree/install that wrote it and fires MODULE_NOT_FOUND on
  // every turn. Identity (script path, port) travels in the PTY env instead.
  it('writes a command with no filesystem path and no port in it', async () => {
    await installClaudeHooks(tmp);
    const s = await readSettings();
    for (const ev of ['Stop', 'UserPromptSubmit', 'Notification', 'SessionStart']) {
      const cmd = s.hooks[ev][0].hooks[0].command as string;
      expect(cmd).not.toMatch(/\//);
      expect(cmd).not.toMatch(/\b7777\b/);
      expect(cmd).toContain('"$STRADO_CLAUDE_HOOK"');
      expect(cmd).toContain('STRADO_STATUS_PORT');
    }
  });

  it('is a no-op (exit 0, no output) when STRADO_CLAUDE_HOOK is unset', async () => {
    await installClaudeHooks(tmp);
    const s = await readSettings();
    const cmd = s.hooks.Stop[0].hooks[0].command as string;
    const { exec } = await import('../../src/shell');
    const env = { ...process.env };
    delete env.STRADO_CLAUDE_HOOK;
    const r = await exec('sh', ['-c', cmd], { cwd: tmp, env });
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('is a no-op when STRADO_CLAUDE_HOOK names a file that no longer exists', async () => {
    await installClaudeHooks(tmp);
    const s = await readSettings();
    const cmd = s.hooks.Stop[0].hooks[0].command as string;
    const { exec } = await import('../../src/shell');
    const r = await exec('sh', ['-c', cmd], {
      cwd: tmp,
      env: { ...process.env, STRADO_CLAUDE_HOOK: path.join(tmp, 'gone', 'claude-status-hook.mjs') },
    });
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('preserves existing settings and foreign hooks', async () => {
    await fs.mkdir(path.join(tmp, '.claude'));
    await fs.writeFile(
      path.join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] },
      }),
    );
    await installClaudeHooks(tmp);
    const s = await readSettings();
    expect(s.permissions).toEqual({ allow: ['Bash'] });
    const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain('echo keep-me');
    expect(stopCmds.some((c: string) => c.includes('STRADO_CLAUDE_HOOK'))).toBe(true);
  });

  it('prunes a legacy path-baked Strado hook, keeps foreign hooks', async () => {
    await fs.mkdir(path.join(tmp, '.claude'));
    await fs.writeFile(
      path.join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node "/old/path/packages/server/hooks/claude-status-hook.mjs" idle 7777' }] },
            { hooks: [{ type: 'command', command: 'echo keep-me' }] },
          ],
        },
      }),
    );
    await installClaudeHooks(tmp);
    const s = await readSettings();
    const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds.some((c: string) => c.includes('/old/path/'))).toBe(false); // stale dropped
    expect(stopCmds).toContain('echo keep-me'); // foreign kept
    expect(stopCmds.filter((c: string) => c.includes('STRADO_CLAUDE_HOOK'))).toHaveLength(1);
  });

  it('is idempotent — re-install does not duplicate entries', async () => {
    await installClaudeHooks(tmp);
    await installClaudeHooks(tmp);
    const s = await readSettings();
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.Notification).toHaveLength(1);
  });

  it('replaces a malformed array hooks value with an object', async () => {
    await fs.mkdir(path.join(tmp, '.claude'));
    await fs.writeFile(
      path.join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: [] }),
    );
    await installClaudeHooks(tmp);
    const s = await readSettings();
    expect(Array.isArray(s.hooks)).toBe(false);
    expect(s.hooks.Stop[0].hooks[0].command).toContain('STRADO_CLAUDE_HOOK');
  });

  // Claude Code merges the MAIN checkout's .claude/settings.local.json into
  // sessions started in any of its linked worktrees. A legacy path-baked hook
  // left there (by a since-deleted worktree's server) therefore fires in every
  // worktree, and the per-worktree installer never sees it. Installing into a
  // worktree must purge the main checkout's legacy entries — and nothing else.
  describe('main checkout of a linked worktree', () => {
    let main: string;
    let wt: string;
    const legacy = 'node "/gone/worktree/packages/server/hooks/claude-status-hook.mjs" idle 7899';

    beforeEach(async () => {
      const { exec } = await import('../../src/shell');
      main = path.join(tmp, 'main');
      wt = path.join(tmp, 'wt');
      await fs.mkdir(main);
      await exec('git', ['init', '-q'], { cwd: main });
      await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main });
      await exec('git', ['worktree', 'add', '-q', wt], { cwd: main });
    });

    async function readMain(): Promise<any> {
      return JSON.parse(await fs.readFile(path.join(main, '.claude', 'settings.local.json'), 'utf8'));
    }

    it('purges legacy Strado hooks from the main checkout, keeps foreign hooks', async () => {
      await fs.mkdir(path.join(main, '.claude'));
      await fs.writeFile(
        path.join(main, '.claude', 'settings.local.json'),
        JSON.stringify({
          permissions: { allow: ['Bash'] },
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: legacy }] }, { hooks: [{ type: 'command', command: 'echo keep-me' }] }],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: legacy.replace('idle', 'working') }] }],
          },
        }),
      );
      await installClaudeHooks(wt);
      const s = await readMain();
      expect(s.permissions).toEqual({ allow: ['Bash'] });
      const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
      expect(stopCmds).toEqual(['echo keep-me']);
      expect(s.hooks.UserPromptSubmit).toEqual([]);
    });

    it('does not add hooks to the main checkout', async () => {
      await fs.mkdir(path.join(main, '.claude'));
      await fs.writeFile(path.join(main, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: legacy }] }] } }));
      await installClaudeHooks(wt);
      const s = await readMain();
      const all = JSON.stringify(s);
      expect(all).not.toContain('claude-status-hook');
      // Nothing new was added — main had no constant-hook entry, so it still has none.
      expect(all).not.toContain('STRADO_CLAUDE_HOOK');
    });

    // When the main checkout is ITSELF a Strado worktree (nested worktrees),
    // its own valid constant hook must survive opening a linked worktree's
    // terminal — only legacy path-baked entries are stale here.
    it('keeps the current constant hook already in the main checkout, only drops legacy ones', async () => {
      await fs.mkdir(path.join(main, '.claude'));
      const constantCmd = claudeHookCommand('idle');
      await fs.writeFile(
        path.join(main, '.claude', 'settings.local.json'),
        JSON.stringify({
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: legacy }] },
              { hooks: [{ type: 'command', command: constantCmd }] },
            ],
          },
        }),
      );
      await installClaudeHooks(wt);
      const s = await readMain();
      const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
      expect(stopCmds).not.toContain(legacy); // legacy dropped
      expect(stopCmds).toContain(constantCmd); // constant kept
      expect(stopCmds).toHaveLength(1); // nothing added
    });

    it('creates nothing in the main checkout when it has no settings file', async () => {
      await installClaudeHooks(wt);
      await expect(fs.stat(path.join(main, '.claude'))).rejects.toThrow();
    });

    it('leaves the main checkout untouched when it has nothing legacy', async () => {
      await fs.mkdir(path.join(main, '.claude'));
      const body = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] } });
      await fs.writeFile(path.join(main, '.claude', 'settings.local.json'), body);
      const before = await fs.stat(path.join(main, '.claude', 'settings.local.json'));
      await installClaudeHooks(wt);
      const after = await fs.stat(path.join(main, '.claude', 'settings.local.json'));
      expect(await fs.readFile(path.join(main, '.claude', 'settings.local.json'), 'utf8')).toBe(body);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });
  });

  it('adds settings.local.json to the worktree git exclude (idempotently)', async () => {
    const { exec } = await import('../../src/shell');
    await exec('git', ['init', '-q'], { cwd: tmp });
    await installClaudeHooks(tmp);
    await installClaudeHooks(tmp);
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const exclude = await fsp.readFile(pathMod.join(tmp, '.git', 'info', 'exclude'), 'utf8');
    const matches = exclude.split('\n').filter((l) => l.trim() === '.claude/settings.local.json');
    expect(matches).toHaveLength(1);
  });
});

describe('claude-status-hook.mjs intercom delivery', () => {
  const SCRIPT = path.resolve(__dirname, '../../hooks/claude-status-hook.mjs');
  type Hit = { url: string; auth: string | undefined; body: any };

  async function fakeServer(hookReply: { status?: number; body?: unknown } = {}, socketPath?: string) {
    const http = await import('node:http');
    const hits: Hit[] = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', auth: req.headers.authorization, body: data ? JSON.parse(data) : null });
        if (req.url === '/api/intercom/hook') {
          res.statusCode = hookReply.status ?? 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(hookReply.body ?? { additionalContext: null, batchId: null, delivered: 0, acknowledged: 0 }));
          return;
        }
        res.statusCode = 200;
        res.end(req.url === '/api/intercom/hook/confirm' ? '{"confirmed":1}' : '{"ok":true}');
      });
    });
    await new Promise<void>((r) => (socketPath ? server.listen(socketPath, r) : server.listen(0, '127.0.0.1', r)));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { hits, port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  async function runHook(args: string[], payload: unknown, env: Record<string, string | undefined>) {
    const { spawn } = await import('node:child_process');
    return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const merged: Record<string, string | undefined> = {
        ...process.env,
        STRADO_SERVER_SOCKET: undefined,
        STRADO_SESSION_MODE: undefined,
        STRADO_SESSION_ID: undefined,
        ...env,
      };
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;   // spawn must not see undefined values
      const child = spawn(process.execPath, [SCRIPT, ...args], { env: clean, cwd: tmp });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.stderr.on('data', (b) => (stderr += b));
      child.on('close', (code) => resolve({ stdout, stderr, code }));
      child.stdin.end(JSON.stringify(payload));
    });
  }

  const payload = (event: string) => ({ hook_event_name: event, cwd: tmp, session_id: 'S1', transcript_path: '/t' });
  const CTX = '<strado-intercom>\n1 new message…\n</strado-intercom>';

  it('UserPromptSubmit: status, hook, then confirm only after printing the context line', async () => {
    const srv = await fakeServer({ body: { additionalContext: CTX, batchId: 'B1', delivered: 1, acknowledged: 0 } });
    try {
      const r = await runHook(['working', String(srv.port)], payload('UserPromptSubmit'), { STRADO_AGENT_TOKEN: 'tok-1', STRADO_SESSION_ID: '2' });
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: CTX } }) + '\n');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status', '/api/intercom/hook', '/api/intercom/hook/confirm']);
      expect(srv.hits[1]).toMatchObject({ auth: 'Bearer tok-1', body: { event: 'UserPromptSubmit', transport: 'port' } });
      expect(srv.hits[2]).toMatchObject({ auth: 'Bearer tok-1', body: { batchId: 'B1' } });
      expect(srv.hits[0]!.body).toMatchObject({ status: 'working', sessionId: '2' });
    } finally { await srv.close(); }
  });

  it('empty inbox: hook call, no confirm, no stdout', async () => {
    const srv = await fakeServer();
    try {
      const r = await runHook(['working', String(srv.port)], payload('UserPromptSubmit'), { STRADO_AGENT_TOKEN: 'tok-1' });
      expect(r.stdout).toBe('');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status', '/api/intercom/hook']);
    } finally { await srv.close(); }
  });

  it('SessionStart behaves like UserPromptSubmit', async () => {
    const srv = await fakeServer({ body: { additionalContext: CTX, batchId: 'B2', delivered: 1, acknowledged: 0 } });
    try {
      const r = await runHook(['idle', String(srv.port)], payload('SessionStart'), { STRADO_AGENT_TOKEN: 'tok-1' });
      expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status', '/api/intercom/hook', '/api/intercom/hook/confirm']);
    } finally { await srv.close(); }
  });

  it('Stop: status then hook, no stdout', async () => {
    const srv = await fakeServer();
    try {
      const r = await runHook(['idle', String(srv.port)], payload('Stop'), { STRADO_AGENT_TOKEN: 'tok-1' });
      expect(r.stdout).toBe('');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status', '/api/intercom/hook']);
      expect(srv.hits[1]!.body).toEqual({ event: 'Stop', transport: 'port' });
    } finally { await srv.close(); }
  });

  it('no token → status only; Notification → status only', async () => {
    const srv = await fakeServer({ body: { additionalContext: CTX, batchId: 'B', delivered: 1, acknowledged: 0 } });
    try {
      const a = await runHook(['working', String(srv.port)], payload('UserPromptSubmit'), { STRADO_AGENT_TOKEN: undefined });
      expect(a.stdout).toBe('');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status']);
      srv.hits.length = 0;
      const b = await runHook(['waiting', String(srv.port)], payload('Notification'), { STRADO_AGENT_TOKEN: 'tok-1' });
      expect(b.stdout).toBe('');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status']);
    } finally { await srv.close(); }
  });

  it('Notification idle_prompt reports status idle; permission_prompt keeps waiting', async () => {
    const srv = await fakeServer();
    try {
      const idlePayload = { hook_event_name: 'Notification', notification_type: 'idle_prompt', cwd: tmp };
      const a = await runHook(['waiting', String(srv.port)], idlePayload, { STRADO_AGENT_TOKEN: 'tok-1' });
      expect(a.stdout).toBe('');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status']);
      expect(srv.hits[0]!.body).toMatchObject({ status: 'idle' });
      srv.hits.length = 0;

      const permPayload = { hook_event_name: 'Notification', notification_type: 'permission_prompt', cwd: tmp };
      const b = await runHook(['waiting', String(srv.port)], permPayload, { STRADO_AGENT_TOKEN: 'tok-1' });
      expect(b.stdout).toBe('');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status']);
      expect(srv.hits[0]!.body).toMatchObject({ status: 'waiting' });
    } finally { await srv.close(); }
  });

  it('hook route failing (503) → no stdout, no confirm, exit 0', async () => {
    const srv = await fakeServer({ status: 503, body: { error: { code: 'UNAVAILABLE' } } });
    try {
      const r = await runHook(['working', String(srv.port)], payload('UserPromptSubmit'), { STRADO_AGENT_TOKEN: 'tok-1' });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status', '/api/intercom/hook']);
    } finally { await srv.close(); }
  });

  it('over the sandbox socket the transport is "socket"', async () => {
    const sock = path.join(tmp, 'hook.sock');
    const srv = await fakeServer({ body: { additionalContext: CTX, batchId: 'B3', delivered: 1, acknowledged: 0 } }, sock);
    try {
      const r = await runHook(['working', '0'], payload('UserPromptSubmit'), { STRADO_AGENT_TOKEN: 'tok-1', STRADO_SERVER_SOCKET: sock });
      expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(CTX);
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status', '/api/intercom/hook', '/api/intercom/hook/confirm']);
      expect(srv.hits[1]!.body).toEqual({ event: 'UserPromptSubmit', transport: 'socket' });
    } finally { await srv.close(); }
  });

  // The confirm-after-print rule's OTHER failure mode: the print itself fails
  // (a closed/broken stdout pipe), as opposed to the 503 case above where the
  // hook route call fails before a print is even attempted. Destroying the
  // child's stdout read end from the parent side reproduces a closed pipe: the
  // child's write raises EPIPE, which must be swallowed rather than crashing
  // the hook — no confirm follows, and the hook still exits 0.
  it('closed stdout pipe on the context write: no confirm, exit 0', async () => {
    const srv = await fakeServer({ body: { additionalContext: CTX, batchId: 'B4', delivered: 1, acknowledged: 0 } });
    try {
      const { spawn } = await import('node:child_process');
      const merged: Record<string, string | undefined> = {
        ...process.env,
        STRADO_SERVER_SOCKET: undefined,
        STRADO_SESSION_MODE: undefined,
        STRADO_SESSION_ID: undefined,
        STRADO_AGENT_TOKEN: 'tok-1',
      };
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
      const child = spawn(process.execPath, [SCRIPT, 'working', String(srv.port)], { env: clean, cwd: tmp });
      child.stdout.destroy(); // close the read end before the hook can write its context line
      child.stdin.end(JSON.stringify(payload('UserPromptSubmit')));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code).toBe(0);
      expect(srv.hits.map((h) => h.url)).toEqual(['/api/claude/status', '/api/intercom/hook']);
    } finally { await srv.close(); }
  });
});
