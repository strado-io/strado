import { describe, it, expect, vi, beforeEach } from 'vitest';

const focuses = vi.hoisted(() => ({
  list: vi.fn(async () => [{ id: 'f1', name: 'Billing', members: [], createdAt: 't', lastActiveAt: 't' }]),
  create: vi.fn(async () => ({ id: 'f9', name: 'Spike', members: ['local:/w/api'], createdAt: 't', lastActiveAt: 't' })),
  update: vi.fn(async () => ({})),
  remove: vi.fn(async () => undefined),
}));
vi.mock('../../api', () => ({ api: { focuses } }));

import { jarvisApp, trackStarting } from './FocusJarvisHost';
import { __resetFocuses, readActiveFocusId } from '../../hooks/useFocuses';

beforeEach(() => {
  localStorage.clear();
  __resetFocuses();
  localStorage.setItem('strado:active-focus-by-ws', JSON.stringify({ ws1: 'f1' }));
  for (const fn of Object.values(focuses)) fn.mockClear();
});

describe('jarvisApp (W3)', () => {
  it('a create makes the Focus on the server but never activates it; the list refetches', async () => {
    const r = await jarvisApp('ws1').focus!({ op: 'create', focusId: null, name: ' Spike ', worktreePaths: ['/w/api'] });
    expect(r).toEqual({ focusId: 'f9' });
    expect(focuses.create).toHaveBeenCalledWith('ws1', { name: 'Spike', members: ['local:/w/api'] });
    expect(readActiveFocusId('ws1')).toBe('f1');
    expect(focuses.list).toHaveBeenCalled();
  });

  it('rename, add and remove edit the named Focus', async () => {
    const app = jarvisApp('ws1');
    await app.focus!({ op: 'rename', focusId: 'f1', name: 'Billing 2', worktreePaths: [] });
    await app.focus!({ op: 'add', focusId: 'f1', name: null, worktreePaths: ['/w/web'] });
    await app.focus!({ op: 'remove', focusId: 'f1', name: null, worktreePaths: ['/w/web'] });
    expect(focuses.update.mock.calls).toEqual([
      ['ws1', 'f1', { name: 'Billing 2' }],
      ['ws1', 'f1', { addMembers: ['local:/w/web'] }],
      ['ws1', 'f1', { removeMembers: ['local:/w/web'] }],
    ]);
  });

  it('pages and settings are not Jarvis\'s', () => {
    expect(() => jarvisApp('ws1').page('usage')).toThrow();
  });
});

describe('trackStarting', () => {
  it('stamps new starting cards, keeps the first stamp, and drops cards no longer starting', () => {
    const m = new Map<string, number>();
    trackStarting(m, ['a', 'b'], 100);
    trackStarting(m, ['b', 'c'], 200);
    expect([...m]).toEqual([['b', 100], ['c', 200]]);
    trackStarting(m, [], 300);
    expect(m.size).toBe(0);
  });
});
