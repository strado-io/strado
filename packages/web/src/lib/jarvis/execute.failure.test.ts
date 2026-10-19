import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan, Step, StepOf, TabRef, ActionId } from './types';
import { runPlan, runUndo, type JarvisPorts } from './execute';
import { readPaneLayouts } from '../../hooks/paneLayout';

const P = '/w/a';
const ref = (mode: TabRef['mode'], sessionId: string, worktreePath = P): TabRef => ({ worktreePath, mode, sessionId });
function step<A extends ActionId>(action: A, args: StepOf<A>['args'], over: Partial<StepOf<A>> = {}): Step {
  return { action, args, target: { kind: 'none' }, risk: 'layout', where: 'hub', undoable: true, needsConfirm: false, chips: [], ...over } as Step;
}
const plan = (...steps: Step[]): Plan => ({ steps, source: 'rule', summary: 's', executable: true });

function ports(over: { hubPath?: string | null } = {}) {
  const hub = {
    path: over.hubPath === undefined ? P : over.hubPath!,
    snapshot: vi.fn(() => 'SNAP'),
    restore: vi.fn(),
    place: vi.fn().mockResolvedValue({ ok: true }),
    focus: vi.fn(() => true),
    openBrowser: vi.fn().mockResolvedValue(ref('browser', '2')),
    closeLocal: vi.fn(),
  };
  const server = {
    spawn: vi.fn().mockResolvedValue({ tab: ref('shell', '4') }),
    run: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    message: vi.fn().mockResolvedValue(undefined),
    startServer: vi.fn().mockResolvedValue(undefined),
    stopServer: vi.fn().mockResolvedValue(undefined),
    answerCall: vi.fn().mockResolvedValue(undefined),
    dismissCall: vi.fn().mockResolvedValue(undefined),
  };
  const nav = { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), line: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() };
  const p: JarvisPorts = { hub: over.hubPath === null ? null : hub, server, nav };
  return { p, hub, server, nav };
}

beforeEach(() => localStorage.clear());

const open = (over: Partial<StepOf<'tab.open'>['args']> = {}) =>
  step('tab.open', { mode: 'shell', worktreePath: P, place: { split: 'right', anchor: { kind: 'none' }, focus: false }, ...over } as never, { where: 'server', risk: 'spawn', undoable: true });
const placeTab = (index: number) => step('tab.place', { place: { split: 'down', anchor: { kind: 'none' }, focus: false } }, { target: { kind: 'step', index } });

