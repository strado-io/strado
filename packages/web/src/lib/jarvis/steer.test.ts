import { describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { describeRun, planFromModel } from './model';
import { interruptStep, messageStep, planKey, steerStep } from './parse';
import { runPlan, type JarvisPorts } from './execute';
import { createJarvisServerPort } from './serverPort';
import { ACTION_IDS, type ParseContext, type Plan } from './types';

const W = '/wt/app';
const ctx: ParseContext = {
  tabs: [
    { worktreePath: W, mode: 'claude', sessionId: '1', label: 'Claude 1', busy: true, agentId: 'claude-1@app', alias: 'reviewer' },
    { worktreePath: W, mode: 'codex', sessionId: '1', label: 'Codex 1', busy: false, agentId: 'codex-1@app' },
    { worktreePath: W, mode: 'shell', sessionId: '1', label: 'Shell 1', busy: false, agentId: 'shell-1@app' },
  ],
  focused: { worktreePath: W, mode: 'claude', sessionId: '1' }, lastActedOn: null, currentWorktree: W,
  worktrees: [{ path: W, name: 'app' }], focuses: [], packageScripts: {},
  peers: [
    { agentId: 'claude-1@app', alias: 'reviewer', mode: 'claude', worktreePath: W },
    { agentId: 'codex-1@app', alias: null, mode: 'codex', worktreePath: W },
    { agentId: 'shell-1@app', alias: null, mode: 'shell', worktreePath: W },
  ],
};
const m = (action: string, args: unknown) => planFromModel([{ action, args }], ctx);
const first = (p: Plan) => p.steps[0] as unknown as { action: string; args: Record<string, unknown>; needsConfirm: boolean; confirmReason?: string; risk: string; where: string; undoable: boolean } | undefined;
const ports = (over: Partial<JarvisPorts['server']> = {}): JarvisPorts => ({
  hub: null,
  nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() },
  server: {
    spawn: vi.fn(), run: vi.fn(), interrupt: vi.fn(), close: vi.fn(), message: vi.fn(), startServer: vi.fn(), stopServer: vi.fn(),
    answerCall: vi.fn(), dismissCall: vi.fn(), recap: vi.fn(), interruptAgent: vi.fn().mockResolvedValue({ ok: true }), ...over,
  } as JarvisPorts['server'],
});

describe('agent.interrupt / agent.steer: the plan', () => {
  it('come last in the registry, after tab.rename, in this order', () => {
    expect(ACTION_IDS.slice(-3)).toEqual(['tab.rename', 'agent.interrupt', 'agent.steer']);
  });
  it('agent.interrupt resolves the agent like agent.message; not undoable; confirms first', () => {
    const p = m('agent.interrupt', { agent: 'reviewer' });
    expect(first(p)).toMatchObject({ action: 'agent.interrupt', args: { agentId: 'claude-1@app' }, where: 'server', undoable: false, needsConfirm: true });
    expect(first(p)!.confirmReason).toBe('Stop claude-1? Its turn ends where it is');
    expect(p.summary).toBe('Stop reviewer');
    expect(first(m('agent.interrupt', { agent: 'this' }))!.args.agentId).toBe('claude-1@app');
    expect(first(m('agent.interrupt', { agent: 'codex' }))!.args.agentId).toBe('codex-1@app');
  });
  it('agent.steer carries the new instruction', () => {
    const p = m('agent.steer', { agent: 'codex-1', text: 'use the staging DB instead' });
    expect(first(p)).toMatchObject({ action: 'agent.steer', args: { agentId: 'codex-1@app', text: 'use the staging DB instead' }, where: 'server', undoable: false, needsConfirm: true });
    expect(p.summary).toBe('Stop codex-1 and tell it: use the staging DB instead');
  });
  it('planKey', () => {
    expect(planKey(m('agent.interrupt', { agent: 'reviewer' }))).toBe('agent.interrupt:claude-1@app');
    expect(planKey(m('agent.steer', { agent: 'reviewer', text: 'x' }))).toBe('agent.steer:claude-1@app');
  });
  it.each([
    ['interrupt with no agent', 'agent.interrupt', {}],
    ['interrupt an unknown agent', 'agent.interrupt', { agent: 'ghost' }],
    ['interrupt a shell', 'agent.interrupt', { agent: 'shell-1' }],
    ['steer with no text', 'agent.steer', { agent: 'reviewer' }],
    ['steer with blank text', 'agent.steer', { agent: 'reviewer', text: '   ' }],
    ['steer with ctrl-c', 'agent.steer', { agent: 'reviewer', text: 'hi\u0003' }],
    ['steer with a huge text', 'agent.steer', { agent: 'reviewer', text: 'x'.repeat(100_000) }],
    ['steer a shell', 'agent.steer', { agent: 'shell-1', text: 'x' }],
  ])('refuses %s', (_n, action, args) => {
    expect(m(action, args).steps).toHaveLength(0);
  });
  it('approvals are never model actions', () => {
    expect(ACTION_IDS.some((id) => /approv/.test(id))).toBe(false);
    for (const action of ['agent.approve', 'approval.answer', 'approval.allow']) expect(m(action, { id: 'a1', decision: 'allow' }).steps).toHaveLength(0);
  });
});

