import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { createJarvisExecutor, createJarvisWorktree, outputText, trackAsks, trustWatcher, watchTrust } from '../../src/routes/jarvisTools';
import { commandRuns } from '../../src/services/tabOps';
import { sessionKeyFor } from '../../src/services/terminalManager';
import type { FastifyInstance } from 'fastify';
import type { AgentSummary } from '../../src/services/agentRegistry';
import { exec } from '../../src/shell';
import type { JarvisRunner, TurnRef } from '../../src/services/jarvisChat/runner';
import { createUiClients, type UiCommand } from '../../src/services/uiClients';
import { JARVIS_TOKEN_HEADER, JARVIS_TOOLS, type ChatEntry, type JarvisToolSpec } from '../../src/services/jarvisChat/types';
// @ts-expect-error plain ESM module without types
import { jarvisTools, toolsFor } from '../../hooks/mcp/jarvis.mjs';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let turns: Map<string, TurnRef>;
let sent: UiCommand[];
let ack: (cmd: UiCommand) => Record<string, unknown> | null;

const TOKEN = 'a'.repeat(64);
const WAKE = 'b'.repeat(64);
const FOCUS = 'f1';
const call = (tool: string, args: unknown, token = TOKEN) =>
  app.inject({ method: 'POST', url: `/api/jarvis-tools/${tool}`, headers: { [JARVIS_TOKEN_HEADER]: token }, payload: args as object });
const log = async () => (await (await app.deps.registry.get('default')).jarvis.page(FOCUS, { limit: 100 }));
const of = <T extends ChatEntry['type']>(entries: ChatEntry[], type: T) => entries.filter((e): e is Extract<ChatEntry, { type: T }> => e.type === type);

const shell = { mode: 'shell', command: null, prompt: null, split: null, anchor: null, worktree: 'api' };

function fakeRunner(): JarvisRunner {
  return {
    send: async () => { throw new Error('unused'); },
    approve: async () => undefined,
    wake: () => undefined,
    stop: async () => undefined,
    byToken: (t) => turns.get(t) ?? null,
  };
}

