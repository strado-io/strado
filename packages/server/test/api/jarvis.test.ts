import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { exec } from '../../src/shell';
import { claudeKey, shellKey } from '../../src/services/terminalManager';
import { ACTIONS } from '../../src/services/actions';
import { createJarvisModel } from '../../src/services/jarvisModel';
import { PLAN_PER_MINUTE, SECRET_PATTERN_SOURCES } from '../../src/routes/jarvis';
import { previewTools } from '../../hooks/mcp/preview.mjs';
import { intercomTools } from '../../hooks/mcp/intercom.mjs';
import { appTools } from '../../hooks/mcp/app.mjs';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let deps: Awaited<ReturnType<typeof buildDeps>>;
let tok: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-jarvis-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a'), '1');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });
  deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST', url: '/api/w/default/repos',
    payload: { id: 'app', name: 'App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 3000, editor: 'code' },
  });
  await deps.terminal.ensure(claudeKey(repo, '1'), repo, { file: 'cat', args: [] });
  tok = (await deps.agents.register({ key: claudeKey(repo, '1'), cwd: repo, scopeId: 'default' })).token;
});

afterEach(async () => {
  app.deps.terminal.killUnder(tmp);
  await vi.waitFor(() => expect(app.deps.terminal.liveSessions().filter((s) => s.path.startsWith(tmp + path.sep))).toEqual([]), { timeout: 5000 });
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const hub = () => ({ 'x-strado-hub-token': deps.hubToken });
const post = (url: string, payload: unknown, headers: Record<string, string> = hub()) =>
  app.inject({ method: 'POST', url: `/api/w/default${url}`, headers, payload: payload as Record<string, unknown> });
const shellRef = (id: string) => ({ worktreePath: repo, mode: 'shell', sessionId: id });

async function liveShell(id: string): Promise<void> {
  await deps.terminal.ensure(shellKey(repo, id), repo, { file: '/bin/sh', args: ['-i'] });
  await deps.agents.register({ key: shellKey(repo, id), cwd: repo, scopeId: 'default' });
  const start = Date.now();
  while (!deps.terminal.snapshot(shellKey(repo, id)).includes('$') && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 25));
}

describe('jarvis: hub session and guards', () => {
  it('hands the token only to a loopback hub', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/jarvis/session' });
    expect(ok.json()).toEqual({ token: deps.hubToken });
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/api/jarvis/session', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/jarvis/session', headers: { host: 'rebind.example:7777' } })).statusCode).toBe(403);
  });

  it('every human route needs the token and a hub origin', async () => {
    for (const r of ['spawn', 'run', 'interrupt', 'close', 'message']) {
      expect((await post(`/jarvis/${r}`, {}, {})).statusCode, r).toBe(401);
      expect((await post(`/jarvis/${r}`, {}, { 'x-strado-hub-token': 'nope' })).statusCode, r).toBe(401);
      expect((await post(`/jarvis/${r}`, {}, { ...hub(), origin: 'null' })).statusCode, r).toBe(403);
    }
  });

  it('serves the action registry', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jarvis/actions' });
    expect(res.json().actions.map((a: { id: string }) => a.id)).toContain('tab.close');
  });
});

