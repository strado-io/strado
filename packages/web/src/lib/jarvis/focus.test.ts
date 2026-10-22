import { describe, expect, it, vi } from 'vitest';
import { planFromModel, type ModelStep } from './model';
import { planKey } from './parse';
import { runPlan, type JarvisPorts } from './execute';
import { withSafety } from './safety';
import { ACTION_IDS, type ParseContext, type Plan, type Step } from './types';

const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [], focused: null, lastActedOn: null, currentWorktree: '/wt/master',
  worktrees: [{ path: '/wt/master', name: 'master', branch: 'master' }, { path: '/wt/main', name: 'main', branch: 'main' }, { path: '/wt/fix', name: 'fix-login', branch: 'FLT-1-fix', ticketKey: 'FLT-1' }],
  focuses: [{ id: 'f1', name: 'Release' }, { id: 'f2', name: 'test' }],
  packageScripts: {}, peers: [], ...over,
});
const edit = (args: Record<string, unknown>): ModelStep => ({ action: 'focus.edit', args: { op: 'create', focus: null, name: null, worktrees: null, ...args } });
const one = (args: Record<string, unknown>, c = ctx()) => planFromModel([edit(args)], c);
const stepOf = (p: Plan) => p.steps[0] as Extract<Step, { action: 'focus.edit' }> | undefined;

describe('focus.edit from the model', () => {
  it('is in the registry', () => {
    expect(ACTION_IDS).toContain('focus.edit');
  });

  it('create with members: names → paths, a summary that lists them, no confirm', () => {
    const p = one({ op: 'create', name: 'ship it', worktrees: ['master', 'main'] });
    expect(p.executable).toBe(true);
    expect(stepOf(p)).toMatchObject({ args: { op: 'create', focusId: null, name: 'ship it', worktreePaths: ['/wt/master', '/wt/main'] }, risk: 'layout', where: 'hub', undoable: false, needsConfirm: false });
    expect(p.summary).toBe('Create Focus ship it (master, main)');
  });
  it('create without members', () => {
    const p = one({ op: 'create', name: 'empty' });
    expect(stepOf(p)!.args.worktreePaths).toEqual([]);
    expect(p.summary).toBe('Create Focus empty');
  });
  it('worktrees resolve by name, branch or ticket, and repeats collapse', () => {
    expect(stepOf(one({ op: 'create', name: 'x', worktrees: ['FLT-1', 'fix-login', 'FLT-1-fix'] }))!.args.worktreePaths).toEqual(['/wt/fix']);
  });
  it('rename', () => {
    const p = one({ op: 'rename', focus: 'release', name: 'Release 2' });
    expect(stepOf(p)!.args).toEqual({ op: 'rename', focusId: 'f1', name: 'Release 2', worktreePaths: [] });
    expect(p.summary).toBe('Rename Focus Release to Release 2');
  });
  it('delete asks first', () => {
    const p = one({ op: 'delete', focus: 'test' });
    expect(stepOf(p)).toMatchObject({ args: { op: 'delete', focusId: 'f2' }, needsConfirm: true, confirmReason: 'Delete Focus test?' });
    expect(p.summary).toBe('Delete Focus test');
    expect(withSafety(p.steps[0]!, ctx()).needsConfirm).toBe(true);
  });
  it('add and remove', () => {
    const add = one({ op: 'add', focus: 'Release', worktrees: ['main'] });
    expect(stepOf(add)!.args).toEqual({ op: 'add', focusId: 'f1', name: null, worktreePaths: ['/wt/main'] });
    expect(add.summary).toBe('Add main to Focus Release');
    const rm = one({ op: 'remove', focus: 'Release', worktrees: ['master', 'main'] });
    expect(rm.summary).toBe('Remove master, main from Focus Release');
    expect(stepOf(rm)!.needsConfirm).toBe(false);
  });
  it('planKey tells the edits apart', () => {
    expect(planKey(one({ op: 'add', focus: 'Release', worktrees: ['main'] }))).toBe('focus.edit:add:f1:/wt/main');
    expect(planKey(one({ op: 'create', name: 'x', worktrees: ['main'] }))).toBe('focus.edit:create:x:/wt/main');
  });

  const refusedCases: [string, Record<string, unknown> | unknown, RegExp?][] = [
    ['an unknown op', { op: 'merge', focus: 'Release' }],
    ['op missing', { op: null, name: 'x' }],
    ['create without a name', { op: 'create', name: null }, /name/],
    ['create with a name taken (any case)', { op: 'create', name: 'release' }, /already/],
    ['create with a name too long', { op: 'create', name: 'x'.repeat(61) }],
    ['create with a control character', { op: 'create', name: 'a\u001bb' }],
    ['rename without a focus', { op: 'rename', name: 'x' }],
    ['rename without a new name', { op: 'rename', focus: 'Release' }],
    ['rename onto another Focus\'s name', { op: 'rename', focus: 'Release', name: 'TEST' }, /already/],
    ['delete without a focus', { op: 'delete' }],
    ['an unknown focus', { op: 'delete', focus: 'nope' }, /No Focus/],
    ['add with no worktrees', { op: 'add', focus: 'Release', worktrees: [] }],
    ['add with worktrees null', { op: 'add', focus: 'Release', worktrees: null }],
    ['remove with an unknown worktree', { op: 'remove', focus: 'Release', worktrees: ['main', 'ghost'] }, /ghost/],
    ['worktrees not an array', { op: 'add', focus: 'Release', worktrees: 'main' }],
    ['a worktree that is not text', { op: 'add', focus: 'Release', worktrees: [3] }],
    ['too many worktrees', { op: 'create', name: 'x', worktrees: Array.from({ length: 51 }, () => 'main') }],
    ['a focus name from the prototype', { op: 'delete', focus: 'constructor' }],
  ];
  for (const [name, args, msg] of refusedCases) {
    it(`refuses ${name}`, () => {
      const p = one(args as Record<string, unknown>);
      expect(p.steps).toHaveLength(0);
      expect(p.executable).toBe(false);
      if (msg) expect(p.summary).toMatch(msg);
    });
  }
  it('two Focuses with the same name: refused, never a guess', () => {
    const p = one({ op: 'delete', focus: 'dup' }, ctx({ focuses: [{ id: 'a', name: 'Dup' }, { id: 'b', name: 'dup' }] }));
    expect(p.steps).toHaveLength(0);
  });
  it('args that are not an object are refused', () => {
    expect(planFromModel([{ action: 'focus.edit', args: null }], ctx()).steps).toHaveLength(0);
    expect(planFromModel([{ action: 'focus.edit', args: ['create'] }], ctx()).steps).toHaveLength(0);
  });
});