/** A window on the ui stream that acks every command with `ack(cmd)` (null = never). */
function openWindow(clientId: string) {
  app.deps.uiClients.connect({
    clientId, wsId: 'default', remote: false,
    send: (cmd) => {
      sent.push(cmd);
      const result = ack(cmd);
      if (result) queueMicrotask(() => app.deps.uiClients.ack('default', clientId, cmd.id, { applied: true, result }));
    },
  });
  app.deps.uiClients.report('default', clientId, { focused: true, worktreePath: null, visibleKeys: [], layout: null });
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-jarvis-tools-')));
  turns = new Map([
    [TOKEN, { ws: 'default', focusId: FOCUS, turnId: 't1', windowId: 'win1', wake: false }],
    [WAKE, { ws: 'default', focusId: FOCUS, turnId: 't2', windowId: '', wake: true }],
  ]);
  sent = [];
  ack = () => ({ ok: true, text: 'Opened shell-1 in api', card: { kind: 'shell', worktree: 'api', tab: 'shell-1' } });
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp({ ...deps, jarvis: fakeRunner() });
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('jarvis tool gateway', () => {
  it('unknown token 401, on the list and on a call', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/jarvis-tools', headers: { [JARVIS_TOKEN_HEADER]: 'c'.repeat(64) } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/jarvis-tools' })).statusCode).toBe(401);
    expect((await call('jarvis_open_tab', shell, 'c'.repeat(64))).statusCode).toBe(401);
  });

  it('lists exactly the jarvis tools, each with its action\'s schema; no nav, no settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jarvis-tools', headers: { [JARVIS_TOKEN_HEADER]: TOKEN } });
    const specs = res.json() as JarvisToolSpec[];
    expect(specs.map((s) => s.name).sort()).toEqual(Object.keys(JARVIS_TOOLS).sort());
    expect(specs.every((s) => s.name.startsWith('jarvis_') && (s.inputSchema as { type: string }).type === 'object')).toBe(true);
    expect(Object.values(JARVIS_TOOLS).some((a) => a.startsWith('nav.') || a.startsWith('settings.'))).toBe(false);
  });

  it('spawn runs in the turn\'s window and appends an action with its card', async () => {
    openWindow('win1');
    const res = await call('jarvis_open_tab', { mode: 'shell', worktree: 'api' });
    expect(res.json()).toEqual({ text: 'Opened shell-1 in api' });
    expect(sent).toEqual([expect.objectContaining({ op: 'jarvis.action', args: { action: 'tab.open', args: shell } })]);
    expect(of(await log(), 'action')).toEqual([expect.objectContaining({
      turnId: 't1', action: 'tab.open', summary: 'Open a shell in api', ok: true, card: { kind: 'shell', worktree: 'api', tab: 'shell-1' },
    })]);
  });

  it('shell run becomes a pending approval and nothing runs; the turn may not act again', async () => {
    openWindow('win1');
    const res = await call('jarvis_run_in_shell', { tab: 'shell-1', command: 'npm test' });
    const [approval] = of(await log(), 'approval');
    expect(approval).toMatchObject({ turnId: 't1', action: 'shell.run', args: { tab: 'shell-1', command: 'npm test' }, summary: 'Run `npm test` in shell-1', state: 'pending' });
    expect(approval!.danger).toBeUndefined();
    expect(res.json()).toEqual({ text: `Waiting for the person's approval (approval ${approval!.id}). End your turn now.` });
    const again = await call('jarvis_open_tab', { mode: 'shell', worktree: 'api' });
    expect(again.json().text).toMatch(/already waiting/);
    expect(sent).toEqual([]);
    expect(of(await log(), 'approval')).toHaveLength(1);
  });

  it('a destructive command\'s approval names the danger', async () => {
    await call('jarvis_run_in_shell', { tab: 'shell-1', command: 'cd x && rm -rf dist' });
    expect(of(await log(), 'approval')[0]).toMatchObject({ danger: 'recursive delete (rm -rf)' });
  });

  it('closing a tab, even one Jarvis opened, needs approval; so does a shell that runs a line', async () => {
    openWindow('win1');
    await call('jarvis_close_tab', { tab: 'shell-1' });
    turns.set('d'.repeat(64), { ...turns.get(TOKEN)!, turnId: 't3' });
    await call('jarvis_open_tab', { mode: 'shell', worktree: 'api', command: 'ls' }, 'd'.repeat(64));
    expect(of(await log(), 'approval').map((a) => a.action)).toEqual(['tab.close', 'tab.open']);
    expect(sent).toEqual([]);
  });

  it('a wake turn cannot start or ask agents directly; a plain shell is fine (in the focused window)', async () => {
    openWindow('win7');
    await call('jarvis_open_tab', { mode: 'claude', worktree: 'api', prompt: 'fix it' }, WAKE);
    expect(of(await log(), 'approval').map((a) => a.action)).toEqual(['tab.open']);
    turns.set('e'.repeat(64), { ...turns.get(WAKE)!, turnId: 't4' });
    const res = await call('jarvis_open_tab', { mode: 'shell', worktree: 'api' }, 'e'.repeat(64));
    expect(res.json().text).toBe('Opened shell-1 in api');
    expect(sent).toHaveLength(1);
  });

  it('an argument carrying a secret is refused: nothing runs, no card, Jarvis is told to leave it to the person', async () => {
    openWindow('win1');
    const res = await call('jarvis_run_in_shell', { tab: 'shell-1', command: 'export API_KEY=sk-live-123456 && npm run deploy' });
    expect(res.json().text).toMatch(/contains a secret/);
    const open = await call('jarvis_open_tab', { mode: 'claude', worktree: 'api', prompt: 'use password: hunter2' });
    expect(open.json().text).toMatch(/contains a secret/);
    expect(sent).toEqual([]);
    expect(await log()).toEqual([]);
  });

  it('two gated calls at once in one turn make one approval card', async () => {
    const [a, b] = await Promise.all([
      call('jarvis_run_in_shell', { tab: 'shell-1', command: 'ls' }),
      call('jarvis_close_tab', { tab: 'shell-1' }),
    ]);
    expect([a.json().text, b.json().text].filter((t: string) => t.startsWith('Waiting'))).toHaveLength(1);
    expect(of(await log(), 'approval')).toHaveLength(1);
  });

  it('what comes back to Jarvis is redacted (a recap can quote a key an agent printed)', async () => {
    openWindow('win1');
    ack = () => ({ ok: true, text: 'claude-1 printed ANTHROPIC_API_KEY=sk-ant-abcdef123456 earlier' });
    const res = await call('jarvis_recap', { agent: 'claude-1', focus: null });
    expect(res.json().text).not.toContain('sk-ant-abcdef123456');
    expect(res.json().text).toContain('[redacted]');
  });

  it('bad arguments are a 400 with a fixed message; an unknown tool is a 404', async () => {
    const bad = await call('jarvis_open_tab', { mode: 'shell', secret: 'token=abc123' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('abc123');
    expect((await call('jarvis_open_tab', { mode: 'vim' })).statusCode).toBe(400);
    expect((await call('nav_page', {})).statusCode).toBe(404);
    expect((await call('jarvis_nav_page', {})).statusCode).toBe(404);
  });

  it('no window: the action fails with fixed words, logged and told to Jarvis', async () => {
    const res = await call('jarvis_open_tab', { mode: 'shell', worktree: 'api' });
    expect(res.json()).toEqual({ text: 'Failed: The Strado window that sent this has closed' });
    expect(of(await log(), 'action')[0]).toMatchObject({ ok: false, error: 'The Strado window that sent this has closed' });
    const wake = await call('jarvis_open_tab', { mode: 'shell', worktree: 'api' }, WAKE);
    expect(wake.json()).toEqual({ text: 'Failed: No Strado window is open' });
  });

  it('the card keeps the exact worktree path the window gave (wakes match on it)', async () => {
    openWindow('win1');
    ack = () => ({ ok: true, text: 'Opened', card: { kind: 'claude', worktree: 'api', worktreePath: '/repos/api.worktrees/fix', tab: 'claude-1' } });
    await call('jarvis_open_tab', { mode: 'shell', worktree: 'api' });
    expect(of(await log(), 'action')[0]!.card).toEqual({ kind: 'claude', worktree: 'api', worktreePath: '/repos/api.worktrees/fix', tab: 'claude-1' });
  });

  it('a window answer outside the declared shape is not trusted', async () => {
    openWindow('win1');
    ack = () => ({ ok: true, text: 'Opened', card: { kind: 'evil', worktree: 'api', tab: 'x' } });
    await call('jarvis_open_tab', { mode: 'shell', worktree: 'api' });
    expect(of(await log(), 'action')[0]!.card).toBeUndefined();
  });
});

