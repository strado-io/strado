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
  const nav = { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() };
  const p: JarvisPorts = { hub: over.hubPath === null ? null : hub, server, nav };
  return { p, hub, server, nav };
}

beforeEach(() => localStorage.clear());

describe('runPlan', () => {
  describe('a plan for a worktree that is not on screen (home, or another worktree)', () => {
    const otherHub = () => ({
      path: '/w/b', snapshot: vi.fn(() => 'SNAP-B'), restore: vi.fn(), place: vi.fn().mockResolvedValue({ ok: true }),
      focus: vi.fn(() => true), openBrowser: vi.fn(), closeLocal: vi.fn(),
    });

    it('from home: opens that worktree first, waits for its hub, then spawns and places the tabs there', async () => {
      const { p, server } = ports({ hubPath: null });
      const b = otherHub();
      p.ensureWorktree = vi.fn().mockResolvedValue(b);
      const r = await runPlan(plan(
        step('tab.open', { mode: 'claude', worktreePath: '/w/b', place: { split: 'right', anchor: { kind: 'none' }, focus: true } } as never, { where: 'server', risk: 'spawn' }),
        step('tab.open', { mode: 'shell', worktreePath: '/w/b', place: { split: 'down', anchor: { kind: 'step', index: 0 }, focus: false } } as never, { where: 'server', risk: 'spawn' }),
      ), p);
      expect(r.ok).toBe(true);
      expect(p.ensureWorktree).toHaveBeenCalledTimes(1);
      expect(p.ensureWorktree).toHaveBeenCalledWith('/w/b');
      expect((p.ensureWorktree as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(server.spawn.mock.invocationCallOrder[0]!);
      expect(b.place).toHaveBeenCalledTimes(2);
    });

    const openShell = (over: Record<string, unknown> = {}) => step('tab.open', { mode: 'shell', worktreePath: '/w/b', place: { split: 'right', anchor: { kind: 'none' }, focus: true }, ...over } as never, { where: 'server', risk: 'spawn' });

    it('"open a shell" in a worktree it brought up uses that view\'s own idle Shell 1 — no second shell', async () => {
      const { p, server } = ports({ hubPath: null });
      const b = otherHub();
      p.ensureWorktree = vi.fn().mockResolvedValue(b);
      p.shellIdle = vi.fn().mockResolvedValue(true);
      const r = await runPlan(plan(openShell({ command: 'npm run dev' })), p);
      expect(r.ok).toBe(true);
      expect(p.shellIdle).toHaveBeenCalledWith(ref('shell', '1', '/w/b'));
      expect(server.spawn).not.toHaveBeenCalled();
      expect(b.focus).toHaveBeenCalledWith(ref('shell', '1', '/w/b'));
      expect(server.run).toHaveBeenCalledWith(ref('shell', '1', '/w/b'), 'npm run dev');
      expect(r.opened[0]).toEqual(ref('shell', '1', '/w/b'));
      expect(r.undo.some((u) => u.kind === 'close')).toBe(false); // it was there before: undo never closes it
    });

    it('a just-shown Shell 1 not live yet: the command waits for it instead of failing', async () => {
      const { p, server } = ports({ hubPath: null });
      p.ensureWorktree = vi.fn().mockResolvedValue(otherHub());
      p.shellIdle = vi.fn().mockResolvedValue(true);
      server.run.mockRejectedValueOnce(new Error('no live tab with that reference')).mockResolvedValueOnce(undefined);
      const r = await runPlan(plan(openShell({ command: 'git status' })), p);
      expect(r.ok).toBe(true);
      expect(server.run).toHaveBeenCalledTimes(2);
    });

    it('Shell 1 busy (a dev server in it): a new shell, as before; only the first shell reuses it', async () => {
      const { p, server } = ports({ hubPath: null });
      p.ensureWorktree = vi.fn().mockResolvedValue(otherHub());
      p.shellIdle = vi.fn().mockResolvedValue(false);
      await runPlan(plan(openShell()), p);
      expect(server.spawn).toHaveBeenCalledTimes(1);

      const again = ports({ hubPath: null });
      again.p.ensureWorktree = vi.fn().mockResolvedValue(otherHub());
      again.p.shellIdle = vi.fn().mockResolvedValue(true);
      await runPlan(plan(openShell(), openShell()), again.p);
      expect(again.server.spawn).toHaveBeenCalledTimes(1); // the second one is new
    });

    it('a worktree already on screen: "open a shell" means a new one (its Shell 1 is in plain sight)', async () => {
      const { p, server } = ports({ hubPath: '/w/b' });
      p.shellIdle = vi.fn().mockResolvedValue(true);
      await runPlan(plan(openShell()), p);
      expect(p.shellIdle).not.toHaveBeenCalled();
      expect(server.spawn).toHaveBeenCalledTimes(1);
    });

    it('another worktree on screen: switches to the plan\'s worktree before a layout step', async () => {
      const { p, hub } = ports();
      const b = otherHub();
      p.ensureWorktree = vi.fn().mockResolvedValue(b);
      await runPlan(plan(step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '1', '/w/b') } })), p);
      expect(p.ensureWorktree).toHaveBeenCalledWith('/w/b');
      expect(b.focus).toHaveBeenCalledWith(ref('claude', '1', '/w/b'));
      expect(hub.focus).not.toHaveBeenCalled();
    });

    it('the target is checked once its worktree is open (its tabs exist only then)', async () => {
      const { p } = ports({ hubPath: null });
      const order: string[] = [];
      p.ensureWorktree = vi.fn(async () => { order.push('open'); return otherHub(); });
      p.verify = vi.fn(() => { order.push('verify'); return { ok: true as const }; });
      await runPlan(plan(step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '1', '/w/b') } })), p);
      expect(order).toEqual(['open', 'verify']);
    });

    it('the worktree already on screen is not reopened; server-only steps never open one', async () => {
      const { p } = ports();
      p.ensureWorktree = vi.fn();
      await runPlan(plan(
        step('tab.open', { mode: 'shell', worktreePath: P, place: null }, { where: 'server', risk: 'spawn' }),
        step('agent.message', { agentId: 'claude-1@b', text: 'hi' }, { where: 'server', risk: 'exec', undoable: false }),
      ), p);
      expect(p.ensureWorktree).not.toHaveBeenCalled();
    });

    it('undo across worktrees: one snapshot per worktree, each restored only onto a hub showing that worktree', async () => {
      const { p, hub } = ports();
      const b = otherHub();
      p.ensureWorktree = vi.fn().mockResolvedValue(b);
      const r = await runPlan(plan(
        step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '1') } }),
        step('tab.place', { place: { split: 'right', anchor: { kind: 'none' }, focus: false } } as never, { target: { kind: 'tab', ref: ref('shell', '1', '/w/b') } }),
      ), p);
      expect(r.undo).toEqual([{ kind: 'restore', path: P, snapshot: 'SNAP' }, { kind: 'restore', path: '/w/b', snapshot: 'SNAP-B' }]);
      // The toast's hub is B now: only B's snapshot goes back onto it.
      await runUndo(r.undo, { ...p, hub: b });
      expect(b.restore).toHaveBeenCalledTimes(1);
      expect(b.restore).toHaveBeenCalledWith('SNAP-B');
      expect(hub.restore).not.toHaveBeenCalled();
    });

    it('a worktree that will not open fails the step before anything is spawned', async () => {
      const { p, server } = ports({ hubPath: null });
      p.ensureWorktree = vi.fn().mockResolvedValue(null);
      const r = await runPlan(plan(step('tab.open', { mode: 'claude', worktreePath: '/w/b', place: null } as never, { where: 'server', risk: 'spawn' })), p);
      expect(r).toMatchObject({ ok: false, failed: { index: 0, reason: 'Could not open that worktree' } });
      expect(server.spawn).not.toHaveBeenCalled();
    });
  });

  it('spawn + place: the server opens the tab, the hub places it beside the anchor; undo closes it', async () => {
    const { p, hub, server } = ports();
    const r = await runPlan(plan(step('tab.open', { mode: 'shell', worktreePath: P, command: 'npm run dev', place: { split: 'right', anchor: { kind: 'tab', ref: ref('claude', '1') }, focus: false } }, { where: 'server', risk: 'spawn' })), p);
    // The tab shows (spawn + place) before the command runs in it.
    expect(server.spawn).toHaveBeenCalledWith({ mode: 'shell', worktreePath: P });
    expect(hub.place).toHaveBeenCalledWith(ref('shell', '4'), { split: 'right', anchor: ref('claude', '1'), focus: false }, expect.any(Number));
    expect(server.run).toHaveBeenCalledWith(ref('shell', '4'), 'npm run dev');
    expect(hub.place.mock.invocationCallOrder[0]!).toBeLessThan(server.run.mock.invocationCallOrder[0]!);
    expect(r).toMatchObject({ ok: true, done: 1, lastActedOn: ref('shell', '4') });
    await runUndo(r.undo, p);
    expect(server.close).toHaveBeenCalledWith(ref('shell', '4'));
  });

  it('"and then … it": a step target resolves to the tab an earlier step opened', async () => {
    const { p, server } = ports();
    const r = await runPlan(plan(
      step('tab.open', { mode: 'shell', worktreePath: P, place: null }, { where: 'server', risk: 'spawn' }),
      step('shell.run', { command: 'git status' }, { where: 'server', risk: 'exec', undoable: false, target: { kind: 'step', index: 0 } }),
    ), p);
    expect(r.ok).toBe(true);
    expect(server.run).toHaveBeenCalledWith(ref('shell', '4'), 'git status');
    // Which step opened what, for the thread ("Ran: opened shell-4 …").
    expect(r.opened).toEqual([ref('shell', '4'), null]);
  });

  it('stops on the first failure and reports which step and why', async () => {
    const { p, server } = ports();
    server.run.mockRejectedValueOnce(new Error('the user is typing in that tab'));
    const r = await runPlan(plan(
      step('shell.run', { command: 'ls' }, { where: 'server', risk: 'exec', undoable: false, target: { kind: 'tab', ref: ref('shell', '1') } }),
      step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '1') } }),
    ), p);
    expect(r).toMatchObject({ ok: false, done: 0, failed: { index: 0, reason: 'the user is typing in that tab' } });
    expect(p.hub!.focus).not.toHaveBeenCalled();
  });

  it('layout steps snapshot the hub once; undo restores it', async () => {
    const { p, hub } = ports();
    const r = await runPlan(plan(
      step('tab.place', { place: { split: 'down', anchor: { kind: 'none' }, focus: false } }, { target: { kind: 'tab', ref: ref('shell', '2') } }),
      step('tab.focus', {}, { target: { kind: 'tab', ref: ref('shell', '2') } }),
    ), p);
    expect(r.ok).toBe(true);
    expect(hub.snapshot).toHaveBeenCalledTimes(1);
    expect(hub.place).toHaveBeenCalledWith(ref('shell', '2'), { split: 'down', anchor: null, focus: false }, expect.any(Number));
    expect(hub.focus).toHaveBeenCalledWith(ref('shell', '2'));
    await runUndo(r.undo, p);
    expect(hub.restore).toHaveBeenCalledWith('SNAP');
  });

  it('browser.open goes through the hub; undo closes the tab it opened and restores the layout', async () => {
    const { p, hub } = ports();
    const r = await runPlan(plan(step('browser.open', { url: 'https://google.com', worktreePath: P, place: null })), p);
    expect(hub.openBrowser).toHaveBeenCalledWith('https://google.com', null, expect.any(Number));
    expect(r).toMatchObject({ ok: true, lastActedOn: ref('browser', '2') });
    await runUndo(r.undo, p);
    expect(hub.closeLocal).toHaveBeenCalledWith(ref('browser', '2'));
    expect(hub.restore).toHaveBeenCalled();
  });

  it('undo with restoreLayout:false (the user moved things since) only closes what the plan opened', async () => {
    const { p, hub, server } = ports();
    const r = await runPlan(plan(
      step('tab.open', { mode: 'shell', worktreePath: P, place: { split: 'right', anchor: { kind: 'none' }, focus: false } }, { where: 'server', risk: 'spawn' }),
      step('browser.open', { url: 'https://google.com', worktreePath: P, place: null }),
    ), p);
    await runUndo(r.undo, p, { restoreLayout: false });
    expect(hub.restore).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledWith(ref('shell', '4'));
    expect(hub.closeLocal).toHaveBeenCalledWith(ref('browser', '2'));
  });

  it('closing a terminal tab goes to the server (kills the pty); a Browser tab closes in the hub', async () => {
    const { p, server, hub } = ports();
    await runPlan(plan(step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, target: { kind: 'tab', ref: ref('shell', '2') } })), p);
    expect(server.close).toHaveBeenCalledWith(ref('shell', '2'));
    await runPlan(plan(step('tab.close', {}, { where: 'hub', target: { kind: 'tab', ref: ref('browser', '2') } })), p);
    expect(hub.closeLocal).toHaveBeenCalledWith(ref('browser', '2'));
  });

  it('answering or dismissing a call goes to the server by call id; "the line" is navigation', async () => {
    const { p, server, nav } = ports();
    const r = await runPlan(plan(
      step('call.answer', { callId: 'e1', agentId: 'claude-1@a', text: 'use postgres' }, { where: 'server', risk: 'exec', undoable: false }),
      step('call.dismiss', { callId: 'e2', agentId: 'claude-2@a' }, { where: 'server', risk: 'exec', undoable: false }),
    ), p);
    expect(r.ok).toBe(true);
    expect(server.answerCall).toHaveBeenCalledWith('e1', 'use postgres');
    expect(server.dismissCall).toHaveBeenCalledWith('e2');
  });

  it('"add repo" and "new worktree" open their dialogs (prefilled when the text named a path or repo)', async () => {
    const { p, nav } = ports();
    const r = await runPlan(plan(
      step('nav.addRepo', { path: '~/code/x' }, { risk: 'read', undoable: false }),
      step('nav.newWorktree', { repoPath: '/repos/app' }, { risk: 'read', undoable: false }),
      step('nav.newWorktree', { repoPath: null }, { risk: 'read', undoable: false }),
    ), p);
    expect(r.ok).toBe(true);
    expect(nav.addRepo).toHaveBeenCalledWith('~/code/x');
    expect(nav.newWorktree).toHaveBeenNthCalledWith(1, '/repos/app');
    expect(nav.newWorktree).toHaveBeenNthCalledWith(2, null);
  });

  it('agent.message reports how the server delivered it: sent (told it has mail) or queued (busy)', async () => {
    const { p, server } = ports();
    server.message
      .mockResolvedValueOnce({ delivered: 'sent', to: { agentId: 'claude-1@a', alias: null } })
      .mockResolvedValueOnce({ delivered: 'queued', id: 'm1', to: { agentId: 'claude-2@a', alias: 'reviewer' } });
    const r = await runPlan(plan(
      step('agent.message', { agentId: 'claude-1@a', text: 'how are you' }, { where: 'server', risk: 'exec', undoable: false }),
      step('agent.message', { agentId: 'claude-2@a', text: 'look' }, { where: 'server', risk: 'exec', undoable: false }),
    ), p);
    expect(r.messages).toEqual([
      { delivered: 'sent', to: { agentId: 'claude-1@a', alias: null } },
      { delivered: 'queued', to: { agentId: 'claude-2@a', alias: 'reviewer' } },
    ]);
  });

  it('a message that answered the agent\'s open call carries which call', async () => {
    const { p, server } = ports();
    server.message.mockResolvedValueOnce({ delivered: 'sent', to: { agentId: 'claude-1@a', alias: null }, answered: { callId: 'e1', title: 'Which DB?' } });
    const r = await runPlan(plan(step('agent.message', { agentId: 'claude-1@a', text: 'pg' }, { where: 'server', risk: 'exec', undoable: false })), p);
    expect(r.messages).toEqual([{ delivered: 'sent', to: { agentId: 'claude-1@a', alias: null }, answered: { callId: 'e1', title: 'Which DB?' } }]);
  });

  it('an older server\'s "typed" reads as "sent"; an unknown delivery is dropped', async () => {
    const { p, server } = ports();
    server.message
      .mockResolvedValueOnce({ delivered: 'typed', to: { agentId: 'claude-1@a', alias: null } })
      .mockResolvedValueOnce({ delivered: 'teleported', to: { agentId: 'claude-2@a', alias: null } });
    const r = await runPlan(plan(
      step('agent.message', { agentId: 'claude-1@a', text: 'a' }, { where: 'server', risk: 'exec', undoable: false }),
      step('agent.message', { agentId: 'claude-2@a', text: 'b' }, { where: 'server', risk: 'exec', undoable: false }),
    ), p);
    expect(r.messages).toEqual([{ delivered: 'sent', to: { agentId: 'claude-1@a', alias: null } }]);
  });

  it('agent.message to a shell: the server\'s 400 reason reaches the user in plain words', async () => {
    const { p, server } = ports();
    server.message.mockRejectedValueOnce(new Error('shell-1 is a shell: run a command in it instead'));
    const r = await runPlan(plan(step('agent.message', { agentId: 'shell-1@a', text: 'ls' }, { where: 'server', risk: 'exec', undoable: false })), p);
    expect(r.ok).toBe(false);
    expect(r.failed?.reason).toBe('shell-1 is a shell: run a command in it instead');
  });

  it('agent.message / interrupt / server start-stop go to the server; navigation to the nav port', async () => {
    const { p, server, nav } = ports();
    const r = await runPlan(plan(
      step('agent.message', { agentId: 'claude-1@a', text: 'fix it' }, { where: 'server', risk: 'exec', undoable: false }),
      step('tab.interrupt', {}, { where: 'server', risk: 'destructive', undoable: false, target: { kind: 'tab', ref: ref('shell', '1') } }),
      step('server.start', { worktreePath: P, script: 'dev', command: 'npm run dev' }, { where: 'server', risk: 'exec', undoable: false }),
      step('server.stop', { worktreePath: P }, { where: 'server', risk: 'destructive', undoable: false }),
      step('nav.worktree', { path: '/w/b' }, { risk: 'read' }),
    ), p);
    expect(r.ok).toBe(true);
    expect(server.message).toHaveBeenCalledWith('claude-1@a', 'fix it');
    expect(r.messages).toEqual([]); // the server said nothing about delivery (an older server)
    expect(server.interrupt).toHaveBeenCalledWith(ref('shell', '1'));
    expect(server.startServer).toHaveBeenCalledWith(P, 'npm run dev', 'dev', null);
    expect(server.stopServer).toHaveBeenCalledWith(P, null);
    expect(nav.worktree).toHaveBeenCalledWith('/w/b');
  });

  it('a hub step with no hub showing fails clearly; a spawn into another worktree stores its placement', async () => {
    const { p } = ports({ hubPath: null });
    const r = await runPlan(plan(step('tab.focus', {}, { target: { kind: 'tab', ref: ref('shell', '1') } })), p);
    expect(r).toMatchObject({ ok: false, failed: { index: 0, reason: 'Open a worktree first' } });
    const other = ports({ hubPath: '/w/other' });
    const r2 = await runPlan(plan(step('tab.open', { mode: 'shell', worktreePath: P, place: { split: 'down', anchor: { kind: 'tab', ref: ref('claude', '1') }, focus: false } }, { where: 'server', risk: 'spawn' })), other.p);
    expect(r2.ok).toBe(true);
    expect(other.hub.place).not.toHaveBeenCalled();
    expect(readPaneLayouts()[P]).toEqual([{ kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'leaf', key: 'claude:1' }, b: { kind: 'leaf', key: 'shell:4' } }]);
  });

  it('verify runs before each targeted step; a stale target aborts before anything happens', async () => {
    const { p, server } = ports();
    const verify = vi.fn(() => ({ ok: false as const, reason: 'the layout changed, check the preview again' }));
    const r = await runPlan(plan(step('shell.run', { command: 'ls' }, { where: 'server', risk: 'exec', undoable: false, target: { kind: 'tab', ref: ref('shell', '1') } })), { ...p, verify });
    expect(verify).toHaveBeenCalledWith(0);
    expect(server.run).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, failed: { index: 0, reason: 'the layout changed, check the preview again' } });
  });

  it('registry-only actions (agent.wait, ui.state) fail instead of pretending to run', async () => {
    const { p } = ports();
    const r = await runPlan(plan(step('agent.wait', { agentId: 'claude-1@a' }, { where: 'server', risk: 'read' })), p);
    expect(r).toMatchObject({ ok: false, failed: { index: 0, reason: 'Not available from the command box' } });
  });

  it('pages, Settings and settings go to the app port; without one they fail clearly', async () => {
    const { p } = ports();
    p.app = { page: vi.fn(), settings: vi.fn(), set: vi.fn().mockResolvedValue(undefined) };
    const r = await runPlan(plan(
      step('nav.page', { page: 'usage' }),
      step('settings.open', { section: 'appearance' }),
      step('settings.set', { setting: 'appearance.theme', value: 'nord' }),
    ), p);
    expect(r.ok).toBe(true);
    expect(p.app.page).toHaveBeenCalledWith('usage');
    expect(p.app.settings).toHaveBeenCalledWith('appearance');
    expect(p.app.set).toHaveBeenCalledWith('appearance.theme', 'nord');
    const bare = ports().p;
    expect((await runPlan(plan(step('nav.page', { page: 'usage' })), bare)).failed?.reason).toMatch(/not available/);
  });

  it('reports progress per step', async () => {
    const { p } = ports();
    const onStep = vi.fn();
    await runPlan(plan(step('tab.focus', {}, { target: { kind: 'tab', ref: ref('shell', '1') } })), { ...p, onStep });
    expect(onStep.mock.calls).toEqual([[0, 'running'], [0, 'done']]);
  });
});
