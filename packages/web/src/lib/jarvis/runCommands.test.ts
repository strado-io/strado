import { describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { buildModelContext, describeRun, planFromModel } from './model';
import { planKey } from './parse';
import { runPlan, type JarvisPorts } from './execute';
import { createJarvisServerPort, scriptsContext } from './serverPort';
import type { ParseContext, Plan } from './types';

// "run api" / "stop web": the box starts and stops the repo's named run
// commands (server.start / server.stop with a run name; none = the default).

const W = '/wt/app';
const ctx: ParseContext = {
  tabs: [], focused: null, lastActedOn: null, currentWorktree: W,
  worktrees: [{ path: W, name: 'app' }, { path: '/wt/other', name: 'other' }], focuses: [],
  packageScripts: { dev: 'npm run dev' }, peers: [],
  runCommands: [{ id: 'dev', name: 'dev' }, { id: 'api', name: 'API server' }],
};
const m = (action: string, args: unknown, c: ParseContext = ctx) => planFromModel([{ action, args }], c);
const first = (p: Plan) => p.steps[0] as unknown as { action: string; args: Record<string, unknown>; chips: { label: string }[] } | undefined;
const ports = (over: Partial<JarvisPorts['server']> = {}): JarvisPorts => ({
  hub: null,
  nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() },
  server: {
    spawn: vi.fn(), run: vi.fn(), interrupt: vi.fn(), close: vi.fn(), message: vi.fn(), startServer: vi.fn(), stopServer: vi.fn(),
    answerCall: vi.fn(), dismissCall: vi.fn(), ...over,
  } as JarvisPorts['server'],
});

describe('named run commands in the box', () => {
  it('the model sees the current worktree\'s run command names', () => {
    expect(buildModelContext(ctx).runCommands).toEqual([{ name: 'dev' }, { name: 'API server' }]);
    expect(buildModelContext({ ...ctx, runCommands: undefined }).runCommands).toEqual([]);
  });

  it('"run api": server.start with that run, by its id, labelled by name (any case)', () => {
    const p = m('server.start', { worktree: null, run: 'api server' });
    expect(first(p)).toMatchObject({ action: 'server.start', args: { worktreePath: W, run: 'api' } });
    expect(p.summary).toBe('Start API server');
  });

  it('"stop api": server.stop with that run', () => {
    const p = m('server.stop', { worktree: null, run: 'API server' });
    expect(first(p)).toMatchObject({ action: 'server.stop', args: { worktreePath: W, run: 'api' } });
    expect(p.summary).toBe('Stop API server');
  });

  it('no run named: the default, as before', () => {
    const p = m('server.start', { worktree: null, run: null });
    expect(first(p)!.args.run).toBeNull();
    expect(p.summary).toBe('Start dev server');
    expect(m('server.stop', { worktree: null }).summary).toBe('Stop dev server');
    // The tool schema has no nullable run (an API cap on union params): "" is the default.
    expect(first(m('server.start', { worktree: null, run: '' }))!.args.run).toBeNull();
    expect(m('server.stop', { worktree: null, run: '  ' }).summary).toBe('Stop dev server');
  });

  it('a name the current worktree does not have is refused, listing what it has', () => {
    const p = m('server.start', { worktree: null, run: 'storybook' });
    expect(p.steps).toHaveLength(0);
    expect(p.summary).toMatch(/storybook/);
    expect(p.summary).toMatch(/dev, API server/);
  });

  it('another worktree (its commands unknown here): the name is passed through for the server to resolve', () => {
    expect(first(m('server.start', { worktree: 'other', run: 'web' }))).toMatchObject({ args: { worktreePath: '/wt/other', run: 'web' } });
  });

  it('planKey tells runs apart', () => {
    expect(planKey(m('server.start', { worktree: null, run: 'api server' }))).not.toBe(planKey(m('server.start', { worktree: null })));
  });

  it('runPlan starts and stops that run', async () => {
    const p = ports();
    await runPlan(m('server.start', { worktree: null, run: 'api server' }), p);
    expect(p.server.startServer).toHaveBeenCalledWith(W, expect.any(String), null, 'api');
    await runPlan(m('server.stop', { worktree: null, run: 'api server' }), p);
    expect(p.server.stopServer).toHaveBeenCalledWith(W, 'api');
    await runPlan(m('server.stop', { worktree: null }), p);
    expect(p.server.stopServer).toHaveBeenLastCalledWith(W, null);
  });

  it('describeRun names the run', async () => {
    const plan = m('server.stop', { worktree: null, run: 'api server' });
    const run = await runPlan(plan, ports());
    expect(describeRun(plan, run, ctx)).toBe('Ran: stopped API server');
  });
});

describe('server port and scripts context', () => {
  it('start/stop pass the run to the API (none for the default)', async () => {
    const start = vi.spyOn(api.worktrees, 'start').mockResolvedValue({} as never);
    const stop = vi.spyOn(api.worktrees, 'stop').mockResolvedValue(undefined);
    const port = createJarvisServerPort('ws1');
    await port.startServer(W, 'x', null, 'api');
    await port.startServer(W, 'x', null);
    await port.stopServer(W, 'api');
    await port.stopServer(W);
    expect(start.mock.calls).toEqual([['ws1', W, 'api'], ['ws1', W]]);
    expect(stop.mock.calls).toEqual([['ws1', W, 'api'], ['ws1', W]]);
    start.mockRestore(); stop.mockRestore();
  });

  it('scriptsContext carries the run commands (an older server sends none)', () => {
    expect(scriptsContext({ packageManager: 'npm', scripts: ['dev'], runCommands: [{ id: 'dev', name: 'dev' }] })).toMatchObject({ runCommands: [{ id: 'dev', name: 'dev' }] });
    expect(scriptsContext({ packageManager: 'npm', scripts: [] })).not.toHaveProperty('runCommands');
  });
});