describe('createJarvisExecutor', () => {
  it('runs on the window it is told (Approve runs on the window that pressed it)', async () => {
    const ui = createUiClients();
    const got: string[] = [];
    for (const id of ['win1', 'win2']) {
      ui.connect({ clientId: id, wsId: 'w', remote: false, send: (cmd) => { got.push(id); queueMicrotask(() => ui.ack('w', id, cmd.id, { applied: true, result: { ok: true, text: 'ran' } })); } });
    }
    const execute = createJarvisExecutor({ uiClients: ui, createWorktree: async () => ({ ok: true, text: 'wt' }) });
    expect(await execute({ ws: 'w', focusId: 'f', turnId: 't', windowId: 'win2', wake: false, action: 'shell.run', args: {} })).toEqual({ ok: true, text: 'ran' });
    expect(got).toEqual(['win2']);
    expect(await execute({ ws: 'w', focusId: 'f', turnId: 't', windowId: 'win1', wake: false, action: 'worktree.create', args: {} })).toEqual({ ok: true, text: 'wt' });
    expect(got).toEqual(['win2']);
  });
});

describe('worktree.create (approved)', () => {
  it('creates the worktree from the repo\'s branch, trusts it in Claude Code, and adds it to the Focus', async () => {
    const repo = path.join(tmp, 'repo');
    await fs.mkdir(repo);
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'x@y.z'], ['config', 'user.name', 'x'], ['commit', '-q', '--allow-empty', '-m', 'i']]) await exec('git', a, { cwd: repo });
    const r = await app.inject({ method: 'POST', url: '/api/w/default/repos', payload: { id: 'web', name: 'Web', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 9100 } });
    expect(r.statusCode).toBeLessThan(300);
    const stores = (ws: string) => app.deps.registry.get(ws);
    const focus = await (await stores('default')).focuses.create({ name: 'Login' });
    const trusted: string[] = [];
    const run = createJarvisWorktree(app, stores, async (p) => { trusted.push(p); });
    const res = await run({ ws: 'default', focusId: focus.id, turnId: 't', windowId: 'w', wake: false, action: 'worktree.create', args: { repo: 'web', branch: 'fix-login' } });
    expect(res).toMatchObject({ ok: true });
    expect(trusted).toHaveLength(1);
    expect(path.basename(trusted[0]!)).toBe('fix_login');
    expect((await fs.stat(trusted[0]!)).isDirectory()).toBe(true);
    const after = (await (await stores('default')).focuses.list()).find((f) => f.id === focus.id)!;
    expect(after.members).toContain(`local:${trusted[0]}`);
    expect(await run({ ws: 'default', focusId: focus.id, turnId: 't', windowId: 'w', wake: false, action: 'worktree.create', args: { repo: 'nope', branch: 'x' } })).toEqual({ ok: false, text: 'No repo named nope' });
    expect(trusted).toHaveLength(1);
  });
});

