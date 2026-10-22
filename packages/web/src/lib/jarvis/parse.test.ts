import { describe, expect, it } from 'vitest';
import { parse, planKey, resolveAgent, resolveTarget } from './parse';
import { planFromModel } from './model';
import { ACTION_IDS } from './types';
import type { ParseContext, Plan, TabInfo, TabRef } from './types';

const W = '/wt/app';
const API = '/wt/api';
const ref = (worktreePath: string, mode: TabRef['mode'], sessionId: string): TabRef => ({ worktreePath, mode, sessionId });
const C1 = ref(W, 'claude', '1');
const C2 = ref(W, 'claude', '2');
const S1 = ref(W, 'shell', '1');
const S2 = ref(W, 'shell', '2');
const B1 = ref(W, 'browser', '1');
const AS1 = ref(API, 'shell', '1');
const AC1 = ref(API, 'claude', '1');
const tab = (r: TabRef, extra: Partial<TabInfo> = {}): TabInfo => ({ ...r, label: `${r.mode} ${r.sessionId}`, busy: false, ...extra });
const T = { kind: 'tab' as const };

function ctx(over: Partial<ParseContext> = {}): ParseContext {
  return {
    tabs: [
      tab(C1, { agentId: 'claude-1@app', alias: 'reviewer' }),
      tab(C2, { agentId: 'claude-2@app', busy: true }),
      tab(S1, { agentId: 'shell-1@app' }),
      tab(S2, { agentId: 'shell-2@app', busy: true }),
      tab(B1),
      tab(AS1, { agentId: 'shell-1@api' }),
      tab(AC1, { agentId: 'claude-1@api', alias: 'backend' }),
    ],
    focused: C1,
    lastActedOn: S2,
    currentWorktree: W,
    worktrees: [
      { path: W, name: 'app', branch: 'main' },
      { path: API, name: 'api', branch: 'FLT-123-fix-login', ticketKey: 'FLT-123' },
    ],
    focuses: [{ id: 'f1', name: 'Release' }],
    packageScripts: { dev: 'vite', test: 'vitest', build: 'tsc && vite build' },
    peers: [
      { agentId: 'claude-1@app', alias: 'reviewer', mode: 'claude', worktreePath: W },
      { agentId: 'claude-2@app', alias: null, mode: 'claude', worktreePath: W },
      { agentId: 'shell-1@app', alias: null, mode: 'shell', worktreePath: W },
      { agentId: 'shell-2@app', alias: null, mode: 'shell', worktreePath: W },
      { agentId: 'claude-1@api', alias: 'backend', mode: 'claude', worktreePath: API },
    ],
    ...over,
  };
}

const right = (anchor: TabRef) => ({ split: 'right', anchor: { kind: 'tab', ref: anchor }, focus: false });

type Case = {
  name: string;
  text: string;
  pasted?: boolean;
  ctx?: Partial<ParseContext>;
  expect: Partial<Omit<Plan, 'steps' | 'alternatives' | 'summary'>> & { steps?: unknown[]; alternatives?: number; summary?: RegExp | string };
};

// The box reads only `$ command` itself; everything else is the model's.
const cases: Case[] = [
  { name: '$ in a non-shell focus opens a shell right of it with the command', text: '$ npm test',
    expect: { source: 'prefix', executable: true, steps: [{ action: 'tab.open', args: { mode: 'shell', worktreePath: W, command: 'npm test', place: right(C1) }, risk: 'exec', where: 'server', undoable: false }] } },
  { name: '$ in a focused shell runs there', text: '$ npm test', ctx: { focused: S1 },
    expect: { steps: [{ action: 'shell.run', args: { command: 'npm test' }, target: { ...T, ref: S1 }, risk: 'exec', undoable: false, needsConfirm: false }] } },
  { name: '$ with a destructive command needs a second confirm', text: '$ git push --force origin main', ctx: { focused: S1 },
    expect: { steps: [{ action: 'shell.run', needsConfirm: true, confirmReason: expect.stringMatching(/force/) }] } },
  { name: '$ is literal: no step splitting, no script resolution', text: '$ dev; rm x and then y', ctx: { focused: S1 },
    expect: { steps: [{ action: 'shell.run', args: { command: 'dev; rm x and then y' } }] } },
  { name: 'a lone $ has nothing to run', text: '$', expect: { steps: [], executable: false } },
  { name: 'a pasted $ line is the shell reading, but never runs on the first ⏎', text: '$ rm -rf /', pasted: true, ctx: { focused: S1 },
    expect: { source: 'prefix', executable: false, steps: [{ action: 'shell.run', args: { command: 'rm -rf /' } }] } },
  { name: 'multi-line text is never a command line', text: '$ ls\nrm -rf /', ctx: { focused: S1 }, expect: { steps: [], executable: false, source: 'fallback' } },
  // What rules used to read is now the model's: an empty plan the box sends on.
  ...['close shell-2', 'move shell-2 right of claude-1', '@claude hi', 'answer claude-2: yes', 'intercom', 'add repo', 'run dev', 'fix the failing test', '> api']
    .map((text): Case => ({ name: `"${text}" goes to the model`, text, expect: { steps: [], executable: false, source: 'fallback', summary: '' } })),
];

