import { describe, expect, it } from 'vitest';
import { buildModelContext, modelText, planFromModel } from './model';
import { withSafety } from './safety';
import { ACTION_IDS } from './types';
import type { ParseContext, Plan, TabInfo, TabRef } from './types';

const W = '/wt/app';
const API = '/wt/api';
const ref = (worktreePath: string, mode: TabRef['mode'], sessionId: string): TabRef => ({ worktreePath, mode, sessionId });
const C1 = ref(W, 'claude', '1');
const C2 = ref(W, 'claude', '2');
const O1 = ref(W, 'opencode', '1');
const S1 = ref(W, 'shell', '1');
const AC1 = ref(API, 'claude', '1');
const tab = (r: TabRef, extra: Partial<TabInfo> = {}): TabInfo => ({ ...r, label: `${r.mode} ${r.sessionId}`, busy: false, ...extra });

function ctx(over: Partial<ParseContext> = {}): ParseContext {
  return {
    tabs: [
      tab(C1, { agentId: 'claude-1@app', alias: 'reviewer' }),
      tab(C2, { agentId: 'claude-2@app' }),
      tab(O1, { agentId: 'opencode-1@app' }),
      tab(S1, { agentId: 'shell-1@app' }),
      tab(AC1, { agentId: 'claude-1@api' }),
    ],
    focused: S1,
    lastActedOn: null,
    currentWorktree: W,
    worktrees: [{ path: W, name: 'app', branch: 'main' }, { path: API, name: 'api', branch: 'fix' }],
    focuses: [],
    packageScripts: { test: 'vitest' },
    peers: [
      { agentId: 'claude-1@app', alias: 'reviewer', mode: 'claude', worktreePath: W },
      { agentId: 'claude-2@app', alias: null, mode: 'claude', worktreePath: W },
      { agentId: 'opencode-1@app', alias: null, mode: 'opencode', worktreePath: W },
      { agentId: 'shell-1@app', alias: null, mode: 'shell', worktreePath: W },
      { agentId: 'claude-1@api', alias: null, mode: 'claude', worktreePath: API },
    ],
    ...over,
  };
}
const msgs = (p: Plan) => p.steps.map((s) => (s.action === 'agent.message' ? [s.args.agentId, s.args.text] : [s.action]));
type Loose = { action: string; args: Record<string, unknown>; target: { ref?: TabRef }; needsConfirm: boolean; confirmReason?: string; undoable: boolean; where: string; risk: string };
const first = (p: Plan) => p.steps[0] as unknown as Loose | undefined;

describe('chips through the model', () => {
  it('modelText turns chips into the model-facing names, which planFromModel maps back', () => {
    const t = modelText('open a shell below and tell @{claude-1@app} to run the build; ping @{claude-1@api}', ctx());
    expect(t).toBe('open a shell below and tell @reviewer to run the build; ping @api/claude-1');
    const p = planFromModel([
      { action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: 'down', anchor: null, worktree: null } },
      { action: 'agent.message', args: { to: 'reviewer', text: 'run the build' } },
      { action: 'agent.message', args: { to: 'api/claude-1', text: 'ping' } },
    ], ctx(), { text: t });
    expect(p.steps.map((s) => s.action)).toEqual(['tab.open', 'agent.message', 'agent.message']);
    expect(msgs(p).slice(1)).toEqual([['claude-1@app', 'run the build'], ['claude-1@api', 'ping']]);
  });
  it('an unknown chip stays as typed', () => {
    expect(modelText('hi @{ghost@x}', ctx())).toBe('hi @ghost');
  });
  it('the live case: "move @{shell-1@app} to right of @{claude-1@app}" → names the model echoes → that exact move', () => {
    expect(modelText('can you move @{shell-1@app} to right of @{claude-1@app}', ctx())).toBe('can you move @shell-1 to right of @reviewer');
    const p = planFromModel([{ action: 'tab.place', args: { tab: '@shell-1', split: 'right', anchor: '@reviewer' } }], ctx());
    expect(first(p)).toMatchObject({ action: 'tab.place', target: { ref: S1 }, args: { place: { split: 'right', anchor: { ref: C1 } } } });
  });
  it('multi-target talk: one message step per agent', () => {
    const p = planFromModel([{ action: 'agent.message', args: { to: 'claude-1', text: 'run the tests' } }, { action: 'agent.message', args: { to: 'opencode-1', text: 'run the tests' } }], ctx());
    expect(msgs(p)).toEqual([['claude-1@app', 'run the tests'], ['opencode-1@app', 'run the tests']]);
  });
});

