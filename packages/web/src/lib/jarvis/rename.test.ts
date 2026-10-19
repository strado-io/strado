import { beforeEach, describe, expect, it } from 'vitest';
import { planFromModel } from './model';
import { runPlan, runUndo } from './execute';
import { readShellNames, renameSession, sessionNameKey } from '../../hooks/shellNames';
import { ACTION_IDS, type ParseContext, type TabInfo } from './types';

const CUR = '/wt/strado/Strado_Mcp';
const SMAIN = '/wt/strado/main';
const tab = (path: string, mode: TabInfo['mode'], n: string, over: Partial<TabInfo> = {}): TabInfo =>
  ({ worktreePath: path, mode, sessionId: n, label: `${mode} ${n}`, busy: false, ...over });
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [tab(CUR, 'shell', '1'), tab(CUR, 'claude', '2', { agentId: 'claude-2@x' }), tab(CUR, 'browser', '3'), tab(SMAIN, 'shell', '1', { onScreen: false })],
  focused: { worktreePath: CUR, mode: 'shell', sessionId: '1' }, lastActedOn: null, currentWorktree: CUR,
  worktrees: [{ path: CUR, name: 'Strado_Mcp' }, { path: SMAIN, name: 'Strado/main' }],
  focuses: [], packageScripts: {}, peers: [],
  ...over,
});
const rename = (t: string, name: unknown, c = ctx()) => planFromModel([{ action: 'tab.rename', args: { tab: t, name } }], c);
const noPorts = { hub: null, server: {} as never, nav: {} as never, app: {} as never } as never;

beforeEach(() => localStorage.clear());

describe('tab.rename: the plan', () => {
  it('is the last action id (same order as the server registry)', () => {
    expect(ACTION_IDS[ACTION_IDS.length - 1]).toBe('tab.rename');
  });
  it('"rename this shell to test": the focused tab, a layout step on the hub, undoable', () => {
    const p = rename('this', '  test ');
    expect(p.executable).toBe(true);
    expect(p.steps[0]).toMatchObject({ action: 'tab.rename', args: { name: 'test' }, risk: 'layout', where: 'hub', undoable: true, needsConfirm: false,
      target: { kind: 'tab', ref: { worktreePath: CUR, mode: 'shell', sessionId: '1' } } });
    expect(p.summary).toBe('Rename shell-1 to "test"');
  });
  it('an agent tab, and a tab in another worktree', () => {
    expect(rename('claude-2', 'reviewer').steps[0]).toMatchObject({ target: { kind: 'tab', ref: { mode: 'claude', sessionId: '2' } } });
    expect(rename('Strado/main/shell-1', 'db').steps[0]).toMatchObject({ target: { kind: 'tab', ref: { worktreePath: SMAIN, sessionId: '1' } } });
  });
  it('"" (or null) puts the default label back', () => {
    for (const name of ['', '   ', null]) {
      const p = rename('this', name);
      expect(p.steps[0]).toMatchObject({ action: 'tab.rename', args: { name: '' } });
      expect(p.summary).toBe('Reset the name of shell-1');
    }
  });
  it('a long name is capped at 40 characters', () => {
    const p = rename('this', 'x'.repeat(60));
    expect(p.steps[0]).toMatchObject({ args: { name: 'x'.repeat(40) } });
  });
  it('control characters and secret-looking names are refused', () => {
    // Fake tokens, built from pieces so secret scanners don't read them as leaks.
    for (const name of ['te\u001bst', 'a\rb', `${'sk_' + 'live_'}51HxQaB2c3d4e5f6g7h8i9j0kLmN`, `${'gh' + 'p_'}aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`]) {
      const p = rename('this', name);
      expect(p.steps).toHaveLength(0);
      expect(p.executable).toBe(false);
    }
  });
  it('a browser tab is refused', () => {
    const p = rename('browser 3', 'docs');
    expect(p.steps).toHaveLength(0);
    expect(p.summary).toMatch(/Only terminal and agent tabs can be renamed/);
  });
});

describe('tab.rename: running it', () => {
  it('saves the name where the strip reads it (the double-click rename store)', async () => {
    const r = await runPlan(rename('this', 'test'), noPorts);
    expect(r.ok).toBe(true);
    expect(readShellNames()[sessionNameKey(CUR, 'shell', '1')]).toBe('test');
  });
  it('works for an agent tab and for an off-screen tab, with no worktree on screen', async () => {
    await runPlan(rename('claude-2', 'reviewer'), noPorts);
    await runPlan(rename('Strado/main/shell-1', 'db'), noPorts);
    expect(readShellNames()).toMatchObject({ [sessionNameKey(CUR, 'claude', '2')]: 'reviewer', [sessionNameKey(SMAIN, 'shell', '1')]: 'db' });
  });
  it('"" clears the saved name', async () => {
    renameSession(CUR, 'shell', '1', 'old');
    await runPlan(rename('this', ''), noPorts);
    expect(readShellNames()[sessionNameKey(CUR, 'shell', '1')]).toBeUndefined();
  });
  it('undo puts the old name back (or none)', async () => {
    renameSession(CUR, 'shell', '1', 'old');
    const a = await runPlan(rename('this', 'new'), noPorts);
    const b = await runPlan(rename('claude-2', 'reviewer'), noPorts);
    await runUndo(b.undo, noPorts);
    await runUndo(a.undo, noPorts);
    expect(readShellNames()).toEqual({ [sessionNameKey(CUR, 'shell', '1')]: 'old' });
  });
  it('the box sees the new label right after (lastActedOn is the renamed tab)', async () => {
    const r = await runPlan(rename('this', 'test'), noPorts);
    expect(r.lastActedOn).toMatchObject({ worktreePath: CUR, mode: 'shell', sessionId: '1' });
  });
});