describe('focus.edit in runPlan', () => {
  const base = (): JarvisPorts => ({
    hub: null,
    server: {} as JarvisPorts['server'],
    nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() },
  });
  const plan = one({ op: 'add', focus: 'Release', worktrees: ['main'] });

  it('hands the step\'s args to the app port', async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    const r = await runPlan(plan, { ...base(), app: { page: vi.fn(), settings: vi.fn(), set: vi.fn(), focus } });
    expect(r.ok).toBe(true);
    expect(focus).toHaveBeenCalledWith({ op: 'add', focusId: 'f1', name: null, worktreePaths: ['/wt/main'] });
  });
  it('fails clearly with no port', async () => {
    const r = await runPlan(plan, base());
    expect(r).toMatchObject({ ok: false, failed: { index: 0, reason: 'Focuses are not available here' } });
    const r2 = await runPlan(plan, { ...base(), app: { page: vi.fn(), settings: vi.fn(), set: vi.fn() } });
    expect(r2).toMatchObject({ ok: false, failed: { reason: 'Focuses are not available here' } });
  });
  it('a port failure is the step\'s failure', async () => {
    const focus = vi.fn().mockRejectedValue(new Error('Focus not found'));
    const r = await runPlan(plan, { ...base(), app: { page: vi.fn(), settings: vi.fn(), set: vi.fn(), focus } });
    expect(r).toMatchObject({ ok: false, failed: { reason: 'Focus not found' } });
  });
});
