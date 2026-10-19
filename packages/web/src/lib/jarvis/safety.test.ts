import { describe, expect, it } from 'vitest';
import { bindPlan, bindTarget, destructiveCommand, isDestructive, verifyPlan, verifyTarget, withSafety } from './safety';
import type { Chip, ParseContext, Step, TabInfo, TabRef } from './types';

const W = '/wt/app';
const S1: TabRef = { worktreePath: W, mode: 'shell', sessionId: '1' };
const S2: TabRef = { worktreePath: W, mode: 'shell', sessionId: '2' };
const info = (r: TabRef, busy = false): TabInfo => ({ ...r, label: r.sessionId, busy });
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [info(S1), info(S2, true)], focused: S1, lastActedOn: null, currentWorktree: W,
  worktrees: [], focuses: [], packageScripts: {}, peers: [], ...over,
});
const base = { risk: 'exec' as const, where: 'server' as const, undoable: false, needsConfirm: false, chips: [] as Chip[] };
const run = (command: string, target: TabRef = S1): Step => ({ ...base, action: 'shell.run', args: { command }, target: { kind: 'tab', ref: target } });
const close = (target: TabRef): Step => ({ ...base, risk: 'destructive', action: 'tab.close', args: {}, target: { kind: 'tab', ref: target } });

describe('destructiveCommand', () => {
  it.each([
    'rm -rf node_modules', 'rm -fr /', 'rm -r -f build', 'sudo rm -rf /var', 'git push --force', 'git push -f origin main',
    'git push origin +main', 'git push --force-with-lease', 'git reset --hard HEAD~3', 'git clean -fdx', 'git branch -D feature',
    'git checkout -- .', 'git restore .', 'psql -c "DROP TABLE users"', 'drop database prod', 'kill -9 1234', 'killall node',
    'pkill -f vite', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', 'chmod -R 777 /', 'truncate -s 0 app.log',
    'docker system prune -af', 'kubectl delete ns prod', 'echo x > /dev/sda',
  ])('flags %s', (cmd) => { expect(destructiveCommand(cmd)).not.toBeNull(); });

  it.each(['npm run dev', 'git push origin main', 'git status', 'rm notes.txt', 'ls -rf', 'git reset HEAD file', 'echo drop it', 'npm run kill-port-docs'])(
    'leaves %s alone', (cmd) => { expect(destructiveCommand(cmd)).toBeNull(); });

  it('names what it found', () => {
    expect(destructiveCommand('git push --force')).toMatch(/force push/i);
  });
});

describe('isDestructive', () => {
  it('a destructive shell command, in shell.run, tab.open and server.start', () => {
    expect(isDestructive(run('rm -rf dist'), ctx())).toMatch(/recursive delete/i);
    const open: Step = { ...base, action: 'tab.open', args: { mode: 'shell', worktreePath: W, place: null, command: 'git reset --hard' }, target: { kind: 'none' } };
    expect(isDestructive(open, ctx())).toMatch(/hard reset/i);
    const start: Step = { ...base, action: 'server.start', args: { worktreePath: W, script: null, command: 'killall node' }, target: { kind: 'none' } };
    expect(isDestructive(start, ctx())).not.toBeNull();
  });

  it('closing or interrupting a busy tab, but not an idle one', () => {
    expect(isDestructive(close(S2), ctx())).toMatch(/running/i);
    expect(isDestructive(close(S1), ctx())).toBeNull();
    expect(isDestructive({ ...close(S2), action: 'tab.interrupt' } as Step, ctx())).toMatch(/running/i);
  });

  it('a harmless step is not destructive', () => {
    expect(isDestructive(run('npm test'), ctx())).toBeNull();
  });
});