describe('a Claude tab on the folder-trust question', () => {
  const SCREEN = 'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder';
  const tab = (over: Partial<AgentSummary> = {}): AgentSummary => ({
    agentId: 'claude-1@web', alias: 'claude-1', scopeId: 'default', mode: 'claude', worktreePath: '/w/fix', sessionId: '1',
    lifecycle: 'starting', executionId: 'e', live: true, ...over,
  });
  const fakeApp = (list: () => AgentSummary[], screen: () => string) =>
    ({ deps: { agents: { list: async () => list() }, terminal: { snapshot: () => screen() } } }) as unknown as FastifyInstance;
  const card = { kind: 'claude' as const, worktree: 'fix', worktreePath: '/w/fix', tab: 'claude-1' };

  it('trustWatcher: true once the question shows; false when the tab starts, or nothing shows in time', async () => {
    expect(await trustWatcher(fakeApp(() => [tab()], () => SCREEN), { pollMs: 5 })('default', card)).toBe(true);
    expect(await trustWatcher(fakeApp(() => [tab({ lifecycle: 'idle' })], () => SCREEN), { pollMs: 5 })('default', card)).toBe(false);
    expect(await trustWatcher(fakeApp(() => [tab()], () => '❯ '), { pollMs: 5, timeoutMs: 30 })('default', card)).toBe(false);
    expect(await trustWatcher(fakeApp(() => [tab({ worktreePath: '/w/other' })], () => SCREEN), { pollMs: 5, timeoutMs: 30 })('default', card)).toBe(false);
  });

  it('the hub\'s peers list carries attention: trust while the question is up (the card\'s "needs you")', async () => {
    let screen = SCREEN;
    const deps = await buildDeps({ configDir: path.join(tmp, 'config2'), homeStateDir: path.join(tmp, 'home2') });
    const a = await buildApp({
      ...deps, jarvis: fakeRunner(),
      agents: { ...deps.agents, list: async () => [tab(), tab({ agentId: 'shell-1@web', alias: null, mode: 'shell', sessionId: '1' })] },
      terminal: { ...deps.terminal, snapshot: () => screen },
    });
    const peers = async () => (await a.inject({ method: 'GET', url: '/api/w/default/intercom/peers' })).json().peers as AgentSummary[];
    expect((await peers()).map((p) => p.attention)).toEqual(['trust', undefined]);
    screen = '❯ ';
    expect((await peers()).map((p) => p.attention)).toEqual([undefined, undefined]);
    await a.close();
  });

  it('watchTrust: Jarvis hears it plainly; shells and other agents are not watched', async () => {
    const ref = { ws: 'default', focusId: 'f1', turnId: 't', windowId: 'w', wake: false };
    const opened = { ok: true, text: 'Opened claude-1 in fix', card };
    const seen: string[] = [];
    const run = watchTrust(async () => opened, async (_ws, c) => { seen.push(c.tab); return true; });
    expect(await run({ ...ref, action: 'tab.open', args: { mode: 'claude' } })).toEqual({ ...opened, text: 'claude-1 is waiting for you to trust the folder; open the tab to answer' });
    expect(await run({ ...ref, action: 'tab.open', args: { mode: 'codex' } })).toEqual(opened);
    expect(await run({ ...ref, action: 'tab.open', args: { mode: 'shell' } })).toEqual(opened);
    expect(seen).toEqual(['claude-1']);
  });
});

