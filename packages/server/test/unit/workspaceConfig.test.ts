import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceConfigStore } from '../../src/workspaceConfig.js';
import { AppError } from '../../src/errors.js';

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wsconfig-'));
  return path.join(dir, 'workspaces.json');
}

const DEFAULT = {
  id: 'default',
  name: 'Acme',
  color: '#3b82f6',
  icon: 'F',
  defaultEditor: 'code' as const,
  defaultPortBase: 8080,
  logDir: null,
};

const STRADO = {
  id: 'strado',
  name: 'Strado',
  color: '#10b981',
  icon: 'S',
  defaultEditor: 'code' as const,
  defaultPortBase: 4000,
  logDir: null,
};

describe('WorkspaceConfigStore', () => {
  let file: string;
  beforeEach(async () => { file = await tmpFile(); });

  it('returns empty initial state when file missing', async () => {
    const store = createWorkspaceConfigStore(file);
    const result = await store.read();
    expect(result.workspaces).toEqual([]);
    expect(result.activeWorkspaceId).toBeNull();
  });

  it('adds a workspace and persists to disk', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add(DEFAULT);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(onDisk.workspaces).toHaveLength(1);
    expect(onDisk.activeWorkspaceId).toBe('default');
  });

  it('rejects duplicate id', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add(DEFAULT);
    await expect(store.add({ ...DEFAULT, name: 'Other' })).rejects.toBeInstanceOf(AppError);
  });

  it('rejects invalid id pattern', async () => {
    const store = createWorkspaceConfigStore(file);
    await expect(store.add({ ...DEFAULT, id: 'Has Space' })).rejects.toBeInstanceOf(AppError);
  });

  it('refuses to remove the last workspace', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add(DEFAULT);
    await expect(store.remove('default')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('picks a new active when active is removed', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add(DEFAULT);
    await store.add(STRADO);
    await store.setActive('strado');
    await store.remove('strado');
    expect(await store.getActive()).toMatchObject({ id: 'default' });
  });

  it('patches editable fields', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add(DEFAULT);
    const updated = await store.patch('default', { color: '#ff0000', icon: 'X' });
    expect(updated.color).toBe('#ff0000');
    expect(updated.icon).toBe('X');
  });

  it('forbids patching id', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add(DEFAULT);
    await expect(
      store.patch('default', { id: 'newid' } as unknown as Partial<typeof DEFAULT>),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('setActive on unknown id throws', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add(DEFAULT);
    await expect(store.setActive('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('aborts on corrupt file', async () => {
    await fs.writeFile(file, '{not json');
    const store = createWorkspaceConfigStore(file);
    await expect(store.read()).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('two sequential reads on missing file do not corrupt state', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.read();
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it('get returns null for unknown id', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add({ id: 'default', name: 'Acme', color: '#3b82f6', icon: 'F',
      defaultEditor: 'code', defaultPortBase: 8080, logDir: null });
    expect(await store.get('nope')).toBeNull();
  });

  it('patch on unknown id throws NOT_FOUND', async () => {
    const store = createWorkspaceConfigStore(file);
    await store.add({ id: 'default', name: 'Acme', color: '#3b82f6', icon: 'F',
      defaultEditor: 'code', defaultPortBase: 8080, logDir: null });
    await expect(store.patch('nope', { name: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
