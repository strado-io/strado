import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../../errors.js';

export type DirEntry = { name: string; hasSkillMd: boolean };

const BACKUPS = '.backups';

function assertSimpleName(name: unknown): void {
  if (typeof name !== 'string') {
    throw new AppError('VALIDATION', `skill name must be a string`);
  }
  if (name === '' || name.includes('/') || name.includes('\\') || name === '..' || name === '.' || name === BACKUPS) {
    throw new AppError('VALIDATION', `invalid skill name "${name}"`);
  }
}

export const dirDriver = {
  async list(dir: string): Promise<DirEntry[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DirEntry[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name === BACKUPS) continue;
      const hasSkillMd = await fsp
        .stat(path.join(dir, e.name, 'SKILL.md'))
        .then(() => true)
        .catch(() => false);
      out.push({ name: e.name, hasSkillMd });
    }
    return out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  },

  async remove(dir: string, name: string): Promise<void> {
    assertSimpleName(name);
    const src = path.join(dir, name);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, BACKUPS, `${name}.${stamp}`);
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(src, dest);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new AppError('NOT_FOUND', `skill "${name}" not found`);
      }
      throw new AppError('VALIDATION', `failed to remove skill "${name}"`);
    }
  },
};
