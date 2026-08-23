import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepoConfigStore, RepoConfig } from '../../src/repoConfig';
import { AppError } from '../../src/errors';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'repos-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeRepo(id: string): RepoConfig {
  return {
    id,
    name: id,
    path: tmp,
    projectSubdir: null,
    startCommand: 'npm start',
    defaultPort: 8080,
    editor: 'code',
  };
}

describe('repo config store', () => {
  it('returns empty list when file missing', async () => {
    const store = createRepoConfigStore(path.join(tmp, 'repos.json'));
    expect(await store.list()).toEqual([]);
  });

  it('rejects unsupported editor', () => {
    const store = createRepoConfigStore(path.join(tmp, 'repos.json'));
    return expect(
      store.add({ ...makeRepo('x'), editor: 'evil-thing' as never }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('persists and reads a repo', async () => {
    const store = createRepoConfigStore(path.join(tmp, 'repos.json'));
    await store.add(makeRepo('react-app'));
    expect(await store.list()).toHaveLength(1);
  });

  it('updates fields via patch', async () => {
    const store = createRepoConfigStore(path.join(tmp, 'repos.json'));
    await store.add(makeRepo('react-app'));
    await store.patch('react-app', { defaultPort: 9000 });
    const [updated] = await store.list();
    expect(updated.defaultPort).toBe(9000);
  });

  it('strips a legacy worktreesDir key on read and rewrites the file', async () => {
    const filePath = path.join(tmp, 'repos.json');
    const legacy = { ...makeRepo('react-app'), worktreesDir: path.join(tmp, '.worktrees') };
    await fs.writeFile(filePath, JSON.stringify({ repos: [legacy] }, null, 2));

    const store = createRepoConfigStore(filePath);
    const [repo] = await store.list();
    expect(repo).not.toHaveProperty('worktreesDir');

    const rewritten = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(rewritten.repos).toHaveLength(1);
    expect(rewritten.repos[0]).not.toHaveProperty('worktreesDir');
    expect(rewritten.repos[0].id).toBe('react-app');
  });
});
