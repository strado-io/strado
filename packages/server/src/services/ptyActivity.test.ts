import { describe, expect, it } from 'vitest';
import { createPtyActivity } from './ptyActivity.js';

describe('ptyActivity', () => {
  it('reports Infinity for keys never seen and ms since the last note otherwise', () => {
    let t = 1000;
    const a = createPtyActivity(() => t);
    expect(a.quiet('k')).toEqual({ input: Infinity, output: Infinity });
    a.noteInput('k');
    t = 1500;
    a.noteOutput('k');
    t = 2200;
    expect(a.quiet('k')).toEqual({ input: 1200, output: 700 });
    expect(a.quiet('other')).toEqual({ input: Infinity, output: Infinity });
  });

  it('forget resets both clocks for one key only', () => {
    let t = 0;
    const a = createPtyActivity(() => t);
    a.noteInput('a'); a.noteOutput('a'); a.noteInput('b');
    a.forget('a');
    t = 10;
    expect(a.quiet('a')).toEqual({ input: Infinity, output: Infinity });
    expect(a.quiet('b')).toEqual({ input: 10, output: Infinity });
  });
});
