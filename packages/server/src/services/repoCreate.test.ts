import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../shell.js';
import { createLocalRepo } from './repoCreate.js';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strado-repo-create-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('createLocalRepo', () => {
  it('creates a slugged folder and initializes it as a Git repository', async () => {
    const created = await createLocalRepo({ name: 'My Rust Service', parent: root });

    expect(created).toEqual({ path: path.join(root, 'my-rust-service'), alreadyPresent: false });
    expect((await fsp.stat(path.join(created.path, '.git'))).isDirectory()).toBe(true);
    const branch = await exec('git', ['branch', '--show-current'], { cwd: created.path });
    expect(branch.stdout.trim()).toBe('main');
  });

  it('returns an existing Git repository without modifying it', async () => {
    const target = path.join(root, 'existing');
    await fsp.mkdir(target);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: target });

    await expect(createLocalRepo({ name: 'Existing', parent: root })).resolves.toEqual({
      path: target,
      alreadyPresent: true,
    });
  });

  it('does not overwrite a non-empty folder that is not a Git repository', async () => {
    const target = path.join(root, 'existing');
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(target, 'keep.txt'), 'keep me');

    await expect(createLocalRepo({ name: 'Existing', parent: root })).rejects.toThrow('is not a git repository');
    await expect(fsp.readFile(path.join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep me');
  });
});
