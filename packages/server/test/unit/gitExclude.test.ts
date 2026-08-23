import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { addGitExclude } from '../../src/services/gitExclude';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gitexcl-')));
  await exec('git', ['init', '-q', tmp]);
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('addGitExclude', () => {
  it('appends the pattern once (idempotent)', async () => {
    await addGitExclude(tmp, '.strado-uploads/');
    await addGitExclude(tmp, '.strado-uploads/');
    const content = await fs.readFile(path.join(tmp, '.git', 'info', 'exclude'), 'utf8');
    const hits = content.split('\n').filter((l) => l.trim() === '.strado-uploads/');
    expect(hits).toHaveLength(1);
  });

  it('does not throw outside a git repo', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'plain-'));
    await expect(addGitExclude(plain, '.x/')).resolves.toBeUndefined();
    await fs.rm(plain, { recursive: true, force: true });
  });
});
