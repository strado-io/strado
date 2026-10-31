import { beforeEach, describe, expect, it } from 'vitest';
import { clampFloat, nextFloatBox, readPaneFloats, rememberPaneFloats } from './paneFloats';

describe('paneFloats', () => {
  beforeEach(() => localStorage.clear());

  it('remembers floats per worktree and forgets an emptied one', () => {
    rememberPaneFloats('/w/a', [{ key: 'shell:2', x: 0.4, y: 0.1, w: 0.5, h: 0.6 }]);
    expect(readPaneFloats()['/w/a']).toEqual([{ key: 'shell:2', x: 0.4, y: 0.1, w: 0.5, h: 0.6 }]);
    rememberPaneFloats('/w/a', []);
    expect(readPaneFloats()['/w/a']).toBeUndefined();
  });

  it('keeps a float inside the area', () => {
    expect(clampFloat({ key: 'k', x: 0.9, y: -0.2, w: 0.5, h: 0.5 })).toEqual({ key: 'k', x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(clampFloat({ key: 'k', x: 0, y: 0, w: 0.01, h: 3 })).toMatchObject({ w: 0.15, h: 1 });
  });

  it('staggers each new float so they never stack exactly', () => {
    const first = nextFloatBox('a', []);
    const second = nextFloatBox('b', [first]);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);
  });

  it('ignores junk in storage', () => {
    localStorage.setItem('strado:pane-floats', JSON.stringify({ '/w': [{ key: 1 }, null, { key: 'ok', x: 0, y: 0, w: 0.5, h: 0.5 }] }));
    expect(readPaneFloats()['/w']).toEqual([{ key: 'ok', x: 0, y: 0, w: 0.5, h: 0.5 }]);
  });
});