describe('jarvis: actions as the human', () => {
  it('spawns a shell and runs a command (no spawn guard applies)', async () => {
    for (let i = 0; i < 7; i += 1) {
      const res = await post('/jarvis/spawn', { mode: 'shell', worktreePath: repo, ...(i === 0 ? { command: 'echo jarvis-ok' } : {}) });
      expect(res.statusCode).toBe(201);
      if (i === 0) {
        expect(res.json().agent).toMatchObject({ mode: 'shell', worktreePath: repo, sessionId: '1' });
        expect(res.json().command.output).toContain('jarvis-ok');
      }
    }
  }, 60_000);

  it('runs in, interrupts and closes an existing shell', async () => {
    await liveShell('4');
    const run = await post('/jarvis/run', { target: shellRef('4'), command: 'echo ran-here' });
    expect(run.json().output).toContain('ran-here');
    expect((await post('/jarvis/interrupt', { target: shellRef('4') })).json()).toEqual({ ok: true });
    expect((await post('/jarvis/close', { target: shellRef('4') })).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(deps.terminal.liveSessions().some((s) => s.mode === 'shell' && s.id === '4')).toBe(false), { timeout: 5000 });
    expect((await post('/jarvis/close', { target: shellRef('4') })).statusCode).toBe(404);
  }, 30_000);

  it('refuses a reused session number when the executionId does not match', async () => {
    const first = (await post('/jarvis/spawn', { mode: 'shell', worktreePath: repo })).json();
    const old = { ...shellRef(first.agent.sessionId), executionId: first.agent.executionId };
    expect(first.agent.executionId).toEqual(expect.any(String));
    await post('/jarvis/close', { target: old });
    await vi.waitFor(() => expect(deps.terminal.liveSessions().some((s) => s.mode === 'shell')).toBe(false), { timeout: 5000 });
    const second = (await post('/jarvis/spawn', { mode: 'shell', worktreePath: repo })).json();
    expect(second.agent.sessionId).toBe(first.agent.sessionId);
    const res = await post('/jarvis/close', { target: old });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ reason: 'tab_replaced' });
    expect(deps.terminal.liveSessions().some((s) => s.mode === 'shell')).toBe(true);
  }, 30_000);

  it('validates targets and bodies', async () => {
    expect((await post('/jarvis/run', { target: { worktreePath: repo, mode: 'claude', sessionId: '1' }, command: 'ls' })).statusCode).toBe(400);
    expect((await post('/jarvis/spawn', { mode: 'claude', worktreePath: repo, command: 'ls' })).statusCode).toBe(400);
    expect((await post('/jarvis/spawn', { mode: 'shell', worktreePath: '/etc' })).statusCode).toBe(400);
    expect((await post('/jarvis/spawn', { mode: 'shell', worktreePath: repo, extra: 1 })).statusCode).toBe(400);
  });

  it('lists package.json scripts and the package manager', async () => {
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } }));
    await fs.writeFile(path.join(repo, 'pnpm-lock.yaml'), '');
    const res = await app.inject({ method: 'GET', url: `/api/w/default/jarvis/scripts?worktreePath=${encodeURIComponent(repo)}`, headers: hub() });
    expect(res.json()).toEqual({ packageManager: 'pnpm', scripts: ['dev', 'test'], runCommands: [{ id: 'dev', name: 'dev' }] });
    expect((await app.inject({ method: 'GET', url: `/api/w/default/jarvis/scripts?worktreePath=${encodeURIComponent('/etc')}`, headers: hub() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/w/default/jarvis/scripts?worktreePath=${encodeURIComponent(repo)}` })).statusCode).toBe(401);
  });

  it('a fresh shell that has printed nothing yet is not "settled": the command waits for its first output', async () => {
    const realQuiet = deps.ptyActivity.quiet.bind(deps.ptyActivity);
    let silentUntil = Date.now() + 1500; // a slow, quiet profile: no prompt for 1.5 s
    deps.ptyActivity.quiet = (key: string) => (Date.now() < silentUntil ? { input: Infinity, output: Infinity } : realQuiet(key));
    const realRun = deps.shellRunner.run.bind(deps.shellRunner);
    let typedAt = 0;
    deps.shellRunner.run = (key, command, opts) => { typedAt = Date.now(); return realRun(key, command, opts); };
    const started = Date.now();
    silentUntil = started + 1500;
    const res = await post('/jarvis/spawn', { mode: 'shell', worktreePath: repo, command: 'echo quiet-profile' });
    expect(res.statusCode).toBe(201);
    expect(typedAt - started).toBeGreaterThanOrEqual(1500);
  }, 30_000);

  it('a run right after a spawn waits for the new shell, then runs', async () => {
    const spawned = (await post('/jarvis/spawn', { mode: 'shell', worktreePath: repo })).json();
    const run = await post('/jarvis/run', { target: shellRef(spawned.agent.sessionId), command: 'echo after-spawn' });
    expect(run.json()).toMatchObject({ settled: true });
    expect(run.json().output).toContain('after-spawn');
  }, 30_000);

  it('refuses a message to a shell (nothing would ever read it)', async () => {
    await liveShell('4');
    const res = await post('/jarvis/message', { to: 'shell-4@repo', body: 'hi' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toMatchObject({ reason: 'shell_target' });
  }, 30_000);

  it('a message to an agent always goes through the intercom (its words are never typed); an agent at rest is told it has mail', async () => {
    const realList = deps.agents.list.bind(deps.agents);
    let lifecycle = 'starting'; // a Claude with no status since a restart: the inbox push skips it
    deps.agents.list = async (scopeId: string) => (await realList(scopeId)).map((a) => a.agentId === 'claude-1@repo'
      ? { ...a, live: true, lifecycle: lifecycle as typeof a.lifecycle } : a);
    const nudge = vi.fn(async () => 'sent' as const);
    deps.intercomPush.nudge = nudge;
    const inbox = async () => (await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: { authorization: `Bearer ${tok}` }, payload: {} })).json().messages.map((m: { from: { agentId: string }; body: string }) => [m.from.agentId, m.body]);

    const sent = await post('/jarvis/message', { to: 'claude-1@repo', body: 'how are you ?' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ delivered: 'sent', to: { agentId: 'claude-1@repo' } });
    // Only the notice crosses the PTY; the words wait in the inbox.
    expect(nudge).toHaveBeenCalledWith(claudeKey(repo, '1'), expect.stringMatching(/^New intercom messages \(1\)/));
    expect(nudge.mock.calls.flat().join(' ')).not.toContain('how are you');
    expect(await inbox()).toEqual([['human', 'how are you ?']]);

    // Idle: the inbox push tells it (no second notice from the route). Busy: it reads it after the turn.
    for (const [lc, delivered] of [['idle', 'sent'], ['working', 'queued'], ['needs_input', 'queued']] as const) {
      lifecycle = lc;
      expect((await post('/jarvis/message', { to: 'claude-1@repo', body: `msg ${lc}` })).json()).toMatchObject({ delivered });
    }
    expect(nudge).toHaveBeenCalledTimes(1);
    // Anything goes in the inbox, control characters and all: nothing is typed.
    expect((await post('/jarvis/message', { to: 'claude-1@repo', body: 'line 1\nline 2\tx' })).json()).toMatchObject({ delivered: 'queued' });
    expect((await inbox()).map(([, b]: [string, string]) => b).sort()).toEqual(['line 1\nline 2\tx', 'msg idle', 'msg needs_input', 'msg working'].sort());
  });

  it('an ask is an intercom request; the agent may answer the human, and only that question', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    deps.bus.on('intercom', (e: { type: string; data: Record<string, unknown> }) => { events.push(e); });
    const asked = await post('/jarvis/message', { to: 'claude-1@repo', body: 'do the tests pass?', ask: true });
    expect(asked.statusCode).toBe(201);
    const { id } = asked.json();
    expect(asked.json()).toMatchObject({ ask: true, to: { agentId: 'claude-1@repo' } });

    const agentSend = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/intercom/messages', headers: { authorization: `Bearer ${tok}` }, payload });
    // The inbox block names the person and tells the agent to answer through the intercom.
    const pulled = (await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: { authorization: `Bearer ${tok}` }, payload: {} })).json().messages;
    expect(pulled).toEqual([expect.objectContaining({ id, kind: 'request', body: 'do the tests pass?' })]);

    // Out of the blue, or a plain message: still refused.
    expect((await agentSend({ to: 'human', body: 'hi' })).statusCode).toBe(400);
    const answered = await agentSend({ to: 'human', kind: 'reply', replyTo: id, body: 'Yes, all 42 pass.' });
    expect(answered.statusCode).toBe(201);
    // Once only.
    expect((await agentSend({ to: 'human', kind: 'reply', replyTo: id, body: 'again' })).statusCode).toBe(409);
    expect(events).toContainEqual({ type: 'message.queued', data: expect.objectContaining({ from: 'claude-1@repo', to: 'human', kind: 'reply', replyTo: id }) });
    const feed = (await app.inject({ method: 'GET', url: '/api/w/default/intercom/messages?agent=claude-1@repo' })).json().messages;
    expect(feed).toContainEqual(expect.objectContaining({ kind: 'reply', replyTo: id, body: 'Yes, all 42 pass.' }));
  });

  it('an ask can carry context (the Files tab sends the lines it is about); a malformed context is refused', async () => {
    const context = [
      { kind: 'file', value: 'src/app.ts:3-5', label: 'src/app.ts' },
      { kind: 'text', value: 'const a = 1;\nconst b = 2;', label: 'snippet' },
    ];
    const asked = await post('/jarvis/message', { to: 'claude-1@repo', body: 'why is b 2?', ask: true, context });
    expect(asked.statusCode).toBe(201);
    const pulled = (await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: { authorization: `Bearer ${tok}` }, payload: {} })).json().messages;
    expect(pulled).toEqual([expect.objectContaining({ kind: 'request', body: 'why is b 2?', context })]);

    expect((await post('/jarvis/message', { to: 'claude-1@repo', body: 'x', context: [{ kind: 'shell', value: 'rm -rf /' }] })).statusCode).toBe(400);
    expect((await post('/jarvis/message', { to: 'claude-1@repo', body: 'x', context: 'nope' })).statusCode).toBe(400);
    // Capped well under the intercom's own limit: a few items, each at most 8 KB (bytes, not chars).
    const big = (n: number) => [{ kind: 'text', value: 'é'.repeat(n) }];
    expect((await post('/jarvis/message', { to: 'claude-1@repo', body: 'x', context: big(4096) })).statusCode).toBe(201);
    expect((await post('/jarvis/message', { to: 'claude-1@repo', body: 'x', context: big(4097) })).statusCode).toBe(400);
    const many = Array.from({ length: 5 }, () => ({ kind: 'text', value: 'a' }));
    expect((await post('/jarvis/message', { to: 'claude-1@repo', body: 'x', context: many })).statusCode).toBe(400);
  });

  it('recap: reads saved turns (nothing is sent to the agent), hides secret-looking lines, and asks the model for a short answer', async () => {
    const recap = vi.fn(async () => ({ text: 'claude-1 fixed the redirect.', model: 'm', ms: 1 }));
    deps.jarvisModel = { plan: vi.fn(), recap };
    const nudge = vi.fn(async () => 'sent' as const);
    deps.intercomPush.nudge = nudge;
    const t = Date.now();
    deps.intercom.recordTurns('default', 'claude-1@repo', 'sid', [
      { turnIndex: 0, prompt: 'fix the login redirect', promptTruncated: false, reply: 'Fixed it.\napi_key=abc123\nTests pass.', replyTruncated: false, startedAt: t - 1000, endedAt: t - 500 },
    ]);
    const res = await post('/jarvis/recap', { agents: ['claude-1@repo'], question: 'what has claude-1 done?' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: 'claude-1 fixed the redirect.', agents: [{ agentId: 'claude-1@repo' }] });
    const input = (recap.mock.calls[0] as unknown[])[0] as { question: string; agents: Array<{ name: string; turns: Array<{ asked: string; answered: string }> }> };
    expect(input.question).toBe('what has claude-1 done?');
    expect(input.agents[0]).toMatchObject({ name: 'claude-1@repo', turns: [{ asked: 'fix the login redirect' }] });
    expect(input.agents[0]!.turns[0]!.answered).toBe('Fixed it.\n[hidden: looked like a secret]\nTests pass.');
    expect(nudge).not.toHaveBeenCalled();

    // all: every agent (shells have no turns and are left out).
    await liveShell('5');
    expect((await post('/jarvis/recap', { all: true })).json().agents.map((a: { agentId: string }) => a.agentId)).toEqual(['claude-1@repo']);
    // Validation: one of agents / all; an unknown agent is a 404.
    expect((await post('/jarvis/recap', {})).statusCode).toBe(400);
    expect((await post('/jarvis/recap', { agents: ['claude-1@repo'], all: true })).statusCode).toBe(400);
    expect((await post('/jarvis/recap', { agents: ['nobody-9'] })).statusCode).toBe(404);
    expect((await post('/jarvis/recap', { agents: ['claude-1@repo'] }, {})).statusCode).toBe(401);
  }, 30_000);

  it('recap: no saved turns answers without a model call; local only refuses', async () => {
    const recap = vi.fn();
    deps.jarvisModel = { plan: vi.fn(), recap };
    const quiet = await post('/jarvis/recap', { agents: ['claude-1@repo'] });
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json().text).toMatch(/^claude-1@repo has no finished turns yet/);
    expect(recap).not.toHaveBeenCalled();

    const prevHome = process.env.STRADO_HOME;
    process.env.STRADO_HOME = path.join(tmp, 'strado-home');
    try {
      await app.inject({ method: 'PUT', url: '/api/profile', payload: { jarvisLocalOnly: true } });
      deps.intercom.recordTurns('default', 'claude-1@repo', 'sid', [
        { turnIndex: 0, prompt: 'p', promptTruncated: false, reply: 'r', replyTruncated: false, startedAt: 1, endedAt: 2 },
      ]);
      const res = await post('/jarvis/recap', { agents: ['claude-1@repo'] });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.details).toMatchObject({ reason: 'local_only' });
      expect(recap).not.toHaveBeenCalled();
    } finally {
      if (prevHome === undefined) delete process.env.STRADO_HOME; else process.env.STRADO_HOME = prevHome;
    }
  });

  it("a new agent's first prompt goes through the intercom too: only the notice is typed", async () => {
    // Stand a `cat` in for the Claude CLI.
    const realEnsure = deps.terminal.ensure.bind(deps.terminal);
    deps.terminal.ensure = ((key: string, cwd: string, _spec: unknown, size?: unknown) =>
      realEnsure(key, cwd, { file: 'cat', args: [] }, size as never)) as typeof deps.terminal.ensure;
    const realList = deps.agents.list.bind(deps.agents);
    deps.agents.list = async (scopeId: string) => (await realList(scopeId)).map((a) => a.mode === 'claude' ? { ...a, live: true, lifecycle: 'idle' as const } : a);
    const nudge = vi.fn(async () => 'sent' as const);
    deps.intercomPush.nudge = nudge;

    const res = await post('/jarvis/spawn', { mode: 'claude', worktreePath: repo, prompt: 'how are you' });
    expect(res.statusCode).toBe(201);
    const { agent } = res.json();
    expect(agent.agentId).toBe('claude-2@repo');
    await vi.waitFor(() => expect(nudge).toHaveBeenCalled(), { timeout: 5000 });
    expect(nudge).toHaveBeenCalledWith(claudeKey(repo, '2'), expect.stringMatching(/^New intercom messages \(1\)/));
    expect(nudge.mock.calls.flat().join(' ')).not.toContain('how are you');
    const msgs = (await deps.intercom.peek('default', 'claude-2@repo', 50)) as Array<{ body: string; from: { agentId: string } }>;
    expect(msgs.map((m) => [m.from.agentId, m.body])).toEqual([['human', 'how are you']]);
  }, 30_000);
});

describe('jarvis: natural-language plan route', () => {
  const ctx = { worktree: null, focused: null, tabs: [], worktrees: [], focuses: [], scripts: [], packageManager: 'npm', agents: [] };

  it('adds what the model needs to answer "what does X want" and "what tasks are open": call bodies and the task board', async () => {
    const agent = { authorization: `Bearer ${tok}` };
    await app.inject({ method: 'POST', url: '/api/intercom/escalations', headers: agent, payload: { title: 'Which DB', body: 'Postgres or SQLite for the cache?' } });
    await app.inject({ method: 'POST', url: '/api/intercom/tasks', headers: agent, payload: { title: 'Fix the login test' } });
    const claimed = (await app.inject({ method: 'POST', url: '/api/intercom/tasks', headers: agent, payload: { title: 'Bump deps' } })).json().task;
    await app.inject({ method: 'POST', url: `/api/intercom/tasks/${claimed.id}/claim`, headers: agent });
    const plan = vi.fn(async () => ({ kind: 'answer' as const, text: 'ok', model: 'm', ms: 1 }));
    deps.jarvisModel = { plan };
    await post('/jarvis/plan', { text: 'what does claude-1 want', context: { ...ctx, calls: [{ from: 'claude-1', title: 'Which DB' }] }, thread: [] });
    const sent = (plan.mock.calls[0] as unknown as [{ context: { calls: unknown[]; tasks: unknown[] } }])[0].context;
    expect(sent.calls).toEqual([{ from: 'claude-1', title: 'Which DB', body: 'Postgres or SQLite for the cache?' }]);
    expect(sent.tasks).toEqual([{ title: 'Fix the login test', status: 'open' }, { title: 'Bump deps', status: 'claimed', by: 'claude-1' }]);
  });

  it('passes text, context and thread to the model and returns its result', async () => {
    const plan = vi.fn(async () => ({ kind: 'plan' as const, steps: [{ action: 'tab.open', args: { mode: 'shell' } }], model: 'claude-haiku-5-5', ms: 12 }));
    deps.jarvisModel = { plan };
    const res = await post('/jarvis/plan', { text: 'shell please', context: ctx, thread: [{ role: 'user', text: 'hi' }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'plan', steps: [{ action: 'tab.open' }] });
    // calls/repos/runCommands default to [] for an older box that does not send them.
    expect(plan.mock.calls[0]![0]).toEqual({ text: 'shell please', context: { ...ctx, focus: null, workspace: null, workspaces: [], calls: [], repos: [], runCommands: [], tasks: [] }, thread: [{ role: 'user', text: 'hi' }] });
  });

  it('the open Focus and each Focus\'s worktrees reach the model; an older box without them still works', async () => {
    const plan = vi.fn(async () => ({ kind: 'answer' as const, text: 'ok', model: 'm', ms: 1 }));
    deps.jarvisModel = { plan, recap: vi.fn() };
    const withFocus = { ...ctx, worktrees: [{ name: 'main', branch: 'main', repo: 'Strado Website' }], focus: { name: 'release' }, focuses: [{ name: 'release', worktrees: ['FD-29', 'main'] }, { name: 'test' }] };
    expect((await post('/jarvis/plan', { text: 'what is in this focus', context: withFocus, thread: [] })).statusCode).toBe(200);
    expect(plan.mock.calls[0]![0].context).toMatchObject({ worktrees: [{ name: 'main', repo: 'Strado Website' }], focus: { name: 'release' }, focuses: [{ name: 'release', worktrees: ['FD-29', 'main'] }, { name: 'test', worktrees: [] }] });
    // Older box: no focus field, Focus entries without worktrees.
    expect((await post('/jarvis/plan', { text: 'x', context: ctx, thread: [] })).statusCode).toBe(200);
    expect(plan.mock.calls[1]![0].context).toMatchObject({ focus: null });
    // Bounded like the rest of the context.
    const huge = { ...ctx, focuses: [{ name: 'big', worktrees: Array.from({ length: 31 }, (_, i) => `wt-${i}`) }] };
    expect((await post('/jarvis/plan', { text: 'x', context: huge, thread: [] })).statusCode).toBe(400);
  });

  it('the current workspace and the workspace list reach the model; an older box without them still works', async () => {
    const plan = vi.fn(async () => ({ kind: 'answer' as const, text: 'ok', model: 'm', ms: 1 }));
    deps.jarvisModel = { plan, recap: vi.fn() };
    const withWs = { ...ctx, workspace: { name: 'FleetX' }, workspaces: [{ name: 'FleetX' }, { name: 'Personal' }] };
    expect((await post('/jarvis/plan', { text: 'which workspace am I in', context: withWs, thread: [] })).statusCode).toBe(200);
    expect(plan.mock.calls[0]![0].context).toMatchObject({ workspace: { name: 'FleetX' }, workspaces: [{ name: 'FleetX' }, { name: 'Personal' }] });
    expect((await post('/jarvis/plan', { text: 'x', context: ctx, thread: [] })).statusCode).toBe(200);
    expect(plan.mock.calls[1]![0].context).toMatchObject({ workspace: null, workspaces: [] });
    const huge = { ...ctx, workspaces: Array.from({ length: 31 }, (_, i) => ({ name: `ws-${i}` })) };
    expect((await post('/jarvis/plan', { text: 'x', context: huge, thread: [] })).statusCode).toBe(400);
  });

  it('Jev and the model race: a confident Jev decision wins and cancels the model; otherwise the model answers', async () => {
    const signals: AbortSignal[] = [];
    const plan = vi.fn(async (_input: unknown, signal?: AbortSignal) => {
      signals.push(signal!);
      return { kind: 'answer' as const, text: 'from haiku', model: 'claude-haiku-5-5', ms: 900 };
    });
    deps.jarvisModel = { plan };
    deps.jevRouter = { route: async () => ({ kind: 'plan', steps: [{ action: 'tab.focus', args: { tab: 'shell-1' } }], model: 'typesafe/jev-1.14', ms: 90 }) };
    expect((await post('/jarvis/plan', { text: 'focus the shell', context: ctx, thread: [] })).json()).toMatchObject({ kind: 'plan', model: 'typesafe/jev-1.14' });
    expect(signals[0]!.aborted).toBe(true); // started in parallel, cancelled once Jev answered
    deps.jevRouter = { route: async () => null };
    expect((await post('/jarvis/plan', { text: 'open google.com', context: ctx, thread: [] })).json()).toMatchObject({ kind: 'answer', text: 'from haiku' });
    expect(signals[1]!.aborted).toBe(false);
  });

  it('the OpenRouter key: presence + last four only, and only the local hub may set it', async () => {
    const prevHome = process.env.STRADO_HOME;
    process.env.STRADO_HOME = path.join(tmp, 'strado-home-router');
    try {
      expect((await app.inject({ method: 'POST', url: '/api/router-credential', headers: { origin: 'https://evil.example' }, payload: { key: 'sk-or-x' } })).statusCode).toBe(403);
      const set = await app.inject({ method: 'POST', url: '/api/router-credential', payload: { key: 'sk-or-v1-abcd1234' } });
      expect(set.json()).toEqual({ present: true, last4: '1234' });
      expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/router-credential' })).json())).not.toContain('abcd');
    } finally {
      if (prevHome === undefined) delete process.env.STRADO_HOME; else process.env.STRADO_HOME = prevHome;
    }
  });

  it('never sends a $ line, validates the body, and needs the hub token', async () => {
    const plan = vi.fn();
    deps.jarvisModel = { plan };
    expect((await post('/jarvis/plan', { text: '  $ export X=1', context: ctx, thread: [] })).statusCode).toBe(400);
    expect((await post('/jarvis/plan', { text: 'x', context: { ...ctx, extra: 1 }, thread: [] })).statusCode).toBe(400);
    expect((await post('/jarvis/plan', { text: 'x', context: ctx, thread: [] }, {})).statusCode).toBe(401);
    expect(plan).not.toHaveBeenCalled();
  });

  it('refuses secret-looking text or thread, and a thread that does not alternate user-first', async () => {
    const plan = vi.fn();
    deps.jarvisModel = { plan };
    const reason = async (body: unknown) => { const r = await post('/jarvis/plan', body); expect(r.statusCode).toBe(400); return r.json().error.details?.reason; };
    expect(await reason({ text: 'set API_KEY=abc in the shell', context: ctx, thread: [] })).toBe('secret');
    expect(await reason({ text: 'ok', context: ctx, thread: [{ role: 'user', text: 'use ghp_' + 'a'.repeat(30) }, { role: 'assistant', text: 'ok' }] })).toBe('secret');
    expect(await reason({ text: 'ok', context: ctx, thread: [{ role: 'assistant', text: 'hi' }] })).toBe('thread');
    expect(await reason({ text: 'ok', context: ctx, thread: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }] })).toBe('thread');
    expect(plan).not.toHaveBeenCalled();
  });

  it(`caps model calls at ${PLAN_PER_MINUTE} a minute`, async () => {
    const plan = vi.fn(async () => ({ kind: 'answer' as const, text: 'ok', model: 'm', ms: 1 }));
    deps.jarvisModel = { plan, recap: vi.fn() };
    deps.jevRouter = { route: async () => null }; // the cap, not the router's network
    for (let i = 0; i < PLAN_PER_MINUTE; i++) expect((await post('/jarvis/plan', { text: 'x', context: ctx, thread: [] })).statusCode).toBe(200);
    const res = await post('/jarvis/plan', { text: 'x', context: ctx, thread: [] });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.details).toMatchObject({ reason: 'rate_limited' });
    expect(plan).toHaveBeenCalledTimes(PLAN_PER_MINUTE);
  });

  it('only the local hub may set the model key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/model-credential', headers: { origin: 'https://evil.example' }, payload: { key: 'x' } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/profile', headers: { host: 'rebind.example:4000' }, payload: { jarvisLocalOnly: true } })).statusCode).toBe(403);
  });

  it('local only (profile) refuses before any model call', async () => {
    const plan = vi.fn();
    deps.jarvisModel = { plan };
    const prevHome = process.env.STRADO_HOME;
    process.env.STRADO_HOME = path.join(tmp, 'strado-home');
    try {
      await app.inject({ method: 'PUT', url: '/api/profile', payload: { jarvisLocalOnly: true } });
      const res = await post('/jarvis/plan', { text: 'x', context: ctx, thread: [] });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.details).toMatchObject({ reason: 'local_only' });
      expect(plan).not.toHaveBeenCalled();
    } finally {
      if (prevHome === undefined) delete process.env.STRADO_HOME; else process.env.STRADO_HOME = prevHome;
    }
  });

  it('no key surfaces as 503 reason no_key', async () => {
    deps.jarvisModel = createJarvisModel({ readKey: async () => null });
    const res = await post('/jarvis/plan', { text: 'x', context: ctx, thread: [] });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.details).toMatchObject({ reason: 'no_key' });
  });
});

describe('agent close / interrupt', () => {
  const agentPost = (url: string, t = tok) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${t}` }, payload: {} });

  it('acts at once on a tab the agent spawned', async () => {
    const spawned = await app.inject({ method: 'POST', url: '/api/intercom/agents/spawn', headers: { authorization: `Bearer ${tok}` }, payload: { mode: 'shell', place: null } });
    const child = spawned.json().agent.agentId;
    expect((await agentPost(`/api/intercom/agents/${child}/interrupt`)).json()).toMatchObject({ status: 'done' });
    expect((await agentPost(`/api/intercom/agents/${child}/close`)).json()).toMatchObject({ status: 'done' });
    await vi.waitFor(() => expect(deps.terminal.liveSessions().some((s) => s.mode === 'shell')).toBe(false), { timeout: 5000 });
  }, 30_000);

  it('asks the human for any other tab, and never closes it', async () => {
    await liveShell('7');
    const res = await agentPost('/api/intercom/agents/shell-7@repo/close');
    expect(res.json()).toMatchObject({ status: 'needs_human', target: { agentId: 'shell-7@repo' } });
    const esc = deps.intercom.getEscalation('default', res.json().escalationId);
    expect(esc).toMatchObject({ to: 'human', status: 'open' });
    expect(esc.title).toBe('claude-1@repo wants to close shell-7@repo');
    expect(deps.terminal.liveSessions().some((s) => s.mode === 'shell' && s.id === '7')).toBe(true);
  }, 30_000);

  it('refuses its own tab', async () => {
    expect((await agentPost('/api/intercom/agents/claude-1@repo/close')).statusCode).toBe(400);
  });
});

