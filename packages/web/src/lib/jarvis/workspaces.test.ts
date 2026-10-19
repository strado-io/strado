import { describe, expect, it } from 'vitest';
import { buildModelContext, planFromModel } from './model';
import type { ParseContext } from './types';

const WS = [
  { id: 'w1', name: 'Personal' },
  { id: 'w2', name: 'FleetX' },
  { id: 'w3', name: 'fleetx-archive' },
  { id: 'w4', name: 'Strado' },
  { id: 'w5', name: 'Strado Labs' },
];
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [], focused: null, lastActedOn: null, currentWorktree: null, worktrees: [], focuses: [], packageScripts: {}, peers: [],
  workspaces: WS, currentWorkspace: { id: 'w1', name: 'Personal' },
  ...over,
});
const go = (name: string, c = ctx()) => planFromModel([{ action: 'nav.workspace', args: { name } }], c);
const wsOf = (name: string, c = ctx()) => { const s = go(name, c).steps[0]; return s?.action === 'nav.workspace' ? s.args.wsId : undefined; };

describe('workspaces in the model context', () => {
  it('the current workspace and every workspace, by name', () => {
    const m = buildModelContext(ctx());
    expect(m.workspace).toEqual({ name: 'Personal' });
    expect(m.workspaces).toEqual(WS.map((w) => ({ name: w.name })));
  });
  it('unknown current workspace: null; none known: []', () => {
    const m = buildModelContext(ctx({ currentWorkspace: null, workspaces: undefined }));
    expect(m.workspace).toBeNull();
    expect(m.workspaces).toEqual([]);
  });
  it('names are scrubbed (no secret-looking or control text) and capped at 30', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, name: `ws ${i}` }));
    const m = buildModelContext(ctx({ workspaces: [{ id: 's', name: 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' }, { id: 'c', name: 'bad\u001bname' }, ...many] }));
    expect(m.workspaces).toHaveLength(30);
    expect(m.workspaces.some((w) => /ghp_/.test(w.name))).toBe(false);
    expect(m.workspaces.some((w) => /\u001b/.test(w.name))).toBe(false);
  });
});

describe('nav.workspace: "switch to the X workspace"', () => {
  it('exact name first, even when it is also a prefix of another', () => {
    expect(wsOf('FleetX')).toBe('w2');
    expect(wsOf('Strado')).toBe('w4');
  });
  it('then case-insensitive', () => {
    expect(wsOf('fleetx')).toBe('w2');
    expect(wsOf('strado labs')).toBe('w5');
  });
  it('then a unique prefix', () => {
    expect(wsOf('fleetx-a')).toBe('w3');
    expect(wsOf('Strado L')).toBe('w5');
  });
  it('the step: a nav.workspace to that id, summarised by name', () => {
    const p = go('fleetx');
    expect(p.executable).toBe(true);
    expect(p.steps).toEqual([expect.objectContaining({ action: 'nav.workspace', args: { wsId: 'w2' } })]);
    expect(p.summary).toBe('Switch to workspace FleetX');
  });
  it('the current workspace: "Already in Personal", no step', () => {
    for (const name of ['Personal', 'personal', 'pers']) {
      const p = go(name);
      expect(p.steps).toHaveLength(0);
      expect(p.summary).toBe('Already in Personal');
    }
  });
  it('an ambiguous prefix is refused with the matching names', () => {
    const p = go('fleet');
    expect(p.steps).toHaveLength(0);
    expect(p.executable).toBe(false);
    expect(p.summary).toMatch(/FleetX, fleetx-archive/);
  });
  it('an unknown name is refused with the list of names', () => {
    const p = go('Acme');
    expect(p.steps).toHaveLength(0);
    expect(p.summary).toMatch(/No workspace "Acme".*Personal, FleetX, fleetx-archive, Strado, Strado Labs/);
  });
});
