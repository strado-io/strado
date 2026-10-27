import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDefinition } from './importDefinition.js';

let root: string;
const put = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
/** Ask at the first occurrence of `word` on `line` of `rel`. */
const at = async (rel: string, line: number, word: string, nth = 0) => {
  const text = (await import('node:fs')).readFileSync(path.join(root, rel), 'utf8').split('\n')[line - 1]!;
  let col = -1;
  for (let i = 0; i <= nth; i++) col = text.indexOf(word, col + 1);
  return importDefinition(root, path.join(root, rel), line, col + 1);
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'impdef-')));
  put('app/package.json', '{}');
  put('app/tsconfig.json', '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, }, }');
  put('app/src/utils/date.js', 'import x from "y";\n\nexport function getTime(a) {\n  return a;\n}\nexport const { useToken } = theme;\n');
  put('app/src/shared/Select.js', 'const a = 1;\nexport default (props) => {\n  return null;\n};\n');
  put('app/src/shared/Button.tsx', 'export default function Button() {\n  return null;\n}\n');
  put('app/src/shared/index.ts', "export { default as Select } from './Select';\nexport * from './more';\nexport { default as Button } from './Button';\n");
  put('app/src/shared/more.ts', 'export const PAGE = 10;\nexport class Store {}\n');
  put('app/src/main.tsx', [
    "import { getTime, useToken } from './utils/date';",
    "import { Select as Picker, PAGE, Store } from './shared';",
    "import Button from '@/shared/Button';",
    "import * as dates from './utils/date';",
    "import React from 'react';",
    'const local = () => 1;',
    'getTime(1); useToken(); Picker; PAGE; new Store(); Button; dates.getTime(2); local(); React;',
  ].join('\n'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('importDefinition', () => {
  it('follows a named import to its declaration', async () => {
    expect(await at('app/src/main.tsx', 7, 'getTime')).toEqual([
      { path: 'app/src/utils/date.js', line: 3, col: 17, preview: 'export function getTime(a) {' },
    ]);
  });

  it('finds a destructured export', async () => {
    expect((await at('app/src/main.tsx', 7, 'useToken'))?.[0]).toMatchObject({ path: 'app/src/utils/date.js', line: 6 });
  });

  it('follows a barrel: `export { default as X }` and `export *`, by the local alias too', async () => {
    expect((await at('app/src/main.tsx', 7, 'Picker'))?.[0]).toMatchObject({ path: 'app/src/shared/Select.js', line: 2 });
    // The cursor on the imported side of `Select as Picker` means Select.
    expect((await at('app/src/main.tsx', 2, 'Select'))?.[0]).toMatchObject({ path: 'app/src/shared/Select.js', line: 2 });
    expect((await at('app/src/main.tsx', 7, 'PAGE'))?.[0]).toMatchObject({ path: 'app/src/shared/more.ts', line: 1 });
    expect((await at('app/src/main.tsx', 7, 'Store'))?.[0]).toMatchObject({ path: 'app/src/shared/more.ts', line: 2 });
  });

  it('resolves a tsconfig paths alias, and a default export function', async () => {
    expect((await at('app/src/main.tsx', 7, 'Button'))?.[0]).toMatchObject({ path: 'app/src/shared/Button.tsx', line: 1, col: 25 });
  });

  it('follows ns.member through `import * as ns`', async () => {
    expect((await at('app/src/main.tsx', 7, 'getTime', 1))?.[0]).toMatchObject({ path: 'app/src/utils/date.js', line: 3 });
  });

  it('finds a declaration in the same file', async () => {
    expect((await at('app/src/main.tsx', 7, 'local'))?.[0]).toMatchObject({ path: 'app/src/main.tsx', line: 6 });
  });

  it('gives up (null) on a package import and on non-JS files', async () => {
    expect(await at('app/src/main.tsx', 7, 'React')).toBeNull();
    put('app/notes.md', 'getTime');
    expect(await importDefinition(root, path.join(root, 'app/notes.md'), 1, 1)).toBeNull();
  });
});