describe('action registry contract', () => {
  it('the server refuses exactly the secrets the box refuses (same patterns as web lib/jarvis/history.ts)', async () => {
    const src = await fs.readFile(path.resolve(__dirname, '../../../web/src/lib/jarvis/history.ts'), 'utf8');
    const block = src.slice(src.indexOf('const SECRET_PATTERNS'), src.indexOf('];', src.indexOf('const SECRET_PATTERNS')));
    const web = [...block.matchAll(/^\s*\/(.+)\/([a-z]*),(?:\s*\/\/.*)?$/gm)].map((m) => `${m[1]}/${m[2]}`);
    expect(web.length).toBeGreaterThan(10);
    expect(SECRET_PATTERN_SOURCES()).toEqual(web);
  });

  it('every MCP tool it names exists, and every app-control MCP tool is in it', () => {
    const tools = new Set([...previewTools({}), ...intercomTools({}), ...appTools({})].map((t: { name: string }) => t.name));
    const named = new Set(ACTIONS.flatMap((a) => a.mcp ?? []));
    for (const n of named) expect(tools.has(n), `registry names missing MCP tool ${n}`).toBe(true);
    for (const t of ['agent_spawn', 'ui_place', 'preview_open', 'ui_state', 'agent_close', 'shell_interrupt', 'agent_wait']) {
      expect(named.has(t), `MCP tool ${t} is not in the action registry`).toBe(true);
    }
  });

  it('every jarvis route it names is registered', async () => {
    for (const a of ACTIONS.filter((x) => x.jarvis)) {
      const res = await app.inject({ method: 'POST', url: `/api/w/default${a.jarvis}`, payload: {} });
      expect(res.statusCode, `${a.id} → ${a.jarvis}`).not.toBe(404);
    }
  });

  it("the command box's ACTION_IDS (web lib/jarvis/types.ts) equal the registry", async () => {
    const src = await fs.readFile(path.join(__dirname, '../../../web/src/lib/jarvis/types.ts'), 'utf8');
    const list = /export const ACTION_IDS\s*=\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
    const webIds = [...list.matchAll(/'([a-z]+\.[a-z][A-Za-z]*)'/g)].map((m) => m[1]);
    expect(webIds).toEqual(ACTIONS.map((x) => x.id));
  });

  it('ids are unique and well-formed', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+\.[a-z][A-Za-z]*$/);
  });
});

