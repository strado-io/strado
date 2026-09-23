import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirDriver } from './dir.js';
import { AppError } from '../../../errors.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'skills-'));
  await mkdir(path.join(root, 'superset'), { recursive: true });
  await writeFile(path.join(root, 'superset', 'SKILL.md'), '# superset\n');
  await mkdir(path.join(root, 'stray'), { recursive: true });
  return root;
}

describe('dirDriver', () => {
  it('lists directories and flags which carry a SKILL.md', async () => {
    const root = await fixture();
    const entries = await dirDriver.list(root);
    expect(entries).toEqual([
      { name: 'stray', hasSkillMd: false },
      { name: 'superset', hasSkillMd: true },
    ]);
  });

  it('returns an empty list when the directory does not exist', async () => {
    expect(await dirDriver.list('/nope/does/not/exist')).toEqual([]);
  });

  it('ignores the .backups directory', async () => {
    const root = await fixture();
    await mkdir(path.join(root, '.backups'), { recursive: true });
    const names = (await dirDriver.list(root)).map((e) => e.name);
    expect(names).not.toContain('.backups');
  });

  it('moves a removed skill into .backups instead of deleting it', async () => {
    const root = await fixture();
    const originalContent = await readFile(path.join(root, 'superset', 'SKILL.md'));
    await dirDriver.remove(root, 'superset');
    expect((await dirDriver.list(root)).map((e) => e.name)).toEqual(['stray']);
    const backups = await readdir(path.join(root, '.backups'));
    const backupName = backups.find((f) => f.startsWith('superset.'));
    expect(backupName).toBeDefined();
    const backupPath = path.join(root, '.backups', backupName!);
    const backupStat = await stat(backupPath);
    expect(backupStat.isDirectory()).toBe(true);
    const backupContent = await readFile(path.join(backupPath, 'SKILL.md'));
    expect(backupContent).toEqual(originalContent);
  });

  it('rejects empty string as a skill name', async () => {
    const root = await fixture();
    await expect(dirDriver.remove(root, '')).rejects.toThrow(/invalid skill name/);
  });

  it('rejects . as a skill name', async () => {
    const root = await fixture();
    await expect(dirDriver.remove(root, '.')).rejects.toThrow(/invalid skill name/);
  });

  it('rejects .. as a skill name', async () => {
    const root = await fixture();
    await expect(dirDriver.remove(root, '..')).rejects.toThrow(/invalid skill name/);
  });

  it('rejects a name containing forward slash', async () => {
    const root = await fixture();
    await expect(dirDriver.remove(root, '../escape')).rejects.toThrow(/invalid skill name/);
  });

  it('rejects a name containing backslash', async () => {
    const root = await fixture();
    await expect(dirDriver.remove(root, 'a\\b')).rejects.toThrow(/invalid skill name/);
  });

  it('rejects .backups as a skill name', async () => {
    const root = await fixture();
    await expect(dirDriver.remove(root, '.backups')).rejects.toThrow(/invalid skill name/);
  });

  it('rejects removal of a nonexistent skill with AppError', async () => {
    const root = await fixture();
    await expect(dirDriver.remove(root, 'nonexistent')).rejects.toThrow(AppError);
  });
});