describe('runPlan: a failure midway, then undo', () => {
  it('stops at the failing step, reports it, and runs nothing after it', async () => {
    const { p, hub, server } = ports();
    hub.place.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'no room' });
    const onStep = vi.fn();
    const r = await runPlan(plan(open(), placeTab(0), step('agent.message', { agentId: 'claude-1@a', text: 'hi' }, { where: 'server' })), { ...p, onStep });
    expect(r).toMatchObject({ ok: false, done: 1, failed: { index: 1, reason: 'no room' } });
    expect(server.message).not.toHaveBeenCalled();
    expect(onStep.mock.calls).toEqual([[0, 'running'], [0, 'done'], [1, 'running'], [1, 'failed']]);
  });

  it('undo after a midway failure closes the tab the plan opened and restores the layout', async () => {
    const { p, hub, server } = ports();
    hub.place.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'no room' });
    const r = await runPlan(plan(open(), placeTab(0)), p);
    expect(r.undo).toEqual(expect.arrayContaining([{ kind: 'close', tab: ref('shell', '4') }, { kind: 'restore', path: P, snapshot: 'SNAP' }]));
    await runUndo(r.undo, p);
    expect(server.close).toHaveBeenCalledWith(ref('shell', '4'));
    expect(hub.closeLocal).toHaveBeenCalledWith(ref('shell', '4'));
    expect(hub.restore).toHaveBeenCalledWith('SNAP');
  });

  it('a tab spawned in the failing step itself is still undoable (place failed after spawn)', async () => {
    const { p, hub, server } = ports();
    hub.place.mockResolvedValue({ ok: false, reason: 'anchor gone' });
    const r = await runPlan(plan(open()), p);
    expect(r).toMatchObject({ ok: false, done: 0, failed: { index: 0 } });
    await runUndo(r.undo, p);
    expect(server.close).toHaveBeenCalledWith(ref('shell', '4'));
  });

  it('the command failing after the spawn leaves the new tab undoable too', async () => {
    const { p, server } = ports();
    server.run.mockRejectedValue(new Error('pty died'));
    const r = await runPlan(plan(open({ command: 'npm test' })), p);
    expect(r).toMatchObject({ ok: false, failed: { index: 0, reason: 'pty died' } });
    expect(r.undo).toContainEqual({ kind: 'close', tab: ref('shell', '4') });
  });

  it('a server step failing after a layout step still restores the layout on undo', async () => {
    const { p, hub, server } = ports();
    server.message.mockRejectedValue(new Error('offline'));
    const r = await runPlan(plan(step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '1') } }), step('agent.message', { agentId: 'x@a', text: 'hi' }, { where: 'server' })), p);
    expect(r).toMatchObject({ ok: false, done: 1, failed: { index: 1, reason: 'offline' } });
    await runUndo(r.undo, p);
    expect(hub.restore).toHaveBeenCalledWith('SNAP');
  });

  it('a failure at the first step leaves nothing to undo', async () => {
    const { p, server } = ports();
    server.spawn.mockRejectedValue(new Error('no pty'));
    const r = await runPlan(plan(open(), open()), p);
    expect(r).toMatchObject({ ok: false, done: 0, undo: [] });
  });

  it('undo keeps going when a close fails (the tab is already gone)', async () => {
    const { p, hub, server } = ports();
    server.spawn.mockResolvedValueOnce({ tab: ref('shell', '4') }).mockResolvedValueOnce({ tab: ref('shell', '5') });
    hub.place.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'x' });
    const r = await runPlan(plan(open(), open(), placeTab(0)), p);
    server.close.mockRejectedValueOnce(new Error('gone'));
    await runUndo(r.undo, p);
    expect(server.close).toHaveBeenCalledTimes(2);
    expect(hub.closeLocal).toHaveBeenCalledWith(ref('shell', '4'));
    expect(hub.closeLocal).toHaveBeenCalledWith(ref('shell', '5'));
    expect(hub.restore).toHaveBeenCalledWith('SNAP');
  });

  it('undo with the layout changed since closes the plan\'s tabs but keeps the user\'s layout', async () => {
    const { p, hub, server } = ports();
    const r = await runPlan(plan(open()), p);
    await runUndo(r.undo, p, { restoreLayout: false });
    expect(server.close).toHaveBeenCalledWith(ref('shell', '4'));
    expect(hub.restore).not.toHaveBeenCalled();
  });

  it('undo never closes the user\'s own Shell 1 that a plan reused', async () => {
    const { p, server } = ports({ hubPath: null });
    const b = { path: '/w/b', snapshot: vi.fn(() => 'SNAP-B'), restore: vi.fn(), place: vi.fn().mockResolvedValue({ ok: true }), focus: vi.fn(() => true), openBrowser: vi.fn(), closeLocal: vi.fn() };
    p.ensureWorktree = vi.fn().mockResolvedValue(b);
    p.shellIdle = vi.fn().mockResolvedValue(true);
    const r = await runPlan(plan(open({ worktreePath: '/w/b', command: 'git status' }), step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '9', '/w/b') } })), p);
    expect(r.ok).toBe(true);
    expect(server.spawn).not.toHaveBeenCalled();
    await runUndo(r.undo, { ...p, hub: b });
    expect(server.close).not.toHaveBeenCalled();
    expect(b.closeLocal).not.toHaveBeenCalled();
  });

  it('a step whose verify fails (target replaced) stops the plan there', async () => {
    const { p, server } = ports();
    const verify = vi.fn((i: number) => (i === 1 ? { ok: false as const, reason: 'target_replaced' } : { ok: true as const }));
    const r = await runPlan(plan(open(), step('shell.run', { command: 'ls' }, { target: { kind: 'tab', ref: ref('shell', '2') }, where: 'server' })), { ...p, verify });
    expect(r).toMatchObject({ ok: false, failed: { index: 1, reason: 'target_replaced' } });
    expect(server.run).not.toHaveBeenCalled();
  });
});