describe('jarvis: a message to an agent that is calling you answers the call', () => {
  const agent = () => ({ authorization: `Bearer ${tok}` });
  const escalate = async (title: string) =>
    (await app.inject({ method: 'POST', url: '/api/intercom/escalations', headers: agent(), payload: { title, body: `${title}?` } })).json().escalation as { id: string };
  const stationOf = async () => (await app.inject({ method: 'GET', url: '/api/w/default/intercom/stations' })).json().stations
    .find((s: { mode: string }) => s.mode === 'claude') as { agentId: string; needsYou: boolean; calls: { id: string }[] };
  const inbox = async () => (await app.inject({ method: 'POST', url: '/api/intercom/pull', headers: agent(), payload: {} })).json();

  it('the oldest open call gets the box message as its answer; the call closes; the station stops needing you', async () => {
    const first = await escalate('Which DB');
    const second = await escalate('Ship it');
    const st = await stationOf();
    expect(st.needsYou).toBe(true);

    const res = await post('/jarvis/message', { to: st.agentId, body: 'postgres' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ answered: { callId: first.id, title: 'Which DB' }, to: { agentId: st.agentId } });
    // The agent reads it as the answer to its call (its inbox first: polling
    // the call itself also hands the answer over, and clears that copy).
    const pulled = await inbox();
    expect(pulled.messages.map((m: { body: string; escalationId?: string }) => [m.body, m.escalationId])).toEqual([['postgres', first.id]]);
    const resolved = (await app.inject({ method: 'GET', url: `/api/intercom/escalations/${first.id}`, headers: agent() })).json().escalation;
    expect(resolved).toMatchObject({ status: 'resolved', resolution: 'postgres' });

    // The next message answers the next call; then plain messages again.
    expect((await post('/jarvis/message', { to: st.agentId, body: 'yes' })).json()).toMatchObject({ answered: { callId: second.id } });
    expect((await stationOf()).needsYou).toBe(false);
    const plain = (await post('/jarvis/message', { to: st.agentId, body: 'thanks' })).json();
    expect(plain).not.toHaveProperty('answered');
  });

  it('two calls in the same millisecond: still the first one asked', async () => {
    const at = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const ids: string[] = [];
    try { for (const t of ['A', 'B', 'C', 'D', 'E']) ids.push((await escalate(t)).id); } finally { at.mockRestore(); }
    const to = (await stationOf()).agentId;
    for (const id of ids) expect((await post('/jarvis/message', { to, body: 'ok' })).json()).toMatchObject({ answered: { callId: id } });
  });

  it('an ask (ask: true) never answers a call: it is a new question', async () => {
    await escalate('Which DB');
    const res = (await post('/jarvis/message', { to: (await stationOf()).agentId, body: 'why?', ask: true })).json();
    expect(res).not.toHaveProperty('answered');
    expect((await stationOf()).needsYou).toBe(true);
  });
});
