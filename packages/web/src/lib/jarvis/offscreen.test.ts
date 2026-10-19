import { describe, expect, it, vi } from 'vitest';
import { buildModelContext, planFromModel } from './model';
import { runPlan } from './execute';
import type { ParseContext, TabInfo } from './types';

const SMAIN = '/wt/strado/main';
const WMAIN = '/wt/website/main';
const shell = (path: string, n: string, over: Partial<TabInfo> = {}): TabInfo =>
  ({ worktreePath: path, mode: 'shell', sessionId: n, label: `Shell ${n}`, busy: false, agentId: `shell-${n}@x`, executionId: `e${n}`, ...over });
// Home: no worktree on screen; the tabs come from the registry.
const home = (tabs: TabInfo[] = [shell(SMAIN, '1')]): ParseContext => ({
  tabs, focused: null, lastActedOn: null, currentWorktree: null,
  worktrees: [
    { path: SMAIN, name: 'Strado/main', branch: 'main', repoName: 'Strado' },
    { path: WMAIN, name: 'Strado Website/main', branch: 'main', repoName: 'Strado Website' },
  ],
  focuses: [], packageScripts: {}, peers: [],
});
const one = (action: string, target: string, ctx: ParseContext, args: Record<string, unknown> = {}) =>
  planFromModel([{ action, args: { tab: target, ...args } }], ctx);

describe('tabs in worktrees that are not on screen', () => {
  it('the model context names each tab "<worktree>/<tab>" and gives its worktree', () => {
    expect(buildModelContext(home()).tabs).toEqual([{ name: 'Strado/main/shell-1', mode: 'shell', label: 'Shell 1', busy: false, worktree: 'Strado/main' }]);
  });
  it('home screen: "close the shell in strado main" is one tab.close for that tab', () => {
    for (const name of ['Strado/main/shell-1', 'Strado/main/shell', 'strado/main/Shell 1']) {
      const p = one('tab.close', name, home());
      expect(p.steps).toHaveLength(1);
      expect(p.steps[0]).toMatchObject({ action: 'tab.close', where: 'server', target: { kind: 'tab', ref: { worktreePath: SMAIN, mode: 'shell', sessionId: '1', executionId: 'e1' } } });
    }
  });
  it('interrupt and run reach the off-screen tab too', () => {
    expect(one('tab.interrupt', 'Strado/main/shell-1', home()).steps[0]).toMatchObject({ action: 'tab.interrupt', target: { kind: 'tab', ref: { worktreePath: SMAIN, sessionId: '1' } } });
    expect(planFromModel([{ action: 'shell.run', args: { tab: 'Strado/main/shell-1', command: 'ls' } }], home()).steps[0])
      .toMatchObject({ action: 'shell.run', target: { kind: 'tab', ref: { worktreePath: SMAIN, sessionId: '1' } } });
  });
  it('home screen: a bare "close the shell" never reaches into another worktree', () => {
    for (const name of ['shell', 'the shell', 'Shell 1', 'shell-1']) expect(one('tab.close', name, home()).steps).toHaveLength(0);
  });
  it('a bare "the shell" means this worktree\'s, even with another worktree\'s shells known', () => {
    const c = { ...home([shell(SMAIN, '1', { onScreen: false }), shell(WMAIN, '2', { onScreen: true })]), currentWorktree: WMAIN };
    expect(one('tab.close', 'the shell', c).steps[0]).toMatchObject({ target: { kind: 'tab', ref: { worktreePath: WMAIN, sessionId: '2' } } });
  });
  it('a shell in another worktree is not taken for "the shell" of this one', () => {
    const p = one('tab.close', 'Strado Website/main/shell', home());
    expect(p.steps).toHaveLength(0);
  });
  it('closing an off-screen tab that is running something keeps the confirm', () => {
    const p = one('tab.close', 'Strado/main/shell-1', home([shell(SMAIN, '1', { busy: true })]));
    expect(p.steps[0]).toMatchObject({ needsConfirm: true, confirmReason: expect.stringMatching(/running something/) });
  });
  it('closing goes to the server with the full ref, no worktree on screen needed', async () => {
    const close = vi.fn(async () => ({}));
    const p = one('tab.close', 'Strado/main/shell-1', home());
    const r = await runPlan({ ...p, steps: p.steps.map((s) => ({ ...s, needsConfirm: false })) }, {
      hub: null, server: { close } as never, nav: {} as never, app: {} as never,
    } as never);
    expect(r.failed).toBeUndefined();
    expect(close).toHaveBeenCalledWith({ worktreePath: SMAIN, mode: 'shell', sessionId: '1', executionId: 'e1' });
  });
  it('focusing an off-screen tab opens its worktree first, then focuses it once it is there', async () => {
    let live = false;
    const focus = vi.fn(() => live);
    const hubPort = { path: SMAIN, snapshot: () => null, restore: () => {}, place: async () => ({ ok: true as const }), focus, openBrowser: async () => null, closeLocal: () => {} };
    const ensureWorktree = vi.fn(async () => { setTimeout(() => { live = true; }, 30); return hubPort; });
    const p = one('tab.focus', 'Strado/main/shell-1', home());
    expect(p.steps[0]).toMatchObject({ action: 'tab.focus', target: { kind: 'tab', ref: { worktreePath: SMAIN } } });
    const r = await runPlan(p, { hub: null, server: {} as never, nav: {} as never, app: {} as never, ensureWorktree } as never);
    expect(ensureWorktree).toHaveBeenCalledWith(SMAIN);
    expect(r.failed).toBeUndefined();
    expect(focus).toHaveBeenLastCalledWith(expect.objectContaining({ worktreePath: SMAIN, sessionId: '1' }));
  });
});
