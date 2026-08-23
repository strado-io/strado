import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupBeforeWrite } from '../../src/backups';

let tmp: string;
let file: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bak-'));
  file = path.join(tmp, 'state.json');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function backups(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(tmp, '.backups'))).sort();
  } catch {
    return [];
  }
}

describe('backupBeforeWrite', () => {
  it('copies the current file into .backups before a write', async () => {
    await fs.writeFile(file, '{"v":1}');
    await backupBeforeWrite(file);
    const b = await backups();
    expect(b).toHaveLength(1);
    expect(await fs.readFile(path.join(tmp, '.backups', b[0]!), 'utf8')).toBe('{"v":1}');
  });

  it('is a no-op when the file does not exist yet', async () => {
    await backupBeforeWrite(file);
    expect(await backups()).toHaveLength(0);
  });

  it('throttles: a second backup inside the interval is skipped', async () => {
    await fs.writeFile(file, '{"v":1}');
    await backupBeforeWrite(file);
    await fs.writeFile(file, '{"v":2}');
    await backupBeforeWrite(file);
    expect(await backups()).toHaveLength(1);
  });

  it('rotates: prunes oldest backups beyond keep', async () => {
    await fs.writeFile(file, '{"v":1}');
    for (let i = 0; i < 5; i++) {
      // minIntervalMs 0 lets every call take a backup; unique mtimes not needed
      await backupBeforeWrite(file, { keep: 3, minIntervalMs: 0 });
      await new Promise((r) => setTimeout(r, 2)); // distinct timestamps
    }
    expect((await backups()).length).toBeLessThanOrEqual(3);
  });

  it('never throws when the file is unreadable', async () => {
    await expect(backupBeforeWrite(path.join(tmp, 'nope', 'deep.json'))).resolves.toBeUndefined();
  });
});
