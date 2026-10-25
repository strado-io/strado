import { beforeEach, describe, expect, it } from 'vitest';
import { migrateEditorTabs, readFilesTabs } from './filesTabs';
import { readPaneLayouts } from './paneLayout';
import { readActiveTab, readTabOrder } from './tabOrder';

const leaf = (key: string) => ({ kind: 'leaf' as const, key });
const split = (a: unknown, b: unknown) => ({ kind: 'split' as const, dir: 'row' as const, ratio: 0.5, a, b });

describe('migrateEditorTabs (the removed VS Code embed)', () => {
  beforeEach(() => localStorage.clear());

  it('turns saved VS Code tabs into Files tabs: open list, active tab, order and split leaves', () => {
    localStorage.setItem('strado:vscode-tabs', JSON.stringify(['/a', '/b']));
    localStorage.setItem('strado.activeTab', JSON.stringify({ '/a': 'vscode:1', '/b': 'shell:1' }));
    localStorage.setItem('strado.tabOrder', JSON.stringify({ '/a': ['shell:1', 'vscode:1'], '/b': ['vscode:1', 'files:1'] }));
    localStorage.setItem('strado.paneLayout', JSON.stringify({
      '/a': [split(leaf('shell:1'), leaf('vscode:1'))],
      '/b': [split(split(leaf('shell:1'), leaf('vscode:1')), leaf('files:1'))],
    }));
    migrateEditorTabs();
    expect([...readFilesTabs()].sort()).toEqual(['/a', '/b']);
    expect(readActiveTab('/a')).toEqual({ mode: 'files', id: '1' });
    expect(readActiveTab('/b')).toEqual({ mode: 'shell', id: '1' });
    expect(readTabOrder('/a')).toEqual(['shell:1', 'files:1']);
    expect(readTabOrder('/b')).toEqual(['files:1']); // no duplicate
    expect(readPaneLayouts()['/a']).toEqual([split(leaf('shell:1'), leaf('files:1'))]);
    // /b already had a Files leaf: the VS Code one goes, its sibling takes its place.
    expect(readPaneLayouts()['/b']).toEqual([split(leaf('shell:1'), leaf('files:1'))]);
    expect(localStorage.getItem('strado:vscode-tabs')).toBeNull();
  });

  it('runs once, and survives junk', () => {
    localStorage.setItem('strado:vscode-tabs', '{not json');
    expect(() => migrateEditorTabs()).not.toThrow();
    localStorage.setItem('strado.activeTab', JSON.stringify({ '/a': 'vscode:1' }));
    migrateEditorTabs(); // no legacy key any more: nothing to do
    expect(readActiveTab('/a')).toBeNull(); // an unknown mode is simply not restored
  });
});
