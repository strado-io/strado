import { describe, expect, it, vi } from 'vitest';
import { buildModelContext, planFromModel } from './model';
import { runPlan, type JarvisPorts } from './execute';
import type { ParseContext, Plan } from './types';

const A = '/wt/app';
const FD = '/wt/FD-29';
const API = '/wt/api';
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [], focused: null, lastActedOn: null, currentWorktree: A,
  worktrees: [{ path: A, name: 'app' }, { path: FD, name: 'FD-29', ticketKey: 'FD-29' }, { path: API, name: 'api' }],
  focuses: [
    { id: 'f1', name: 'Release', worktreePaths: [A, FD] },
    { id: 'f2', name: 'Backend', worktreePaths: [API, '/wt/gone'] },
    { id: 'f3', name: 'Empty', worktreePaths: [] },
  ],
  currentFocus: { id: 'f1', name: 'Release' },
  packageScripts: {},
  peers: [
    { agentId: 'claude-1@app', alias: null, mode: 'claude', worktreePath: A },
    { agentId: 'claude-1@FD-29', alias: null, mode: 'claude', worktreePath: FD },
    { agentId: 'shell-1@FD-29', alias: null, mode: 'shell', worktreePath: FD },
    { agentId: 'codex-1@api', alias: null, mode: 'codex', worktreePath: API },
  ],
  ...over,
});
const recap = (args: Record<string, unknown>, c = ctx(), text?: string) => planFromModel([{ action: 'agent.recap', args: { agent: 'all', focus: null, ...args } }], c, { text });
const argsOf = (p: Plan) => (p.steps[0] as unknown as { args: Record<string, unknown> } | undefined)?.args;

describe('the model context carries the open Focus and each Focus\'s worktrees', () => {
  it('focus and focuses[].worktrees, by worktree context name', () => {
    const m = buildModelContext(ctx());
    expect(m.focus).toEqual({ name: 'Release' });
    expect(m.focuses).toEqual([
      { name: 'Release', worktrees: ['app', 'FD-29'] },
      { name: 'Backend', worktrees: ['api'] },
      { name: 'Empty', worktrees: [] },
    ]);
  });
  it('no open Focus → null; members capped at 30', () => {
    expect(buildModelContext(ctx({ currentFocus: null })).focus).toBeNull();
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `/wt/w${i}`, name: `w${i}` }));
    const m = buildModelContext(ctx({ worktrees: many, focuses: [{ id: 'x', name: 'Big', worktreePaths: many.map((w) => w.path) }] }));
    expect(m.focuses[0]!.worktrees).toHaveLength(30);
  });
});

describe('agent.recap scoped to a Focus', () => {
  it('"what are the agents in this focus doing": all + focus → that Focus\'s live agents, shells excluded', () => {
    const p = recap({ focus: 'Release' }, ctx(), 'what are the agents in this focus doing');
    expect(argsOf(p)).toEqual({ agentIds: ['claude-1@app', 'claude-1@FD-29'], question: 'what are the agents in this focus doing', focus: 'Release' });
    expect(p.summary).toBe('Recap the agents in Release');
  });
  it('"this focus" / "the focus" mean the open Focus', () => {
    expect(argsOf(recap({ focus: 'this focus' }))!.agentIds).toEqual(['claude-1@app', 'claude-1@FD-29']);
    expect(argsOf(recap({ focus: 'the focus' }))!.focus).toBe('Release');
  });
  it('another Focus by name, any case', () => {
    expect(argsOf(recap({ focus: 'backend' }))!.agentIds).toEqual(['codex-1@api']);
  });
  it('a Focus with no agents still plans; it answers without a server call', async () => {
    const p = recap({ focus: 'Empty' });
    expect(argsOf(p)).toMatchObject({ agentIds: [], focus: 'Empty' });
    const server = { recap: vi.fn() } as unknown as JarvisPorts['server'];
    const r = await runPlan(p, { hub: null, nav: {} as JarvisPorts['nav'], server });
    expect(r.ok).toBe(true);
    expect(r.recap).toBe('No agents are running in Empty.');
    expect(server.recap).not.toHaveBeenCalled();
  });
  it('caps at 20 agents', () => {
    const peers = Array.from({ length: 25 }, (_, i) => ({ agentId: `claude-${i}@app`, alias: null, mode: 'claude' as const, worktreePath: A }));
    expect(argsOf(recap({ focus: 'Release' }, ctx({ peers })))!.agentIds as string[]).toHaveLength(20);
  });
  it('a named agent ignores the focus scope', () => {
    expect(argsOf(recap({ agent: 'api/codex-1', focus: 'Release' }))).toMatchObject({ agentIds: ['codex-1@api'] });
  });
  it('refuses an unknown Focus, "this focus" with none open, and a non-text focus', () => {
    expect(recap({ focus: 'nope' }).steps).toHaveLength(0);
    expect(recap({ focus: 'this focus' }, ctx({ currentFocus: null })).steps).toHaveLength(0);
    expect(recap({ focus: 7 }).steps).toHaveLength(0);
  });
  it('runPlan sends the Focus\'s agents with the question', async () => {
    const server = { recap: vi.fn().mockResolvedValue({ text: 'both green' }) } as unknown as JarvisPorts['server'];
    const r = await runPlan(recap({ focus: 'Release' }, ctx(), 'did the tests pass?'), { hub: null, nav: {} as JarvisPorts['nav'], server });
    expect(server.recap).toHaveBeenCalledWith(['claude-1@app', 'claude-1@FD-29'], 'did the tests pass?');
    expect(r.recap).toBe('both green');
  });
});

describe('focus.edit takes "this focus"', () => {
  it('remove FD-29 from this focus', () => {
    const p = planFromModel([{ action: 'focus.edit', args: { op: 'remove', focus: 'this focus', name: null, worktrees: ['FD-29'] } }], ctx());
    expect(argsOf(p)).toEqual({ op: 'remove', focusId: 'f1', name: null, worktreePaths: [FD] });
  });
});

describe('fan-out over a Focus stays one step per worktree / agent', () => {
  it('open a shell in every worktree of this focus', () => {
    const p = planFromModel(['app', 'FD-29'].map((w) => ({ action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: 'tab', anchor: null, worktree: w } })), ctx());
    expect(p.executable).toBe(true);
    expect(p.steps.map((s) => (s.action === 'tab.open' ? s.args.worktreePath : null))).toEqual([A, FD]);
  });
  it('ask every claude in this focus', () => {
    const p = planFromModel([{ action: 'agent.ask', args: { to: 'claude-1', question: 'tests pass?' } }, { action: 'agent.ask', args: { to: 'FD-29/claude-1', question: 'tests pass?' } }], ctx());
    expect(p.steps.map((s) => (s.action === 'agent.ask' ? s.args.agentId : null))).toEqual(['claude-1@app', 'claude-1@FD-29']);
  });
});
