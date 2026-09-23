import { describe, expect, it } from 'vitest';
import { createVsCodeWindowRegistry } from '../../src/services/vscodeWindows.js';

// The Strado extension inside each serve-web window reports its extension
// host pid + workspace folder, so the Sessions view can attribute that
// window's process tree to a worktree.
describe('vscode window registry', () => {
  it('lists reported windows and forgets them on request', () => {
    const alive = new Set([100, 200]);
    const reg = createVsCodeWindowRegistry({ isAlive: (pid) => alive.has(pid), now: () => 1000 });
    reg.report(100, '/wt/a');
    reg.report(200, '/wt/b');
    expect(reg.list()).toEqual([{ pid: 100, folder: '/wt/a' }, { pid: 200, folder: '/wt/b' }]);
    reg.forget(100);
    expect(reg.list()).toEqual([{ pid: 200, folder: '/wt/b' }]);
  });

  it('drops windows whose extension host died, and stale ones that stopped heartbeating', () => {
    const alive = new Set([100, 200]);
    let t = 0;
    const reg = createVsCodeWindowRegistry({ isAlive: (pid) => alive.has(pid), now: () => t, ttlMs: 90_000 });
    reg.report(100, '/wt/a');
    reg.report(200, '/wt/b');
    alive.delete(100);
    expect(reg.list()).toEqual([{ pid: 200, folder: '/wt/b' }]);
    t = 91_000; // 200 never re-reported
    expect(reg.list()).toEqual([]);
  });

  it('a re-report moves a pid to a new folder (window switched workspace)', () => {
    const reg = createVsCodeWindowRegistry({ isAlive: () => true, now: () => 0 });
    reg.report(100, '/wt/a');
    reg.report(100, '/wt/c');
    expect(reg.list()).toEqual([{ pid: 100, folder: '/wt/c' }]);
  });

  it('closeFolder kills and forgets every window showing that folder', async () => {
    const reg = createVsCodeWindowRegistry({ isAlive: () => true, now: () => 0 });
    reg.report(100, '/wt/a');
    reg.report(200, '/wt/b');
    const killed: number[] = [];
    const n = await reg.closeFolder('/wt/a', async (pid) => { killed.push(pid); });
    expect(n).toBe(1);
    expect(killed).toEqual([100]);
    expect(reg.list()).toEqual([{ pid: 200, folder: '/wt/b' }]);
  });
});
