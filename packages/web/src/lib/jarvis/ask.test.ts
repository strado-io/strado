import { beforeEach, describe, expect, it, vi } from 'vitest';

const jf = vi.hoisted(() => vi.fn());
vi.mock('./hubToken', () => ({ jarvisFetch: jf }));

import { planFromModel } from './model';
import { planKey } from './parse';
import { runPlan, type JarvisPorts } from './execute';
import { createJarvisServerPort } from './serverPort';
import { ACTION_IDS, type ParseContext, type Plan } from './types';

const W = '/wt/app';
const ctx: ParseContext = {
  tabs: [
    { worktreePath: W, mode: 'claude', sessionId: '1', label: 'Claude 1', busy: false, agentId: 'claude-1@app', alias: 'reviewer' },
    { worktreePath: W, mode: 'codex', sessionId: '1', label: 'Codex 1', busy: true, agentId: 'codex-1@app' },
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
const first = (p: Plan) => p.steps[0] as unknown as { action: string; args: Record<string, unknown>; needsConfirm: boolean; risk: string; where: string; undoable: boolean } | undefined;

describe('agent.ask / agent.recap from the model', () => {
  it('are in the registry, at the end', () => {
    expect(ACTION_IDS.slice(-2)).toEqual(['agent.ask', 'agent.recap']);
  });
  it('agent.ask resolves the agent like agent.message', () => {
    const p = m('agent.ask', { to: 'reviewer', question: 'do the tests pass?' });
    expect(p.executable).toBe(true);
    expect(first(p)).toMatchObject({ action: 'agent.ask', args: { agentId: 'claude-1@app', question: 'do the tests pass?' }, risk: 'exec', where: 'server', undoable: false, needsConfirm: false });
    expect(p.summary).toBe('Ask reviewer: do the tests pass?');
    expect(first(m('agent.ask', { to: 'this', question: 'why?' }))!.args.agentId).toBe('claude-1@app');
    expect(first(m('agent.ask', { to: 'codex', question: 'why?' }))!.args.agentId).toBe('codex-1@app');
  });
  it('agent.recap: one agent, or all', () => {
    const one = m('agent.recap', { agent: 'codex-1' });
    expect(first(one)).toMatchObject({ action: 'agent.recap', args: { agentIds: ['codex-1@app'] }, risk: 'read', where: 'server', undoable: false, needsConfirm: false });
    expect(one.summary).toBe('Recap codex-1');
    const all = m('agent.recap', { agent: 'all' });
    expect(first(all)!.args.agentIds).toBe('all');
    expect(all.summary).toBe('Recap all agents');
  });
  it('planKey', () => {
    expect(planKey(m('agent.ask', { to: 'reviewer', question: 'x' }))).toBe('agent.ask:claude-1@app');
    expect(planKey(m('agent.recap', { agent: 'all' }))).toBe('agent.recap:all');
    expect(planKey(m('agent.recap', { agent: 'reviewer' }))).toBe('agent.recap:claude-1@app');
  });
  it.each([
    ['ask with no question', 'agent.ask', { to: 'reviewer' }],
    ['ask an unknown agent', 'agent.ask', { to: 'ghost', question: 'x' }],
    ['ask a shell', 'agent.ask', { to: 'shell-1', question: 'x' }],
    ['a question with ctrl-c', 'agent.ask', { to: 'reviewer', question: 'hi\u0003' }],
    ['a huge question', 'agent.ask', { to: 'reviewer', question: 'x'.repeat(100_000) }],
    ['a question that is not text', 'agent.ask', { to: 'reviewer', question: 7 }],
    ['recap with no agent', 'agent.recap', {}],
    ['recap an unknown agent', 'agent.recap', { agent: 'ghost' }],
    ['recap a shell', 'agent.recap', { agent: 'shell-1' }],
    ['recap with a list', 'agent.recap', { agent: ['reviewer'] }],
  ])('refuses %s', (_n, action, args) => {
    expect(m(action, args).steps).toHaveLength(0);
  });
});

describe('the recap carries the user\'s own words', () => {
  it('planFromModel puts the typed text on the recap step as its question (capped)', () => {
    const p = planFromModel([{ action: 'agent.recap', args: { agent: 'reviewer' } }], ctx, { text: 'did claude finish the migration?' });
    expect(first(p)!.args).toEqual({ agentIds: ['claude-1@app'], question: 'did claude finish the migration?' });
    expect(first(m('agent.recap', { agent: 'all' }))!.args).toEqual({ agentIds: 'all', question: null });
    const long = planFromModel([{ action: 'agent.recap', args: { agent: 'all' } }], ctx, { text: 'x'.repeat(5000) });
    expect((first(long)!.args.question as string).length).toBe(2000);
  });
  it('runPlan and the port send it', async () => {
    const recap = vi.fn().mockResolvedValue({ text: 'yes' });
    const p = planFromModel([{ action: 'agent.recap', args: { agent: 'reviewer' } }], ctx, { text: 'did it finish?' });
    await runPlan(p, { hub: null, nav: {} as JarvisPorts['nav'], server: { recap } as unknown as JarvisPorts['server'] });
    expect(recap).toHaveBeenCalledWith(['claude-1@app'], 'did it finish?');
  });
});

describe('agent.ask / agent.recap in runPlan', () => {
  const ports = (over: Partial<JarvisPorts['server']> = {}): JarvisPorts => ({
    hub: null,
    nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), line: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() },
    server: {
      spawn: vi.fn(), run: vi.fn(), interrupt: vi.fn(), close: vi.fn(), message: vi.fn(), startServer: vi.fn(), stopServer: vi.fn(),
      answerCall: vi.fn(), dismissCall: vi.fn(), recap: vi.fn(), ...over,
    } as JarvisPorts['server'],
  });

  it('asks with ask: true and records the question id so the UI can wait for the reply', async () => {
    const message = vi.fn().mockResolvedValue({ delivered: 'queued', id: 'Q1', ask: true, to: { agentId: 'codex-1@app', alias: null } });
    const r = await runPlan(m('agent.ask', { to: 'codex', question: 'why X?' }), ports({ message }));
    expect(message).toHaveBeenCalledWith('codex-1@app', 'why X?', { ask: true });
    expect(r.ok).toBe(true);
    expect(r.asks).toEqual([{ id: 'Q1', delivered: 'queued', to: { agentId: 'codex-1@app', alias: null } }]);
    expect(r.messages).toEqual([]);
  });
  it('an older server\'s typed counts as sent; an answer with no id records nothing', async () => {
    const message = vi.fn().mockResolvedValueOnce({ delivered: 'typed', id: 'Q2', to: { agentId: 'claude-1@app', alias: null } }).mockResolvedValueOnce({ delivered: 'sent', to: { agentId: 'claude-1@app', alias: null } });
    const r = await runPlan(planFromModel([{ action: 'agent.ask', args: { to: 'reviewer', question: 'a' } }, { action: 'agent.ask', args: { to: 'reviewer', question: 'b' } }], ctx), ports({ message }));
    expect(r.asks).toEqual([{ id: 'Q2', delivered: 'sent', to: { agentId: 'claude-1@app', alias: null } }]);
  });
  it('recap puts its text on the result as the answer to show', async () => {
    const recap = vi.fn().mockResolvedValue({ text: 'codex-1 is fixing the login test.', agents: [] });
    const r = await runPlan(m('agent.recap', { agent: 'codex' }), ports({ recap }));
    expect(recap).toHaveBeenCalledWith(['codex-1@app'], null);
    expect(r.recap).toBe('codex-1 is fixing the login test.');
    await runPlan(m('agent.recap', { agent: 'all' }), ports({ recap }));
    expect(recap).toHaveBeenLastCalledWith('all', null);
  });
  it('a recap failure carries its reason code for the UI (no_key → Settings)', async () => {
    const recap = vi.fn().mockRejectedValue(Object.assign(new Error('Recaps need an Anthropic API key'), { reason: 'no_key' }));
    const r = await runPlan(m('agent.recap', { agent: 'all' }), ports({ recap }));
    expect(r).toMatchObject({ ok: false, failed: { index: 0, reason: 'Recaps need an Anthropic API key', code: 'no_key' } });
  });
});