describe('calls through the model: always a confirm', () => {
  const calls = [{ id: 'e1', agentId: 'claude-2@app', title: 'Which DB?' }];
  const two = [...calls, { id: 'e2', agentId: 'claude-1@api', title: 'Deploy?' }];

  it('the context lists open calls by the caller\'s model-facing name', () => {
    expect(buildModelContext(ctx({ calls: two })).calls).toEqual([{ from: 'claude-2', title: 'Which DB?' }, { from: 'api/claude-1', title: 'Deploy?' }]);
    expect(buildModelContext(ctx()).calls).toBeUndefined();
  });
  it('call.answer resolves that call and always needs a confirm', () => {
    const p = planFromModel([{ action: 'call.answer', args: { caller: 'claude-2', text: 'use postgres' } }], ctx({ calls }));
    expect(p.executable).toBe(true);
    expect(first(p)).toMatchObject({ action: 'call.answer', args: { callId: 'e1', agentId: 'claude-2@app', text: 'use postgres' }, where: 'server', undoable: false,
      needsConfirm: true, confirmReason: `Answer claude-2's call: "use postgres"` });
    expect(p.summary).toBe('Answer claude-2: use postgres');
  });
  it('call.dismiss always confirms too, and the confirm survives a re-check', () => {
    const c = ctx({ calls });
    const p = planFromModel([{ action: 'call.dismiss', args: { caller: 'claude-2' } }], c);
    expect(first(p)).toMatchObject({ action: 'call.dismiss', args: { callId: 'e1' }, needsConfirm: true, confirmReason: "Dismiss claude-2's call" });
    expect(withSafety(p.steps[0]!, c).needsConfirm).toBe(true);
  });
  it('a caller in another worktree: by its model name, or by plain name', () => {
    expect(first(planFromModel([{ action: 'call.answer', args: { caller: 'api/claude-1', text: 'yes' } }], ctx({ calls: two })))).toMatchObject({ args: { callId: 'e2' } });
    expect(first(planFromModel([{ action: 'call.answer', args: { caller: 'claude-1', text: 'yes' } }], ctx({ calls: [two[1]!] })))).toMatchObject({ args: { callId: 'e2' } });
  });
  it('several calls from one caller → a pick list; nobody calling → refused', () => {
    const p = planFromModel([{ action: 'call.answer', args: { caller: 'claude-2', text: 'ok' } }], ctx({ calls: [...calls, { id: 'e3', agentId: 'claude-2@app', title: 'And?' }] }));
    expect(p.steps).toHaveLength(0);
    expect(p.alternatives!.map((a) => first(a)!.args.callId)).toEqual(['e1', 'e3']);
    const none = planFromModel([{ action: 'call.answer', args: { caller: 'claude-2', text: 'x' } }], ctx());
    expect(none.steps).toHaveLength(0);
    expect(none.summary).toMatch(/not calling/);
  });
});

describe('home and the Line through the model', () => {
  const repos = [{ path: '/code/strado', name: 'strado' }, { path: '/code/fleet-app', name: 'fleet-app' }];
  it('nav.addRepo, with or without a path', () => {
    expect(first(planFromModel([{ action: 'nav.addRepo', args: { path: null } }], ctx()))).toMatchObject({ action: 'nav.addRepo', args: { path: null }, where: 'hub', undoable: false });
    const p = planFromModel([{ action: 'nav.addRepo', args: { path: '~/code/my app' } }], ctx());
    expect(first(p)).toMatchObject({ args: { path: '~/code/my app' } });
    expect(p.summary).toBe('Add repo ~/code/my app');
  });
  it('nav.newWorktree, in a named repo; an unknown repo is refused', () => {
    const p = planFromModel([{ action: 'nav.newWorktree', args: { repo: 'fleet-app' } }], ctx({ repos }));
    expect(first(p)).toMatchObject({ action: 'nav.newWorktree', args: { repoPath: '/code/fleet-app' } });
    expect(p.summary).toBe('New worktree in fleet-app');
    expect(first(planFromModel([{ action: 'nav.newWorktree', args: { repo: null } }], ctx({ repos })))).toMatchObject({ args: { repoPath: null } });
    expect(planFromModel([{ action: 'nav.newWorktree', args: { repo: 'nope' } }], ctx({ repos })).steps).toHaveLength(0);
  });
  it('nav.line', () => {
    expect(first(planFromModel([{ action: 'nav.line', args: {} }], ctx()))).toMatchObject({ action: 'nav.line' });
  });
  it('the registry has them', () => {
    expect(ACTION_IDS).toEqual(expect.arrayContaining(['call.answer', 'call.dismiss', 'nav.line', 'nav.addRepo', 'nav.newWorktree']));
  });
});

describe('repos in the model context', () => {
  it('lists repo names (scrubbed, ≤ 50), so "new worktree in strado" can name a real one', () => {
    const repos = [{ path: '/code/strado', name: 'strado' }, { path: '/code/fleet-app', name: 'fleet-app' }];
    expect(buildModelContext(ctx({ repos })).repos).toEqual([{ name: 'strado' }, { name: 'fleet-app' }]);
    expect(buildModelContext(ctx({ repos: Array.from({ length: 60 }, (_, i) => ({ path: `/r/${i}`, name: `r${i}` })) })).repos).toHaveLength(50);
    expect(buildModelContext(ctx()).repos).toEqual([]);
  });
});

