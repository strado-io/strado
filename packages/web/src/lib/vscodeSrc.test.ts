import { describe, expect, it } from 'vitest';
import { vscodeSrc } from './vscodeSrc';

describe('vscodeSrc', () => {
  it('no goto: just the folder (what the frame always loaded)', () => {
    expect(vscodeSrc('http://127.0.0.1:5000/', '/w/my app')).toBe('http://127.0.0.1:5000/?folder=%2Fw%2Fmy%20app');
  });

  it('a goto opens that file at that line on load, through the workbench payload', () => {
    const src = vscodeSrc('http://127.0.0.1:5000/', '/w/my app/', { path: 'src/a b.ts', line: 42 });
    const payload = JSON.parse(new URL(src).searchParams.get('payload')!);
    expect(new URL(src).searchParams.get('folder')).toBe('/w/my app/');
    expect(payload).toEqual([['openFile', 'vscode-remote://127.0.0.1:5000/w/my%20app/src/a%20b.ts:42'], ['gotoLineMode', 'true']]);
  });

  it('a base it cannot parse loses the goto, never the frame', () => {
    expect(vscodeSrc('', '/w/a', { path: 'x.ts', line: 1 })).toBe('?folder=%2Fw%2Fa');
    expect(vscodeSrc('not a url', '/w/a', { path: 'x.ts', line: 1 })).toBe('not a url?folder=%2Fw%2Fa');
  });
});