describe('shell output for Jarvis', () => {
  it('a shell line the window ran comes back with its output tail; the same line run elsewhere is never taken', async () => {
    const ui = createUiClients();
    let card: Record<string, unknown> | undefined;
    ui.connect({ clientId: 'win1', wsId: 'w', remote: false, send: (cmd) => {
      commandRuns.emit({ key: sessionKeyFor('shell', '/other/ws/repo', '1'), command: 'ls', result: { output: 'OTHER WORKSPACE', settled: true, durationMs: 1 } });
      commandRuns.emit({ key: sessionKeyFor('shell', '/w/api', '1'), command: 'ls', result: { output: '\x1b[1mREADME.md\x1b[0m\nsrc\n\n', settled: true, durationMs: 5 } });
      commandRuns.emit({ key: sessionKeyFor('shell', '/w/api', '2'), command: 'ls', result: { output: 'OTHER TAB', settled: true, durationMs: 1 } });
      queueMicrotask(() => ui.ack('w', 'win1', cmd.id, { applied: true, result: { ok: true, text: 'Ran ls in shell-1', ...(card ? { card } : {}) } }));
    } });
    const ref = { ws: 'w', focusId: 'f', turnId: 't', windowId: 'win1', wake: false };
    // The window named the tab: exactly that tab's run.
    card = { kind: 'shell', worktree: 'api', worktreePath: '/w/api', tab: 'shell-1' };
    const execute = createJarvisExecutor({ uiClients: ui, createWorktree: async () => ({ ok: true, text: '' }) });
    const r = await execute({ ...ref, action: 'shell.run', args: { tab: 'shell-1', command: 'ls' } });
    expect(r.text).toBe('Ran ls in shell-1\n\nOutput of `ls`:\nREADME.md\nsrc');
    // No card: only a run in one of this Focus's worktrees; none at all without that list.
    card = undefined;
    const scoped = createJarvisExecutor({ uiClients: ui, createWorktree: async () => ({ ok: true, text: '' }), focusPaths: async () => ['/w/web'] });
    expect((await scoped({ ...ref, action: 'shell.run', args: { tab: 'this', command: 'ls' } })).text).toBe('Ran ls in shell-1');
    expect((await execute({ ...ref, action: 'shell.run', args: { tab: 'this', command: 'ls' } })).text).toBe('Ran ls in shell-1');
  });

  it('the tail: last 40 lines, at most 4 KB, secrets redacted; still running and errors say so', () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const t = outputText('seq', { output: many, settled: true, durationMs: 1 });
    expect(t.split('\n')).toHaveLength(41);
    expect(t).toContain('line 99');
    expect(t).not.toContain('line 59\n');
    expect(Buffer.byteLength(outputText('big', { output: 'x'.repeat(10_000), settled: true, durationMs: 1 }))).toBeLessThan(4200);
    expect(outputText('env', { output: 'API_TOKEN=abcdef123456\nok', settled: true, durationMs: 1 })).not.toContain('abcdef123456');
    expect(outputText('npm run dev', { output: 'ready on :3000', settled: false, durationMs: 15000 })).toBe('Output of `npm run dev` so far (still running):\nready on :3000');
    expect(outputText('ls', { error: 'the shell is not running' })).toBe('`ls` did not run: the shell is not running.');
    expect(outputText('true', { output: '', settled: true, durationMs: 1 })).toBe('Output of `true`:\n(no output)');
  });
});

