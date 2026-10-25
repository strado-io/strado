import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { createJarvisExecutor, trackAsks } from '../../src/routes/jarvisTools';
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