describe('bindTarget / verifyTarget', () => {
  it('passes when nothing changed', () => {
    expect(verifyTarget(bindTarget(run('ls'), ctx()), ctx())).toEqual({ ok: true });
  });

  it('a layout change that touches nothing the step uses never aborts (live bug: auto-run said "layout changed")', () => {
    expect(verifyTarget(bindTarget(run('ls'), ctx()), ctx({ focused: S2 }))).toEqual({ ok: true });
    const open: Step = { ...base, risk: 'spawn', action: 'tab.open', args: { mode: 'shell', worktreePath: W, place: { split: 'right', anchor: { kind: 'tab', ref: S2 }, focus: false }, command: 'git status' }, target: { kind: 'none' } };
    expect(verifyTarget(bindTarget(open, ctx()), ctx({ focused: S2 }))).toEqual({ ok: true });
  });

  it('a slot closed and reopened between preview and run is target_replaced, even without an execution id (hub instance)', () => {
    const at = (instance?: string) => ctx({ tabs: [{ ...info(S1), instance }, info(S2, true)] });
    expect(verifyTarget(bindTarget(run('ls'), at('h1')), at('h2'))).toEqual({ ok: false, reason: 'target_replaced' });
    expect(verifyTarget(bindTarget(run('ls'), at('h1')), at('h1'))).toEqual({ ok: true });
    expect(verifyTarget(bindTarget(run('ls'), at()), at('h2'))).toEqual({ ok: true }); // unknown at bind: slot only
    const open: Step = { ...base, risk: 'spawn', action: 'tab.open', args: { mode: 'shell', worktreePath: W, place: { split: 'right', anchor: { kind: 'tab', ref: S1 }, focus: false } }, target: { kind: 'none' } };
    expect(verifyTarget(bindTarget(open, at('h1')), at('h2'))).toEqual({ ok: false, reason: 'target_replaced' });
  });

  it('checks the place anchor like a target: gone or replaced aborts', () => {
    const at = (anchor: TabRef): Step => ({ ...base, risk: 'spawn', action: 'tab.open', args: { mode: 'shell', worktreePath: W, place: { split: 'right', anchor: { kind: 'tab', ref: anchor }, focus: false } }, target: { kind: 'none' } });
    expect(verifyTarget(bindTarget(at(S2), ctx()), ctx({ tabs: [info(S1)] }))).toEqual({ ok: false, reason: 'target_gone' });
    const ex = { ...S2, executionId: 'e1' };
    expect(verifyTarget(bindTarget(at(ex), ctx({ tabs: [info(S1), info(ex)] })), ctx({ tabs: [info(S1), info({ ...S2, executionId: 'e2' })] }))).toEqual({ ok: false, reason: 'target_replaced' });
    const placed: Step = { ...base, risk: 'layout', where: 'hub', action: 'tab.place', args: { place: { split: 'down', anchor: { kind: 'tab', ref: S2 }, focus: false } }, target: { kind: 'tab', ref: S1 } };
    expect(verifyTarget(bindTarget(placed, ctx()), ctx({ tabs: [info(S1)] }))).toEqual({ ok: false, reason: 'target_gone' });
  });

  it('aborts when the target tab is gone, even if the version was not bumped', () => {
    expect(verifyTarget(bindTarget(run('ls'), ctx()), ctx({ tabs: [info(S2, true)] }))).toEqual({ ok: false, reason: 'target_gone' });
  });

  it('aborts a close whose target became busy after the preview (the confirm is stale)', () => {
    const bound = bindTarget(close(S1), ctx());
    expect(verifyTarget(bound, ctx({ tabs: [info(S1, true), info(S2, true)] }))).toEqual({ ok: false, reason: 'target_busy' });
  });

  it('a step with no tab target or anchor has nothing to check', () => {
    const nav: Step = { ...base, risk: 'read', where: 'hub', action: 'nav.worktree', args: { path: W }, target: { kind: 'none' } };
    expect(verifyTarget(bindTarget(nav, ctx()), ctx({ tabs: [] }))).toEqual({ ok: true });
  });

  it('a whole plan: the first failing step names its index', () => {
    const bound = bindPlan({ steps: [run('ls'), close(S2)], source: 'rule', summary: '', executable: true }, ctx());
    expect(verifyPlan(bound, ctx())).toEqual({ ok: true });
    expect(verifyPlan(bound, ctx({ tabs: [info(S1)] }))).toEqual({ ok: false, reason: 'target_gone', step: 1 });
  });
});

describe('withSafety', () => {
  it('recomputes the confirm after an edit swapped the target to a busy tab', () => {
    const edited = { ...close(S1), target: { kind: 'tab' as const, ref: S2 } };
    expect(withSafety(edited, ctx())).toMatchObject({ needsConfirm: true, confirmReason: expect.stringMatching(/running/) });
  });

  it('clears a confirm the edit made unnecessary', () => {
    const stale = { ...close(S1), needsConfirm: true, confirmReason: 'a process is running in that tab' };
    const fresh = withSafety(stale, ctx());
    expect(fresh.needsConfirm).toBe(false);
    expect(fresh).not.toHaveProperty('confirmReason');
  });
});

describe('execution identity', () => {
  const withEx = (r: TabRef, executionId: string): TabRef => ({ ...r, executionId });
  it('a tab whose slot was reused by a new execution is target_replaced', () => {
    const bound = bindTarget(run('ls', withEx(S1, 'e1')), ctx({ tabs: [info(withEx(S1, 'e1')), info(S2, true)] }));
    expect(verifyTarget(bound, ctx({ tabs: [info(withEx(S1, 'e2')), info(S2, true)] }))).toEqual({ ok: false, reason: 'target_replaced' });
  });
  it('the same execution passes; a ref without an execution id is matched by slot', () => {
    const tabs = [info(withEx(S1, 'e1')), info(S2, true)];
    expect(verifyTarget(bindTarget(run('ls', withEx(S1, 'e1')), ctx({ tabs })), ctx({ tabs }))).toEqual({ ok: true });
    expect(verifyTarget(bindTarget(run('ls'), ctx({ tabs })), ctx({ tabs }))).toEqual({ ok: true });
  });
  it('isDestructive finds a busy tab by slot even when the step carries an execution id', () => {
    expect(isDestructive(close(withEx(S2, 'e9')), ctx())).toMatch(/running/);
  });
});