describe('trackAsks', () => {
  it('an asked question ties its answer to the turn\'s Focus; anything else does not', async () => {
    const asked: string[][] = [];
    const results: Record<string, { ok: boolean; text: string; askId?: string }> = {
      'agent.ask': { ok: true, text: 'Asked claude-1', askId: 'msg-42' },
      'agent.message': { ok: true, text: 'Sent', askId: 'msg-43' },
    };
    const run = trackAsks(async (c) => results[c.action] ?? { ok: false, text: 'no', askId: 'x' }, (ws, focusId, askId) => asked.push([ws, focusId, askId]));
    const ref = { ws: 'default', focusId: 'f1', turnId: 't', windowId: 'w', wake: false };
    expect(await run({ ...ref, action: 'agent.ask', args: {} })).toMatchObject({ text: 'Asked claude-1' });
    await run({ ...ref, action: 'agent.message', args: {} });
    await run({ ...ref, action: 'shell.run', args: {} });
    expect(asked).toEqual([['default', 'f1', 'msg-42']]);
  });
});

describe('jarvis.mjs', () => {
  type Req = { method: string; urlPath: string; headers?: Record<string, string>; body?: string };
  const env = { STRADO_JARVIS_TOKEN: TOKEN, STRADO_STATUS_PORT: '7777' };

  it('with a token, serves only the tools the server lists, never a tab\'s tools', async () => {
    const reqs: Req[] = [];
    const request = async (r: Req) => {
      reqs.push(r);
      return { status: 200, json: [{ name: 'jarvis_open_tab', description: 'Open', inputSchema: { type: 'object' } }, { name: 'agent_spawn', description: 'x', inputSchema: { type: 'object' } }] };
    };
    const tabTools = () => [{ name: 'intercom_send' }];
    const tools = await toolsFor(env, tabTools, request);
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['jarvis_open_tab']);
    expect(reqs[0]).toMatchObject({ method: 'GET', urlPath: '/api/jarvis-tools', headers: { [JARVIS_TOKEN_HEADER]: TOKEN } });
    expect(await toolsFor({ STRADO_STATUS_PORT: '7777' }, tabTools, request)).toEqual([{ name: 'intercom_send' }]);
  });

  it('a call posts the args with the token and returns the text; an error carries the server\'s message', async () => {
    const reqs: Req[] = [];
    let status = 200;
    const request = async (r: Req) => {
      reqs.push(r);
      if (r.method === 'GET') return { status: 200, json: [{ name: 'jarvis_run_in_shell', description: '', inputSchema: { type: 'object' } }] };
      return status === 200 ? { status, json: { text: 'Waiting for approval' } } : { status, json: { error: { message: 'bad argument: command' } } };
    };
    const [tool] = await jarvisTools(env, request);
    expect(await tool.run({ command: 'ls' })).toEqual({ content: [{ type: 'text', text: 'Waiting for approval' }] });
    expect(reqs[1]).toMatchObject({ method: 'POST', urlPath: '/api/jarvis-tools/jarvis_run_in_shell', headers: { [JARVIS_TOKEN_HEADER]: TOKEN }, body: '{"command":"ls"}' });
    status = 400;
    await expect(tool.run({})).rejects.toThrow('bad argument: command');
  });

  it('no server reachable or no token: no tools', async () => {
    expect(await jarvisTools(env, async () => { throw new Error('ECONNREFUSED'); })).toEqual([]);
    expect(await jarvisTools({ STRADO_STATUS_PORT: '7777' }, async () => ({ status: 200, json: [] }))).toEqual([]);
  });
});
