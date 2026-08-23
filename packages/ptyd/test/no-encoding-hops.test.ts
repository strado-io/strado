import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('no encoding hops on the data path', () => {
  for (const file of ['server.ts', 'store.ts', 'protocol.ts']) {
    it(`${file} never base64s or utf8-decodes payload bytes`, () => {
      const text = fs.readFileSync(path.join(src, file), 'utf8');
      expect(text).not.toMatch(/base64/);
      // protocol.ts may decode the JSON *header*; payloads must stay Buffer.
      const dataPathDecodes = text
        .split('\n')
        .filter((l) => /payload.*toString\(|chunk.*toString\(/.test(l));
      expect(dataPathDecodes).toEqual([]);
    });
  }
});
