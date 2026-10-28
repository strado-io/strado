import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { cardOpen, createJarvisExecutor, createJarvisWorktree, focusScopeOf, grantAdds, outputText, outsideFocus, trackAsks, trustWatcher, watchTrust } from '../../src/routes/jarvisTools';
import { commandRuns } from '../../src/services/tabOps';
import { sessionKeyFor } from '../../src/services/terminalManager';
import type { FastifyInstance } from 'fastify';
import type { AgentSummary } from '../../src/services/agentRegistry';
import { exec } from '../../src/shell';
import { JARVIS_CHAT_SYSTEM } from '../../src/services/jarvisChat/prompt';
import { jarvisToolSpecs } from '../../src/services/jarvisChat/tools';
import type { JarvisRunner, TurnRef } from '../../src/services/jarvisChat/runner';
import type { ChatEntry } from '../../src/services/jarvisChat/types';
import { createUiClients, type UiCommand } from '../../src/services/uiClients';
import { JARVIS_TOKEN_HEADER, JARVIS_TOOLS, type ChatEntry, type JarvisContext, type JarvisToolSpec } from '../../src/services/jarvisChat/types';
// @ts-expect-error plain ESM module without types
import { jarvisTools, toolsFor } from '../../hooks/mcp/jarvis.mjs';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let turns: Map<string, TurnRef>;
let sent: UiCommand[];
let ack: (cmd: UiCommand) => Record<string, unknown> | null;

