import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareLockfiles } from '../../src/lockfile';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lockfile-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('compareLockfiles', () => {
  it('returns equal=true when files match', async () => {
    const a = path.join(tmp, 'a.json');
    const b = path.join(tmp, 'b.json');
    await fs.writeFile(a, 'identical content');
    await fs.writeFile(b, 'identical content');
    const result = await compareLockfiles(a, b);
    expect(result.equal).toBe(true);
  });

  it('returns equal=false when files differ', async () => {
    const a = path.join(tmp, 'a.json');
    const b = path.join(tmp, 'b.json');
    await fs.writeFile(a, 'one');
    await fs.writeFile(b, 'two');
    const result = await compareLockfiles(a, b);
    expect(result.equal).toBe(false);
    expect(result.sourceHash).not.toBe(result.targetHash);
  });

  it('returns equal=true when both files are missing', async () => {
    const result = await compareLockfiles(
      path.join(tmp, 'missing-a.json'),
      path.join(tmp, 'missing-b.json'),
    );
    expect(result.equal).toBe(true);
  });

  it('returns equal=false when only one exists', async () => {
    const a = path.join(tmp, 'a.json');
    await fs.writeFile(a, 'one');
    const result = await compareLockfiles(a, path.join(tmp, 'missing.json'));
    expect(result.equal).toBe(false);
  });
});