describe('parse', () => {
  for (const c of cases) {
    it(c.name, () => {
      const plan = parse({ text: c.text, pasted: c.pasted }, ctx(c.ctx));
      const { steps, alternatives, summary, ...rest } = c.expect;
      expect(plan).toMatchObject(rest);
      if (steps) {
        expect(plan.steps).toHaveLength(steps.length);
        steps.forEach((s, i) => expect(plan.steps[i]).toMatchObject(s as object));
      }
      if (alternatives !== undefined) expect(plan.alternatives ?? []).toHaveLength(alternatives);
      if (summary !== undefined) typeof summary === 'string' ? expect(plan.summary).toBe(summary) : expect(plan.summary).toMatch(summary);
    });
  }

  it('empty input is an empty, non-executable plan', () => {
    expect(parse({ text: '   ' }, ctx())).toMatchObject({ steps: [], executable: false });
  });

  it('the $ prefix pins the focused shell\'s execution', () => {
    const c = ctx();
    c.tabs = c.tabs.map((t) => (t.mode === 'shell' && t.sessionId === '1' && t.worktreePath === W ? { ...t, executionId: 'ex-s1' } : t));
    expect(parse({ text: '$ ls' }, { ...c, focused: S1 }).steps[0]!.target).toEqual({ kind: 'tab', ref: { ...S1, executionId: 'ex-s1' } });
  });
});

describe('planKey', () => {
  const m = (steps: { action: string; args: unknown }[]) => planFromModel(steps, ctx());
  it('is the same for the same interpretation', () => {
    expect(planKey(m([{ action: 'tab.close', args: { tab: 'shell-2' } }]))).toBe(planKey(m([{ action: 'tab.close', args: { tab: 'shell-2' } }])));
  });
  it('differs when a significant arg differs, and covers every step', () => {
    expect(planKey(m([{ action: 'tab.close', args: { tab: 'shell-1' } }, { action: 'tab.focus', args: { tab: 'claude-2' } }]))).toBe('tab.close:shell:1|tab.focus:claude:2');
    expect(planKey(m([{ action: 'browser.open', args: { url: 'google.com', split: null, anchor: null } }]))).toBe('browser.open:https://google.com/');
    expect(planKey(m([{ action: 'tab.place', args: { tab: 'shell-2', split: 'right', anchor: 'reviewer' } }]))).toBe('tab.place:shell:2:right');
  });
  it('an empty plan has an empty key', () => {
    expect(planKey(parse({ text: 'close shell' }, ctx()))).toBe('');
  });
});

describe('ACTION_IDS', () => {
  it('matches the server registry', () => {
    expect(ACTION_IDS).toEqual(['nav.worktree', 'nav.focus', 'nav.workspace', 'nav.repo', 'tab.open', 'tab.place', 'tab.focus', 'tab.close',
      'tab.interrupt', 'shell.run', 'browser.open', 'agent.message', 'agent.wait', 'ui.state', 'server.start', 'server.stop',
      'call.answer', 'call.dismiss', 'nav.addRepo', 'nav.newWorktree', 'nav.page', 'settings.open', 'settings.set', 'focus.edit', 'ui.sidebar', 'agent.ask', 'agent.recap', 'tab.rename',
      'agent.interrupt', 'agent.steer']);
  });
});

// Name resolution is what the model's tab and agent names go through.
describe('resolveTarget / resolveAgent: a bare kind means the focused one, never another worktree', () => {
  const C3 = ref(W, 'claude', '3');
  const tgt = (r: ReturnType<typeof resolveTarget>) => (r.kind === 'ok' && r.target.kind === 'tab' ? r.target.ref : undefined);
  const agent = (r: ReturnType<typeof resolveAgent>) => (r.kind === 'ok' ? r.agentId : r.kind);

  it('"claude" / "the agent" → the focused agent', () => {
    expect(agent(resolveAgent('claude', ctx()))).toBe('claude-1@app');
    expect(agent(resolveAgent('the agent', ctx()))).toBe('claude-1@app');
    const tabs = [...ctx().tabs, tab(C3, { agentId: 'claude-3@app' })];
    expect(tgt(resolveTarget('claude', ctx({ tabs }), null))).toMatchObject(C1);
  });
  it('focused elsewhere: the last acted on, else a pick list of this worktree only', () => {
    expect(agent(resolveAgent('claude', ctx({ focused: S1, lastActedOn: C2 })))).toBe('claude-2@app');
    const r = resolveAgent('claude', ctx({ focused: S1, lastActedOn: S2 }));
    expect(r.kind === 'ambiguous' && r.agentIds).toEqual(['claude-1@app', 'claude-2@app']);
    expect(resolveTarget('shell', ctx({ lastActedOn: null }), null).kind).toBe('ambiguous');
  });
  it('a kind only in another worktree is not found; "wt/name" reaches it', () => {
    const only = ctx({ tabs: ctx().tabs.filter((t) => t.mode !== 'claude' || t.worktreePath === API), peers: ctx().peers.filter((p) => p.mode !== 'claude' || p.worktreePath === API), focused: S1 });
    expect(resolveAgent('claude', only).kind).toBe('none');
    expect(agent(resolveAgent('api/claude', only))).toBe('claude-1@api');
    expect(tgt(resolveTarget('api/claude-1', ctx(), null))).toMatchObject(AC1);
  });
  it('"claude-1" means this worktree\'s; an alias wins wherever it is', () => {
    expect(agent(resolveAgent('claude-1', ctx()))).toBe('claude-1@app');
    expect(tgt(resolveTarget('claude-1', ctx({ focused: S1 }), null))).toMatchObject(C1);
    expect(agent(resolveAgent('backend', ctx()))).toBe('claude-1@api');
  });
  it('a chip is exact: its tab, or refused', () => {
    expect(tgt(resolveTarget('@{shell-1@api}', ctx(), null))).toMatchObject(AS1);
    expect(resolveTarget('@{claude-9@app}', ctx(), null).kind).toBe('none');
    expect(agent(resolveAgent('@{claude-1@api}', ctx()))).toBe('claude-1@api');
    expect(resolveAgent('@{claude-9@app}', ctx())).toMatchObject({ kind: 'none', message: expect.stringMatching(/offline/) });
  });
});
