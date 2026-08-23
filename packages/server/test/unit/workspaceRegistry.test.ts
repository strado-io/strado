import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceConfigStore } from '../../src/workspaceConfig.js';
import { createWorkspaceStoreRegistry } from '../../src/workspaceRegistry.js';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wsreg-'));
}

const DEFAULT = {
  id: 'default', name: 'Acme', color: '#3b82f6', icon: 'F',
  defaultEditor: 'code' as const, defaultPortBase: 8080, logDir: null,
};

describe('WorkspaceStoreRegistry', () => {
  let root: string;
  let workspacesFile: string;

  beforeEach(async () => {
    root = await tmpRoot();
    workspacesFile = path.join(root, 'workspaces.json');
  });

  it('returns stores for a known workspace and creates the dir on first write', async () => {
    const cfg = createWorkspaceConfigStore(workspacesFile);
    await cfg.add(DEFAULT);
    const reg = createWorkspaceStoreRegistry(cfg, root);
    const stores = await reg.get('default');
    expect(stores.repos).toBeDefined();
    expect(stores.state).toBeDefined();
    await stores.repos.add({
      id: 'r1', name: 'r1', path: '/x', projectSubdir: null,
      startCommand: 'echo', defaultPort: 8080, editor: 'code',
    });
    const stat = await fs.stat(path.join(root, 'workspaces', 'default'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('throws NOT_FOUND for unknown workspace', async () => {
    const cfg = createWorkspaceConfigStore(workspacesFile);
    await cfg.add(DEFAULT);
    const reg = createWorkspaceStoreRegistry(cfg, root);
    await expect(reg.get('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the same store instance on repeated get (cache hit)', async () => {
    const cfg = createWorkspaceConfigStore(workspacesFile);
    await cfg.add(DEFAULT);
    const reg = createWorkspaceStoreRegistry(cfg, root);
    const a = await reg.get('default');
    const b = await reg.get('default');
    expect(a.repos).toBe(b.repos);
    expect(a.state).toBe(b.state);
  });

  it('evict drops the cache entry', async () => {
    const cfg = createWorkspaceConfigStore(workspacesFile);
    await cfg.add(DEFAULT);
    const reg = createWorkspaceStoreRegistry(cfg, root);
    const a = await reg.get('default');
    reg.evict('default');
    const b = await reg.get('default');
    expect(a.repos).not.toBe(b.repos);
  });

  it('concurrent get(wsId) on cold cache returns the same store instance', async () => {
    const cfg = createWorkspaceConfigStore(workspacesFile);
    await cfg.add(DEFAULT);
    const reg = createWorkspaceStoreRegistry(cfg, root);
    const [a, b] = await Promise.all([reg.get('default'), reg.get('default')]);
    expect(a.repos).toBe(b.repos);
    expect(a.state).toBe(b.state);
  });

  it('writes to wsA do not show up under wsB on disk', async () => {
    const cfg = createWorkspaceConfigStore(workspacesFile);
    await cfg.add(DEFAULT);
    await cfg.add({ ...DEFAULT, id: 'strado', name: 'Strado' });
    const reg = createWorkspaceStoreRegistry(cfg, root);
    const a = await reg.get('default');
    const b = await reg.get('strado');
    await a.repos.add({
      id: 'r1', name: 'r1', path: '/x', projectSubdir: null,
      startCommand: 'echo', defaultPort: 8080, editor: 'code',
    });
    expect(await a.repos.list()).toHaveLength(1);
    expect(await b.repos.list()).toHaveLength(0);
    expect(await fs.readFile(path.join(root, 'workspaces', 'default', 'repos.json'), 'utf8'))
      .toContain('"r1"');
  });
});
