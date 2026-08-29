import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';
import { createTerminalManager, claudeKey, codexKey } from '../../src/services/terminalManager';
import type { TerminalManager, SpawnSpec } from '../../src/services/terminalManager';
import { WebSocket } from 'ws';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const originalInproc = process.env.STRADO_INPROC_PTY;

beforeEach(async () => {
  process.env.STRADO_INPROC_PTY = '1';
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-handoff-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'app.ts'), 'export const value = 1;\n');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
    agentHomeDir: path.join(tmp, 'agents'),
  });
  deps.terminal = createTerminalManager(() => ({ file: 'cat', args: [] }));
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'app', name: 'App', path: repo, projectSubdir: null,
      startCommand: 'true', defaultPort: 3000, editor: 'code',
    },
  });
});

afterEach(async () => {
  app?.deps.terminal.killUnder(repo);
  await app?.close();
  await fs.rm(tmp, { recursive: true, force: true });
  if (originalInproc === undefined) delete process.env.STRADO_INPROC_PTY;
  else process.env.STRADO_INPROC_PTY = originalInproc;
});

describe('agent handoffs', () => {
  it('persists provider messages and Git state without copying the terminal screen', async () => {
    await app.deps.terminal.ensure(claudeKey(repo, '1'), repo);
    app.deps.terminal.write(claudeKey(repo, '1'), '\x1b[32mRAW TUI STATUS BAR\x1b[0m\nMCP warning\n');
    const transcriptPath = path.join(tmp, 'agents', '.claude', 'projects', 'fixture', 'provider-123.jsonl');
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Implement the parser' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Parser implemented. Next: add edge-case tests.' }] } }),
    ].join('\n'));
    await app.deps.agentSessions.set({
      mode: 'claude', worktreePath: repo, sessionId: '1', providerSessionId: 'provider-123', transcriptPath,
    });
    await fs.writeFile(path.join(repo, 'app.ts'), 'export const value = 2;\n');

    const response = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/handoffs`,
      payload: {
        source: { mode: 'claude', sessionId: '1' },
        target: { mode: 'codex', sessionId: '1' },
        notes: 'Preserve the public API',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.handoff.status).toBe('ready');
    expect(body.handoff.source).toEqual({ mode: 'claude', sessionId: '1' });
    expect(body.handoff.target).toEqual({ mode: 'codex', sessionId: '1' });
    expect(body.handoff.contextSource).toBe('claude-history');
    expect(body.handoff.conversation).toEqual([
      { role: 'user', content: 'Implement the parser' },
      { role: 'assistant', content: 'Parser implemented. Next: add edge-case tests.' },
    ]);
    expect(body.prompt).not.toContain('RAW TUI STATUS BAR');
    expect(body.prompt).not.toContain('MCP warning');
    expect(body.handoff.repository.branch).toBe('main');
    expect(body.handoff.repository.status).toContain(' M app.ts');
    expect(body.prompt).toContain('Continue the existing work');
    expect(body.prompt).toContain('Preserve the public API');

    const list = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/handoffs`,
    });
    expect(list.json().handoffs).toHaveLength(1);
    const saved = JSON.parse(await fs.readFile(path.join(tmp, 'config', 'workspaces', 'default', 'handoffs.json'), 'utf8'));
    expect(saved.handoffs[0].id).toBe(body.handoff.id);
  });

  it('reads a Pi source session and can target a fresh Pi tab', async () => {
    // Pi stores sessions per working directory; Strado finds the file by the
    // `session` header's cwd, so the directory name itself never matters.
    const sessionDir = path.join(tmp, 'agents', '.pi', 'agent', 'sessions', 'slug');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, '2026-08-29T10-00-00-000Z_pi-1.jsonl'), [
      JSON.stringify({ type: 'session', version: 3, id: 'pi-1', cwd: repo }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Port the parser' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Parser ported, tests pending.' }] } }),
    ].join('\n'));

    const response = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/handoffs`,
      payload: {
        source: { mode: 'pi', sessionId: '1' },
        target: { mode: 'claude', sessionId: '2' },
        notes: '',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().handoff.contextSource).toBe('pi-history');
    expect(response.json().handoff.conversation).toEqual([
      { role: 'user', content: 'Port the parser' },
      { role: 'assistant', content: 'Parser ported, tests pending.' },
    ]);

    const toPi = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/handoffs`,
      payload: {
        source: { mode: 'claude', sessionId: '1' },
        target: { mode: 'pi', sessionId: '2' },
        notes: '',
      },
    });
    expect(toPi.statusCode).toBe(201);
    expect(toPi.json().handoff.target).toEqual({ mode: 'pi', sessionId: '2' });
  });

  it('refuses to target an already-running session', async () => {
    await app.deps.terminal.ensure(codexKey(repo, '1'), repo);
    const response = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/handoffs`,
      payload: {
        source: { mode: 'claude', sessionId: '1' },
        target: { mode: 'codex', sessionId: '1' },
        notes: '',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PROCESS_ALREADY_RUNNING');
  });

  it('consumes the ready packet when the fresh target session connects', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/handoffs`,
      payload: {
        source: { mode: 'claude', sessionId: '1' },
        target: { mode: 'codex', sessionId: '2' },
        notes: 'Start at the parser test',
      },
    });
    const id = created.json().handoff.id as string;

    let status: 'running' | 'exited' = 'exited';
    let captured: SpawnSpec | undefined;
    const fake: TerminalManager = {
      ensure: async (_key, _cwd, spec) => {
        captured = spec;
        status = 'running';
        return { status: 'running', pid: 123, exitCode: null };
      },
      write: () => undefined,
      resize: () => undefined,
      snapshot: () => '',
      subscribe: () => () => undefined,
      onExit: () => () => undefined,
      status: () => ({ status, pid: status === 'running' ? 123 : null, exitCode: null }),
      kill: () => { status = 'exited'; },
      killUnder: () => undefined,
      liveSessions: () => status === 'running' ? [{ path: repo, mode: 'codex', id: '2' }] : [],
    };
    app.deps.terminal = fake;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?ws=default&path=${encodeURIComponent(repo)}&mode=codex&session=2&handoff=${id}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    let accepted = false;
    const deadline = Date.now() + 5_000;
    while (!accepted && Date.now() < deadline) {
      const list = await app.inject({
        method: 'GET',
        url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/handoffs`,
      });
      accepted = list.json().handoffs[0].status === 'accepted';
      if (!accepted) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(accepted).toBe(true);
    expect(captured?.args.join(' ')).toContain('Start at the parser test');
    expect(captured?.args.join(' ')).not.toContain('resume --last');
    socket.close();
  });
});
