import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { quickOutline } from './quickOutline.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'qo-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, text: string) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };

describe('quickOutline', () => {
  it('top-level declarations, kinds by keyword (a const holding a function is a func), a class with its methods', async () => {
    const p = file('a.ts', [
      "import x from 'y';",
      'export const LIMIT = 10;',
      'export const load = async (id: string) => {',
      '  if (id) {',
      '  }',
      '};',
      'export default function App() {}',
      'type Props = { a: number };',
      'export interface Store {}',
      'enum Mode { A }',
      'export class Cache extends Base {',
      '  constructor(a) {',
      '  }',
      '  async get(key: string): Promise<string> {',
      '    for (const k of keys) {',
      '    }',
      '  }',
      '  clear = () => {};',
      '}',
      'let count = 0;',
    ].join('\n'));
    expect(await quickOutline(p)).toEqual([
      { name: 'LIMIT', kind: 'const', line: 2, col: 14 },
      { name: 'load', kind: 'func', line: 3, col: 14 },
      { name: 'App', kind: 'func', line: 7, col: 25 },
      { name: 'Props', kind: 'type', line: 8, col: 6 },
      { name: 'Store', kind: 'interface', line: 9, col: 18 },
      { name: 'Mode', kind: 'enum', line: 10, col: 6 },
      { name: 'Cache', kind: 'class', line: 11, col: 14, children: [
        { name: 'constructor', kind: 'constructor', line: 12, col: 3 },
        { name: 'get', kind: 'method', line: 14, col: 9 },
        { name: 'clear', kind: 'method', line: 18, col: 3 },
      ] },
      { name: 'count', kind: 'var', line: 20, col: 5 },
    ]);
  });

  it('not JS/TS: null', async () => {
    expect(await quickOutline(file('b.py', 'def f():\n  pass\n'))).toBeNull();
  });
});