describe('step builders for the agent card', () => {
  it('interruptStep / steerStep / messageStep build the same steps the model does', () => {
    // The model's copy also carries fromModel and its confirm; the rest is the same step.
    const strip = (s: unknown) => { const { fromModel: _f, needsConfirm: _n, confirmReason: _r, ...rest } = s as Record<string, unknown>; return rest; };
    expect(strip(interruptStep(ctx, 'codex-1@app'))).toEqual(strip(m('agent.interrupt', { agent: 'codex-1' }).steps[0]));
    expect(strip(steerStep(ctx, 'codex-1@app', 'x'))).toEqual(strip(m('agent.steer', { agent: 'codex-1', text: 'x' }).steps[0]));
    expect(messageStep(ctx, 'codex-1@app', 'x')).toMatchObject({ action: 'agent.message', args: { agentId: 'codex-1@app', text: 'x' } });
  });
  it('a card click is the user\'s own: no model confirm', () => {
    expect(interruptStep(ctx, 'codex-1@app')).toMatchObject({ needsConfirm: false });
    expect(steerStep(ctx, 'codex-1@app', 'x')).toMatchObject({ needsConfirm: false });
  });
});

describe('agent.interrupt / agent.steer in runPlan', () => {
  it('interrupt calls the agent route', async () => {
    const p = ports();
    const r = await runPlan(m('agent.interrupt', { agent: 'codex' }), p);
    expect(r.ok).toBe(true);
    expect(p.server.interruptAgent).toHaveBeenCalledWith('codex-1@app');
    expect(p.server.message).not.toHaveBeenCalled();
    expect(describeRun(m('agent.interrupt', { agent: 'codex' }), r, ctx)).toBe('Ran: stopped codex-1');
  });
  it('steer interrupts first, then sends the text the way agent.message does', async () => {
    const order: string[] = [];
    const p = ports({
      interruptAgent: vi.fn(async () => { order.push('interrupt'); return { ok: true }; }),
      message: vi.fn(async () => { order.push('message'); return { delivered: 'sent', to: { agentId: 'claude-1@app', alias: 'reviewer' } }; }),
    });
    const plan = m('agent.steer', { agent: 'reviewer', text: 'stop refactoring, fix the login test' });
    const r = await runPlan(plan, p);
    expect(order).toEqual(['interrupt', 'message']);
    expect(p.server.message).toHaveBeenCalledWith('claude-1@app', 'stop refactoring, fix the login test');
    expect(r.messages).toEqual([{ delivered: 'sent', to: { agentId: 'claude-1@app', alias: 'reviewer' } }]);
    expect(describeRun(plan, r, ctx)).toBe('Ran: redirected reviewer');
  });
  it('a failed interrupt sends nothing', async () => {
    const p = ports({ interruptAgent: vi.fn().mockRejectedValue(new Error('agent is offline')) });
    const r = await runPlan(m('agent.steer', { agent: 'reviewer', text: 'x' }), p);
    expect(r).toMatchObject({ ok: false, failed: { index: 0, reason: 'agent is offline' } });
    expect(p.server.message).not.toHaveBeenCalled();
  });
  it('a port without interruptAgent fails in plain words', async () => {
    const p = ports();
    delete (p.server as { interruptAgent?: unknown }).interruptAgent;
    const r = await runPlan(m('agent.interrupt', { agent: 'reviewer' }), p);
    expect(r).toMatchObject({ ok: false, failed: { reason: 'Stopping agents is not available here' } });
  });
});

describe('server port: interruptAgent', () => {
  it('goes through api.intercom.interrupt for the workspace', async () => {
    const spy = vi.spyOn(api.intercom, 'interrupt').mockResolvedValue({ ok: true });
    await createJarvisServerPort('ws1').interruptAgent!('claude-1@app');
    expect(spy).toHaveBeenCalledWith('ws1', 'claude-1@app');
    spy.mockRestore();
  });
});