describe('home: no worktree open', () => {
  const home = (over: Partial<ParseContext> = {}) => ctx({ tabs: [], focused: null, lastActedOn: null, currentWorktree: null, ...over });
  const open = (args: Record<string, unknown>) => ({ action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: null, anchor: null, worktree: null, ...args } });

  it('context.worktrees lists the most recently used first', () => {
    const c = home({ worktrees: [{ path: W, name: 'app', lastUsedAt: 10 }, { path: API, name: 'api', lastUsedAt: 50 }, { path: '/wt/old', name: 'old' }] });
    expect(buildModelContext(c).worktrees.map((w) => w.name)).toEqual(['api', 'app', 'old']);
  });
  it('the live case: open claude in a named worktree, then a shell next to it running git status', () => {
    const p = planFromModel([
      open({ mode: 'claude', prompt: 'how are you', worktree: 'api' }),
      open({ split: 'right', anchor: '#1', command: 'git status' }),
    ], home(), { text: 'open claude and ask how are you and next to that open shell and run git status' });
    expect(p.executable).toBe(true);
    expect(p.steps.map((s) => (s.action === 'tab.open' ? [s.args.mode, s.args.worktreePath] : []))).toEqual([['claude', API], ['shell', API]]);
    expect(p.steps[1]!.action === 'tab.open' && p.steps[1]!.args.place).toMatchObject({ split: 'right', anchor: { kind: 'step', index: 0 } });
  });
  it('a later step without a worktree inherits the previous one, even when a worktree is shown', () => {
    const p = planFromModel([open({ worktree: 'api' }), { action: 'browser.open', args: { url: 'localhost:3000', split: 'down', anchor: '#1', worktree: null } }], ctx());
    expect(p.steps.map((s) => (s.action === 'tab.open' || s.action === 'browser.open' ? s.args.worktreePath : null))).toEqual([API, API]);
  });
  it('browser.open takes a worktree', () => {
    const p = planFromModel([{ action: 'browser.open', args: { url: 'localhost:3000', split: null, anchor: null, worktree: 'FLT-123' } }], home({ worktrees: [{ path: API, name: 'api', ticketKey: 'FLT-123' }] }));
    expect(p.steps[0]!.action === 'browser.open' && p.steps[0]!.args.worktreePath).toBe(API);
  });
  it('shell.run with no tab, after a named worktree, opens a shell there', () => {
    const p = planFromModel([{ action: 'nav.worktree', args: { name: 'api' } }, { action: 'shell.run', args: { tab: null, command: 'git status' } }], home());
    expect(p.steps[1]).toMatchObject({ action: 'tab.open', args: { mode: 'shell', worktreePath: API, command: 'git status' } });
  });
  it('on home with no worktree named anywhere, a tab step is refused', () => {
    const p = planFromModel([open({})], home());
    expect(p.steps).toHaveLength(0);
    expect(p.summary).toMatch(/worktree/);
  });
});

describe('#-chips for worktrees: #{encodeURIComponent(path)}', () => {
  const SP = '/wt/my app';
  const wts = { worktrees: [{ path: W, name: 'app', branch: 'main' }, { path: API, name: 'api', branch: 'fix' }, { path: SP, name: 'my app' }] };
  const chip = (p: string) => `#{${encodeURIComponent(p)}}`;
  const open = (args: Record<string, unknown> = {}) => ({ action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: null, anchor: null, worktree: null, ...args } });
  const wtOf = (p: Plan) => p.steps.map((s) => (s.action === 'tab.open' || s.action === 'browser.open' ? s.args.worktreePath : null));

  it('modelText maps a worktree chip to its name, spaces and all', () => {
    expect(modelText(`open a shell in ${chip(API)} and in ${chip(SP)}`, ctx(wts))).toBe('open a shell in #api and in #my app');
  });
  it('a chip sets the plan\'s worktree, so the model need not repeat it', () => {
    const p = planFromModel([open(), open({ split: 'right', anchor: '#1' })], ctx({ ...wts, tabs: [], focused: null, currentWorktree: null }), { text: `two shells in ${chip(SP)}` });
    expect(p.executable).toBe(true);
    expect(wtOf(p)).toEqual([SP, SP]);
  });
  it('over the shown worktree too', () => {
    expect(wtOf(planFromModel([open()], ctx(wts), { text: `a shell in ${chip(API)}` }))).toEqual([API]);
  });
  it('a step naming another worktree still wins', () => {
    expect(wtOf(planFromModel([open({ worktree: 'app' })], ctx(wts), { text: `a shell in ${chip(API)}` }))).toEqual([W]);
  });
  it('the model may echo the name with its #', () => {
    expect(wtOf(planFromModel([open({ worktree: '#api' })], ctx(wts)))).toEqual([API]);
  });
  it('a chip for a worktree that is gone refuses the plan', () => {
    const p = planFromModel([open()], ctx(wts), { text: `a shell in ${chip('/wt/deleted')}` });
    expect(p.steps).toHaveLength(0);
    expect(p.summary).toMatch(/that worktree is gone/i);
  });
});
