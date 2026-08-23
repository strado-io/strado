// Order in workspaces.json is the order the sidebar swipes through, so a
// reorder that loses or invents an id would quietly detach a workspace from
// its directory. These tests pin the guard.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceConfigStore, type Workspace } from './workspaceConfig.js';

let tmp: string;
let file: string;

const ws = (id: string, portBase: number): Workspace => ({
  id,
  name: id.toUpperCase(),
  color: '#334455',
  icon: id[0]!,
  defaultEditor: 'code',
  defaultPortBase: portBase,
  logDir: null,
});

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-reorder-'));
  file = path.join(tmp, 'workspaces.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      activeWorkspaceId: 'b',
      workspaces: [ws('a', 8080), ws('b', 8090), ws('c', 8100)],
    }),
  );
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const idsOnDisk = async () => {
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  return (raw.workspaces as Workspace[]).map((w) => w.id);
};

describe('workspaceConfig.reorder', () => {
  it('rewrites the array into the given order', async () => {
    const store = createWorkspaceConfigStore(file);
    const result = await store.reorder(['c', 'a', 'b']);
    expect(result.map((w) => w.id)).toEqual(['c', 'a', 'b']);
    expect(await idsOnDisk()).toEqual(['c', 'a', 'b']);
  });

  it('leaves the active workspace alone', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.reorder(['c', 'b', 'a']);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(raw.activeWorkspaceId).toBe('b');
  });

  it('keeps each workspace whole, not just its id', async () => {
    const store = createWorkspaceConfigStore(file);
    const result = await store.reorder(['b', 'c', 'a']);
    expect(result[0]).toMatchObject({ id: 'b', defaultPortBase: 8090, name: 'B' });
  });

  it.each([
    ['a missing id', ['a', 'b']],
    ['an unknown id', ['a', 'b', 'zz']],
    ['a duplicate id', ['a', 'a', 'b']],
    ['extra ids', ['a', 'b', 'c', 'c']],
  ])('rejects %s and leaves the file untouched', async (_label, ids) => {
    const store = createWorkspaceConfigStore(file);
    await expect(store.reorder(ids)).rejects.toThrow(/permutation/i);
    expect(await idsOnDisk()).toEqual(['a', 'b', 'c']);
  });
});