describe('server port: ask and recap', () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const bodyOf = (i = 0) => JSON.parse(jf.mock.calls[i]![1].body as string);
  beforeEach(() => jf.mockReset());

  it('message with ask posts ask: true; without it the body is unchanged', async () => {
    const port = createJarvisServerPort('ws1');
    jf.mockResolvedValue(res(201, { delivered: 'sent', id: 'Q1', to: { agentId: 'a@b', alias: null } }));
    await port.message('a@b', 'why?', { ask: true });
    expect(bodyOf(0)).toEqual({ to: 'a@b', body: 'why?', ask: true });
    await port.message('a@b', 'do it');
    expect(bodyOf(1)).toEqual({ to: 'a@b', body: 'do it' });
  });
  it('recap posts agents or all and returns text', async () => {
    const port = createJarvisServerPort('ws1');
    jf.mockResolvedValue(res(200, { text: 'all quiet', agents: [] }));
    await expect(port.recap(['claude-1@app'])).resolves.toMatchObject({ text: 'all quiet' });
    expect(jf.mock.calls[0]![0]).toBe('/api/w/ws1/jarvis/recap');
    expect(bodyOf(0)).toEqual({ agents: ['claude-1@app'] });
    await port.recap('all');
    expect(bodyOf(1)).toEqual({ all: true });
    await port.recap(['claude-1@app'], 'did it finish?');
    expect(bodyOf(2)).toEqual({ agents: ['claude-1@app'], question: 'did it finish?' });
  });
  it.each([
    [403, 'local_only', /Local only/],
    [503, 'no_key', /API key/],
    [503, 'timeout', /too long/],
    [503, 'model_unavailable', /unavailable/],
    [503, 'rate_limited', /Too many/],
    [404, undefined, /no agent ghost/],
  ])('recap %s %s reads in plain words and keeps the reason', async (status, reason, msg) => {
    const port = createJarvisServerPort('ws1');
    jf.mockResolvedValue(res(status, { error: { code: 'X', message: 'no agent ghost', ...(reason ? { details: { reason } } : {}) } }));
    const err = await port.recap('all').catch((e: Error & { reason?: string }) => e);
    expect((err as Error).message).toMatch(msg);
    if (reason) expect((err as { reason?: string }).reason).toBe(reason);
  });
});
