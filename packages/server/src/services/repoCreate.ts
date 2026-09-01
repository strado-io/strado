import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import { exec } from '../shell.js';
import { defaultReposDir } from './repoClone.js';
import { slugify } from './repoDetect.js';

export async function createLocalRepo(opts: { name: string; parent?: string }): Promise<{ path: string; alreadyPresent: boolean }> {
  const folder = slugify(opts.name);
  if (!folder) throw new AppError('VALIDATION', 'Enter a project name with at least one letter or number');

  const rawParent = opts.parent?.trim() || defaultReposDir();
  const expandedParent = rawParent === '~'
    ? os.homedir()
    : rawParent.startsWith('~/') ? path.join(os.homedir(), rawParent.slice(2)) : rawParent;
  const parent = path.resolve(expandedParent);
  const target = path.join(parent, folder);

  const stat = await fsp.stat(target).catch(() => null);
  if (stat && !stat.isDirectory()) throw new AppError('VALIDATION', `${target} already exists and is not a directory`);
  if (stat) {
    const existing = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: target, timeoutMs: 5_000 }).catch(() => null);
    // macOS commonly reports /private/var/... for a target reached through
    // /var/..., so compare canonical paths before deciding it is not a repo.
    const existingRoot = existing?.stdout.trim();
    const canonicalTarget = await fsp.realpath(target);
    const canonicalExistingRoot = existingRoot ? await fsp.realpath(existingRoot).catch(() => existingRoot) : null;
    if (canonicalExistingRoot === canonicalTarget) return { path: target, alreadyPresent: true };
    if ((await fsp.readdir(target)).length > 0) {
      throw new AppError('VALIDATION', `${target} already exists and is not a git repository`);
    }
  }

  const createdDirectory = !stat;
  await fsp.mkdir(target, { recursive: true });
  try {
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: target, timeoutMs: 30_000 });
  } catch (error) {
    if (createdDirectory) await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { path: target, alreadyPresent: false };
}
