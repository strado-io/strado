import { afterEach, describe, expect, it } from 'vitest';
import { TABS_CAP, activeTab, emptyTabs, loadTabs, saveTabs, tabsKey, tabsReducer, type TabsAction, type TabsState } from './fileTabs';

const run = (...actions: TabsAction[]) => actions.reduce(tabsReducer, emptyTabs());
const paths = (s: TabsState, pane = 0) => s.panes[pane]!.tabs.map((t) => `${t.path}${t.preview ? '*' : ''}`);

afterEach(() => localStorage.clear());

describe('file tabs', () => {
  it('a new permanent tab goes right of the active one; an open file is switched to, at the asked line', () => {
    let s = run(
      { type: 'open', pane: 0, path: 'a', mode: 'permanent' },
      { type: 'open', pane: 0, path: 'b', mode: 'permanent' },
      { type: 'activate', pane: 0, path: 'a' },
      { type: 'open', pane: 0, path: 'c', mode: 'permanent' },
    );
    expect(paths(s)).toEqual(['a', 'c', 'b']);
    s = tabsReducer(s, { type: 'open', pane: 0, path: 'b', line: 9, mode: 'permanent' });
    expect(paths(s)).toEqual(['a', 'c', 'b']);
    expect(activeTab(s)).toMatchObject({ path: 'b', go: { line: 9 }, nonce: 1 });
  });

  it('shown again, a tab goes back to its cursor', () => {
    let s = run({ type: 'open', pane: 0, path: 'a', mode: 'permanent' }, { type: 'cursor', pane: 0, path: 'a', line: 30, col: 2 });
    expect(activeTab(s)!.go).toEqual({ line: 1, col: 1 }); // a cursor move doesn't re-ask the viewer
    s = run(...[{ type: 'open', pane: 0, path: 'a', mode: 'permanent' }, { type: 'cursor', pane: 0, path: 'a', line: 30, col: 2 },
      { type: 'open', pane: 0, path: 'b', mode: 'permanent' }, { type: 'activate', pane: 0, path: 'a' }] as TabsAction[]);
    expect(activeTab(s)!.go).toEqual({ line: 30, col: 2 });
  });

  it(`keeps ${TABS_CAP} tabs, closing the least recently used`, () => {
    let s = emptyTabs();
    for (let i = 0; i < TABS_CAP; i++) s = tabsReducer(s, { type: 'open', pane: 0, path: `f${i}`, mode: 'permanent' });
    s = tabsReducer(s, { type: 'activate', pane: 0, path: 'f0' });
    s = tabsReducer(s, { type: 'open', pane: 0, path: 'new', mode: 'permanent' });
    expect(s.panes[0]!.tabs).toHaveLength(TABS_CAP);
    expect(paths(s)).toContain('f0');
    expect(paths(s)).not.toContain('f1');
  });

  it('closing picks the neighbour; an emptied side pane goes, an emptied first pane hands over', () => {
    let s = run(
      { type: 'open', pane: 0, path: 'a', mode: 'permanent' },
      { type: 'open', pane: 0, path: 'b', mode: 'permanent' },
      { type: 'open', pane: 1, path: 'c', mode: 'permanent' },
    );
    expect(s.panes).toHaveLength(2);
    expect(s.focus).toBe(1);
    s = tabsReducer(s, { type: 'close', pane: 0, path: 'b' });
    expect(s.panes[0]!.active).toBe('a');
    const sideId = s.panes[1]!.id;
    s = tabsReducer(s, { type: 'close', pane: 0, path: 'a' });
    expect(s.panes).toHaveLength(1);
    expect(paths(s)).toEqual(['c']);
    expect(s.panes[0]!.id).toBe(sideId); // the same pane, so its viewer isn't rebuilt
    s = tabsReducer(s, { type: 'open', pane: 1, path: 'd', mode: 'permanent' });
    s = tabsReducer(s, { type: 'close', pane: 1, path: 'd' });
    expect(s.panes).toHaveLength(1);
    expect(s.focus).toBe(0);
  });

  it('saves and restores per scope, and survives junk or a throwing storage', () => {
    const s = run({ type: 'open', pane: 0, path: 'a', line: 4, mode: 'preview' }, { type: 'open', pane: 1, path: 'b', mode: 'permanent' });
    saveTabs('w1', s);
    const back = loadTabs('w1');
    expect(paths(back, 0)).toEqual(['a*']);
    expect(paths(back, 1)).toEqual(['b']);
    expect(activeTab(back, 0)!.go).toEqual({ line: 4, col: 1 });
    expect(loadTabs('w2').panes[0]!.tabs).toEqual([]);
    localStorage.setItem(tabsKey('w3'), '{not json');
    expect(loadTabs('w3')).toEqual(emptyTabs());
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('full'); };
    try { expect(() => saveTabs('w1', s)).not.toThrow(); } finally { Storage.prototype.setItem = set; }
  });
});