const TOKEN = 'a'.repeat(64);
const WAKE = 'b'.repeat(64);
let FOCUS = '';
let shown: JarvisContext | null;
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
    lastContext: () => shown,
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
  sent = [];
  shown = null;
  ack = () => ({ ok: true, text: 'Opened shell-1 in api', card: { kind: 'shell', worktree: 'api', tab: 'shell-1' } });
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp({ ...deps, jarvis: fakeRunner() });
  FOCUS = (await (await app.deps.registry.get('default')).focuses.create({ name: 'Login', members: ['local:/w/api'] })).id;
  // These tests are about approvals: Settings › Jarvis asks before acting is on (it's off by default).
  await app.inject({ method: 'PUT', url: '/api/profile', payload: { jarvisAsk: true } });
  turns = new Map([
    [TOKEN, { ws: 'default', focusId: FOCUS, turnId: 't1', windowId: 'win1', wake: false }],
    [WAKE, { ws: 'default', focusId: FOCUS, turnId: 't2', windowId: '', wake: true }],
  ]);
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
    expect(res.json()).toEqual({ text: 'Opened shell-1 in api (tab api/shell-1)' });
    expect(sent).toEqual([expect.objectContaining({ op: 'jarvis.action', args: { action: 'tab.open', args: shell, scope: ['/w/api'], focusId: FOCUS } })]);
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

  it('by default (asking off) steps just run — a shell line, closing a tab — but a destructive command and a wake\'s agent start still ask', async () => {
    await app.inject({ method: 'PUT', url: '/api/profile', payload: { jarvisAsk: false } });
    openWindow('win1');
    expect((await call('jarvis_run_in_shell', { tab: 'shell-1', command: 'npm test' })).json().text).not.toMatch(/approval/i);
    expect((await call('jarvis_close_tab', { tab: 'shell-1' })).json().text).not.toMatch(/approval/i);
    expect(of(await log(), 'approval')).toEqual([]);
    expect((await call('jarvis_run_in_shell', { tab: 'shell-1', command: 'rm -rf /' })).json().text).toMatch(/^Waiting for the person's approval/);
    expect((await call('jarvis_open_tab', { mode: 'claude', worktree: 'api' }, WAKE)).json().text).toMatch(/^Waiting for the person's approval/);
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
    expect(res.json().text).toBe('Opened shell-1 in api (tab api/shell-1)');
    expect(sent).toHaveLength(1);
  });

  it('a line with a secret-shaped arg still becomes an approval; the log keeps it redacted', async () => {
    openWindow('win1');
    const res = await call('jarvis_run_in_shell', { tab: 'shell-1', command: 'export API_KEY=sk-live-123456 && npm run deploy' });
    expect(res.json().text).toMatch(/^Waiting for the person's approval/);
    const [approval] = of(await log(), 'approval');
    expect(JSON.stringify(approval)).not.toContain('sk-live-123456');
    expect(sent).toEqual([]);
  });

  it('a worktree outside the Focus is refused before anything is sent or logged', async () => {
    openWindow('win1');
    const res = await call('jarvis_open_tab', { mode: 'shell', worktree: 'billing' });
    expect(res.json()).toEqual({ text: "That worktree isn't in this Focus." });
    const run = await call('jarvis_open_tab', { mode: 'shell', worktree: 'billing', command: 'ls' });
    expect(run.json()).toEqual({ text: "That worktree isn't in this Focus." });
    expect(sent).toEqual([]);
    expect(await log()).toEqual([]);
    // The name the window shows for a member counts too.
    shown = { focuses: [{ name: 'Login', worktrees: ['API (main)'] }] } as unknown as JarvisContext;
    expect((await call('jarvis_open_tab', { mode: 'shell', worktree: 'API (main)' })).json().text).toBe('Opened shell-1 in api (tab api/shell-1)');
  });

  it('focus.edit: only this Focus, except creating a new one', async () => {
    openWindow('win1');
    ack = () => ({ ok: true, text: 'Done' });
    const edit = (a: object) => call('jarvis_edit_focus', { op: 'add', focus: null, name: null, worktrees: null, ...a });
    expect((await edit({ op: 'rename', focus: 'Billing', name: 'x' })).json().text).toBe('Jarvis only edits this Focus (or creates a new one).');
    expect((await edit({ op: 'add', focus: null, worktrees: ['api'] })).json().text).toBe('Jarvis only edits this Focus (or creates a new one).');
    expect(sent).toEqual([]);
    expect((await edit({ op: 'rename', focus: 'Login', name: 'Login v2' })).json().text).toBe('Done');
    expect((await edit({ op: 'create', name: 'New' })).json().text).toBe('Done');
    expect(sent).toHaveLength(2);
  });

  it('focus.edit add widens the Focus, so it is an approval in every turn; nothing changes until then', async () => {
    openWindow('win1');
    const add = { op: 'add', focus: 'Login', name: null, worktrees: ['main'] };
    const res = await call('jarvis_edit_focus', add);
    expect(res.json().text).toMatch(/^Waiting for the person's approval/);
    expect(of(await log(), 'approval')).toEqual([expect.objectContaining({ action: 'focus.edit', summary: 'Add main to Login', state: 'pending' })]);
    expect(sent).toEqual([]);
    expect((await (await app.deps.registry.get('default')).focuses.list()).find((f) => f.id === FOCUS)!.members).toEqual(['local:/w/api']);
    expect((await call('jarvis_edit_focus', add, WAKE)).json().text).toMatch(/^Waiting for the person's approval/);
  });

  it('once an add is approved and ran, the resumed turn may open a tab in that worktree; a remove takes it back', async () => {
    const grants = new Map<string, Set<string>>();
    const stores = (ws: string) => app.deps.registry.get(ws);
    const scope = focusScopeOf(stores, () => null, grants);
    const ref = turns.get(TOKEN)!;
    const open = { mode: 'shell', worktree: 'main' };
    expect(outsideFocus('tab.open', open, await scope('default', FOCUS))).toBe("That worktree isn't in this Focus.");
    // The approved run: the window adds /repos/demo (shown as "main") to the Focus.
    const execute = grantAdds(async (c) => {
      if (c.args.op === 'add') await (await stores('default')).focuses.update(FOCUS, { addMembers: ['local:/repos/demo'] });
      return { ok: true, text: 'Done' };
    }, grants);
    await execute({ ...ref, action: 'focus.edit', args: { op: 'add', focus: 'Login', name: null, worktrees: ['main'] } });
    expect(outsideFocus('tab.open', open, await scope('default', FOCUS))).toBeNull();
    expect(outsideFocus('tab.open', open, await scope('default', 'other'))).toBe("That worktree isn't in this Focus.");
    await execute({ ...ref, action: 'focus.edit', args: { op: 'remove', focus: 'Login', name: null, worktrees: ['main'] } });
    expect(outsideFocus('tab.open', open, await scope('default', FOCUS))).toBe("That worktree isn't in this Focus.");
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

  it('a step shows as running when it starts, then becomes one line with its result (redacted)', async () => {
    openWindow('win1');
    const seen: ChatEntry[] = [];
    const off = (await app.deps.registry.get('default')).jarvis.onChange((_f, c) => { if (c.entry?.type === 'action') seen.push(c.entry); });
    ack = () => ({ ok: true, text: 'claude-1 fixed it; it printed ANTHROPIC_API_KEY=sk-ant-abcdef123456' });
    await call('jarvis_recap', { agent: 'claude-1', focus: null });
    off();
    expect(seen.map((e) => (e as { state?: string }).state ?? 'done')).toEqual(['running', 'done']);
    expect(seen[0]!.id).toBe(seen[1]!.id);
    const [step] = of(await log(), 'action');
    expect(of(await log(), 'action')).toHaveLength(1);
    expect(step).toMatchObject({ ok: true, summary: expect.stringMatching(/^Recap/) });
    expect(step).not.toHaveProperty('state');
    expect((step as { detail?: string }).detail).toContain('claude-1 fixed it');
    expect((step as { detail?: string }).detail).not.toContain('sk-ant-abcdef123456');
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

describe('"this" in the chat: the newest card', () => {
  const card = (kind: string, tab: string, extra: object = {}) => ({ kind, worktree: 'master', worktreePath: '/w/api', tab, ...extra });
  const acted = async (c: object) => (await app.deps.registry.get('default')).jarvis.append(FOCUS, { type: 'action', turnId: 't0', action: 'tab.open', summary: 'Opened', ok: true, card: c as never });

  it('"close this" right after a Browser tab: an approval naming that tab, which runs on exactly it', async () => {
    await acted(card('shell', 'shell-1'));
    await acted(card('browser', 'browser-1', { url: 'google.com' }));
    const res = await call('jarvis_close_tab', { tab: 'this' });
    expect(res.json().text).toMatch(/^Waiting for the person's approval/);
    const [approval] = of(await log(), 'approval');
    expect(approval).toMatchObject({ summary: 'Close the Browser tab google.com in master', args: { tab: 'browser-1', target: { kind: 'browser', tab: 'browser-1', worktreePath: '/w/api' } } });
  });

  it('no fitting card: refused before any approval', async () => {
    expect((await call('jarvis_close_tab', { tab: 'it' })).json()).toEqual({ text: 'Which tab? Name it, or open one first.' });
    await acted(card('shell', 'shell-1'));
    expect((await call('jarvis_message_agent', { to: 'this', text: 'hi' })).json()).toEqual({ text: 'Which tab? Name it, or open one first.' });
    expect(of(await log(), 'approval')).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('the kind must fit: a shell line skips a newer Browser card; the window gets the card as target, not in args', async () => {
    openWindow('win1');
    await acted(card('claude', 'claude-1'));
    await acted(card('shell', 'shell-2'));
    await acted(card('browser', 'browser-1'));
    await call('jarvis_run_in_shell', { tab: null, command: 'ls' });
    expect(of(await log(), 'approval')[0]).toMatchObject({ summary: 'Run `ls` in shell-2 in master', args: { tab: 'shell-2' } });
    turns.set('d'.repeat(64), { ...turns.get(TOKEN)!, turnId: 't9' });
    await call('jarvis_focus_tab', { tab: 'that' }, 'd'.repeat(64));
    expect(sent).toEqual([expect.objectContaining({ args: expect.objectContaining({
      action: 'tab.focus', args: { tab: 'browser-1' }, target: expect.objectContaining({ kind: 'browser', tab: 'browser-1', worktreePath: '/w/api' }),
    }) })]);
  });

  it('a named tab is passed as named; the model cannot send a target itself', async () => {
    openWindow('win1');
    await acted(card('shell', 'shell-1'));
    await call('jarvis_focus_tab', { tab: 'shell-9' });
    expect(sent[0]!.args).toMatchObject({ args: { tab: 'shell-9' } });
    expect((sent[0]!.args as { target?: unknown }).target).toBeUndefined();
    expect((await call('jarvis_focus_tab', { tab: 'this', target: card('shell', 'shell-1') })).statusCode).toBe(400);
  });

  it('the system prompt and the tab args say how to name a tab in the chat', () => {
    expect(JARVIS_CHAT_SYSTEM).toContain('Name a tab by its ref from context.tabsInThisChat');
    expect(JARVIS_CHAT_SYSTEM).toContain('"this", "it" and "that" mean the most recent tab you were talking about');
    const specs = jarvisToolSpecs();
    const prop = (tool: string, arg: string) => ((specs.find((t) => t.name === tool)!.inputSchema.properties as Record<string, { description: string }>)[arg]!.description);
    for (const [tool, arg] of [['jarvis_close_tab', 'tab'], ['jarvis_run_in_shell', 'tab'], ['jarvis_message_agent', 'to'], ['jarvis_interrupt_agent', 'agent']]) {
      expect(prop(tool!, arg!)).toContain('a ref from context.tabsInThisChat');
    }
    expect(prop('jarvis_open_tab', 'worktree')).not.toContain('tabsInThisChat');
  });

  it('a result that names a tab states its exact ref', async () => {
    openWindow('win1');
    ack = () => ({ ok: true, text: 'Opened google.com in master', card: card('browser', 'browser-2', { url: 'google.com' }) });
    expect((await call('jarvis_open_browser', { url: 'google.com', split: null, anchor: null, worktree: 'api' })).json().text).toBe('Opened google.com in master (tab master/browser-2)');
  });

  it('cardOpen: terminal tabs by live sessions, Browser tabs by the window\'s context, run tabs unknown', () => {
    const live = [{ path: '/w/api', mode: 'shell', id: '2' }];
    const open = cardOpen(() => live);
    const ctxWith = (tabs: { name: string; worktree: string }[]) => ({ tabs }) as unknown as JarvisContext;
    expect(open('w', card('shell', 'shell-2') as never, null)).toBe(true);
    expect(open('w', card('shell', 'shell-3') as never, null)).toBe(false);
    expect(open('w', card('claude', 'claude-2') as never, null)).toBe(false);
    expect(open('w', card('run', 'run-1') as never, null)).toBeNull();
    expect(open('w', card('browser', 'browser-2') as never, null)).toBeNull();
    expect(open('w', card('browser', 'browser-2') as never, ctxWith([{ name: 'master/browser-2', worktree: 'master' }]))).toBe(true);
    expect(open('w', card('browser', 'browser-2') as never, ctxWith([{ name: 'browser-2', worktree: 'master' }]))).toBe(true);
    expect(open('w', card('browser', 'browser-2') as never, ctxWith([{ name: 'browser-2', worktree: 'web' }]))).toBe(false);
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
    expect(r.text).toBe('Ran ls in shell-1 (tab api/shell-1)\n\nOutput of `ls`:\nREADME.md\nsrc');
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
