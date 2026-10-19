import { describe, expect, it, vi } from 'vitest';
import { planFromModel } from './model';
import { planKey } from './parse';
import { runPlan, type JarvisPorts } from './execute';
import { ACTION_IDS, type ParseContext } from './types';

const ctx: ParseContext = { tabs: [], focused: null, lastActedOn: null, currentWorktree: null, worktrees: [], focuses: [], packageScripts: {}, peers: [] };
const one = (args: unknown) => planFromModel([{ action: 'ui.sidebar', args }], ctx);
const base = (): JarvisPorts => ({ hub: null, server: {} as JarvisPorts['server'], nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), line: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() } });
const app = (sidebar?: (show: boolean | null) => void) => ({ page: vi.fn(), settings: vi.fn(), set: vi.fn(), ...(sidebar ? { sidebar } : {}) });

describe('ui.sidebar', () => {
  it('is in the registry', () => {
    expect(ACTION_IDS).toContain('ui.sidebar');
  });
  it.each([[true, 'Show the sidebar'], [false, 'Hide the sidebar'], [null, 'Toggle the sidebar']] as const)('show %s → "%s", no confirm', (show, summary) => {
    const p = one({ show });
    expect(p.executable).toBe(true);
    expect(p.summary).toBe(summary);
    expect(p.steps[0]).toMatchObject({ action: 'ui.sidebar', args: { show }, needsConfirm: false, undoable: false });
  });
  it('show missing means toggle', () => {
    expect(one({}).steps[0]).toMatchObject({ args: { show: null } });
  });
  it.each([['a string', { show: 'true' }], ['a number', { show: 1 }], ['an object', { show: {} }], ['args not an object', 'show']])('refuses %s', (_n, args) => {
    expect(one(args).steps).toHaveLength(0);
  });
  it('planKey', () => {
    expect(planKey(one({ show: true }))).toBe('ui.sidebar:show');
    expect(planKey(one({ show: false }))).toBe('ui.sidebar:hide');
    expect(planKey(one({ show: null }))).toBe('ui.sidebar:toggle');
  });
  it('runs through the app port', async () => {
    const sidebar = vi.fn();
    const r = await runPlan(one({ show: false }), { ...base(), app: app(sidebar) });
    expect(r.ok).toBe(true);
    expect(sidebar).toHaveBeenCalledWith(false);
  });
  it('fails clearly with no port', async () => {
    expect(await runPlan(one({ show: true }), base())).toMatchObject({ ok: false, failed: { reason: 'The sidebar is not available here' } });
    expect(await runPlan(one({ show: true }), { ...base(), app: app() })).toMatchObject({ ok: false, failed: { reason: 'The sidebar is not available here' } });
  });
});
