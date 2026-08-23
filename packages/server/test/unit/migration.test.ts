import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMigration } from '../../src/migration.js';

async function tmpRoot(): Promise<{ configDir: string; homeStateDir: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  return {
    configDir: path.join(base, 'config'),
    homeStateDir: path.join(base, 'home'),
  };
}

describe('runMigration', () => {
  let configDir: string;
  let homeStateDir: string;

  beforeEach(async () => {
    ({ configDir, homeStateDir } = await tmpRoot());
  });

  it('fresh install creates default workspace structure', async () => {
    const result = await runMigration({ configDir, homeStateDir });
    expect(result.migrated).toBe(false);
    const wsFile = JSON.parse(await fs.readFile(path.join(configDir, 'workspaces.json'), 'utf8'));
    expect(wsFile.workspaces).toHaveLength(1);
    expect(wsFile.workspaces[0].id).toBe('default');
    expect(wsFile.activeWorkspaceId).toBe('default');
    const repos = JSON.parse(
      await fs.readFile(path.join(configDir, 'workspaces', 'default', 'repos.json'), 'utf8'),
    );
    expect(repos).toEqual({ repos: [] });
    const state = JSON.parse(
      await fs.readFile(path.join(configDir, 'workspaces', 'default', 'state.json'), 'utf8'),
    );
    expect(state).toEqual({ worktrees: {} });
  });

  it('legacy files migrate into default workspace', async () => {
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(homeStateDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'repos.json'),
      JSON.stringify({ repos: [{
        id: 'r', name: 'r', path: '/p', projectSubdir: null,
        startCommand: 'echo', defaultPort: 8080, editor: 'code',
      }] }),
    );
    await fs.writeFile(
      path.join(homeStateDir, 'state.json'),
      JSON.stringify({ worktrees: { '/x': { repoId: 'r', ticketId: 't', title: 't', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null } } }),
    );

    const result = await runMigration({ configDir, homeStateDir });
    expect(result.migrated).toBe(true);
    expect(result.reposMoved).toBe(1);
    expect(result.worktreesMoved).toBe(1);

    // legacy files deleted
    await expect(fs.access(path.join(configDir, 'repos.json'))).rejects.toBeTruthy();
    await expect(fs.access(path.join(homeStateDir, 'state.json'))).rejects.toBeTruthy();
    // backups present
    await fs.access(path.join(configDir, 'repos.json.pre-workspace-bak'));
    await fs.access(path.join(homeStateDir, 'state.json.pre-workspace-bak'));
    // new files present with content
    const repos = JSON.parse(
      await fs.readFile(path.join(configDir, 'workspaces', 'default', 'repos.json'), 'utf8'),
    );
    expect(repos.repos).toHaveLength(1);
    const state = JSON.parse(
      await fs.readFile(path.join(configDir, 'workspaces', 'default', 'state.json'), 'utf8'),
    );
    expect(Object.keys(state.worktrees)).toEqual(['/x']);

    // default workspace logDir set to legacy logs path
    const wsFile = JSON.parse(await fs.readFile(path.join(configDir, 'workspaces.json'), 'utf8'));
    expect(wsFile.workspaces[0].logDir).toBe(path.join(homeStateDir, 'logs'));
  });

  it('is idempotent — second run is a no-op', async () => {
    await runMigration({ configDir, homeStateDir });
    const before = await fs.readFile(path.join(configDir, 'workspaces.json'), 'utf8');
    const result = await runMigration({ configDir, homeStateDir });
    expect(result.migrated).toBe(false);
    expect(result.alreadyMigrated).toBe(true);
    const after = await fs.readFile(path.join(configDir, 'workspaces.json'), 'utf8');
    expect(after).toBe(before);
  });

  it('completes partial migration on next run (no workspaces.json yet)', async () => {
    await fs.mkdir(path.join(configDir, 'workspaces', 'default'), { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'workspaces', 'default', 'repos.json'),
      JSON.stringify({ repos: [] }),
    );
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'repos.json'), JSON.stringify({ repos: [] }));

    const result = await runMigration({ configDir, homeStateDir });
    expect(result.migrated).toBe(true);
    await fs.access(path.join(configDir, 'workspaces.json'));
    await expect(fs.access(path.join(configDir, 'repos.json'))).rejects.toBeTruthy();
  });

  it('regenerating a missing workspaces.json preserves existing workspace dirs', async () => {
    // strado data exists on disk but the registry file is gone — the rebuilt
    // registry must include an entry for it, not orphan the data.
    await fs.mkdir(path.join(configDir, 'workspaces', 'strado'), { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'workspaces', 'strado', 'repos.json'),
      JSON.stringify({ repos: [] }),
    );

    const result = await runMigration({ configDir, homeStateDir });
    expect(result.alreadyMigrated).toBe(false);
    const wsFile = JSON.parse(await fs.readFile(path.join(configDir, 'workspaces.json'), 'utf8'));
    const ids = wsFile.workspaces.map((w: { id: string }) => w.id);
    expect(ids).toContain('default');
    expect(ids).toContain('strado');
    expect(wsFile.activeWorkspaceId).toBe('default');
  });

  it('does not leave a .tmp file behind after a successful fresh install', async () => {
    await runMigration({ configDir, homeStateDir });
    const entries = await fs.readdir(configDir);
    const tmpFiles = entries.filter((n) => n.includes('.tmp'));
    expect(tmpFiles).toEqual([]);
  });
});
