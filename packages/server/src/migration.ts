// packages/server/src/migration.ts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
export type MigrationOptions = {
  configDir: string;
  homeStateDir: string;
};

export type MigrationResult = {
  migrated: boolean;
  alreadyMigrated: boolean;
  reposMoved: number;
  worktreesMoved: number;
};

const DEFAULT_WS_ID = 'default';

type SeedWorkspace = {
  id: string;
  name: string;
  color: string;
  icon: string;
  defaultEditor: string;
  defaultPortBase: number;
  logDir: string | null;
};

function defaultWorkspace(logDir: string | null): SeedWorkspace {
  return {
    id: DEFAULT_WS_ID,
    name: 'Personal',
    color: '#f97f1b',
    icon: 'P',
    defaultEditor: 'code',
    defaultPortBase: 8080,
    logDir,
  };
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function copyIfExists(src: string, dst: string): Promise<void> {
  if (!fs.existsSync(src)) return;
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

// A missing workspaces.json must never orphan data that already lives under
// config/workspaces/<id>/ — regenerate a registry entry for every such dir.
async function existingWorkspaceEntries(configDir: string): Promise<SeedWorkspace[]> {
  const wsRoot = path.join(configDir, 'workspaces');
  if (!fs.existsSync(wsRoot)) return [];
  const dirs = (await fsp.readdir(wsRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name !== DEFAULT_WS_ID && /^[a-z0-9-]+$/.test(d.name))
    .map((d) => d.name);
  return dirs.map((id) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    color: '#10b981',
    icon: id.charAt(0).toUpperCase(),
    defaultEditor: 'code',
    defaultPortBase: 8080,
    logDir: null,
  }));
}

export async function runMigration(opts: MigrationOptions): Promise<MigrationResult> {
  const workspacesFile = path.join(opts.configDir, 'workspaces.json');
  const legacyRepos = path.join(opts.configDir, 'repos.json');
  const legacyState = path.join(opts.homeStateDir, 'state.json');
  const targetDir = path.join(opts.configDir, 'workspaces', DEFAULT_WS_ID);
  const targetRepos = path.join(targetDir, 'repos.json');
  const targetState = path.join(targetDir, 'state.json');

  const hasWorkspacesFile = fs.existsSync(workspacesFile);
  const hasLegacy = fs.existsSync(legacyRepos) || fs.existsSync(legacyState);

  if (hasWorkspacesFile) {
    return { migrated: false, alreadyMigrated: true, reposMoved: 0, worktreesMoved: 0 };
  }

  if (!hasLegacy) {
    // Fresh install
    await fsp.mkdir(targetDir, { recursive: true });
    if (!fs.existsSync(targetRepos)) {
      await atomicWriteJson(targetRepos, { repos: [] });
    }
    if (!fs.existsSync(targetState)) {
      await atomicWriteJson(targetState, { worktrees: {} });
    }
    const ws = defaultWorkspace(null);
    const preserved = await existingWorkspaceEntries(opts.configDir);
    await atomicWriteJson(workspacesFile, { activeWorkspaceId: DEFAULT_WS_ID, workspaces: [ws, ...preserved] });
    return { migrated: false, alreadyMigrated: false, reposMoved: 0, worktreesMoved: 0 };
  }

  // Legacy → migrate
  if (fs.existsSync(legacyRepos)) {
    await fsp.copyFile(legacyRepos, `${legacyRepos}.pre-workspace-bak`);
  }
  if (fs.existsSync(legacyState)) {
    await fsp.copyFile(legacyState, `${legacyState}.pre-workspace-bak`);
  }
  await fsp.mkdir(targetDir, { recursive: true });
  await copyIfExists(legacyRepos, targetRepos);
  await copyIfExists(legacyState, targetState);
  if (!fs.existsSync(targetRepos)) {
    await atomicWriteJson(targetRepos, { repos: [] });
  }
  if (!fs.existsSync(targetState)) {
    await atomicWriteJson(targetState, { worktrees: {} });
  }
  const legacyLogsDir = path.join(opts.homeStateDir, 'logs');
  const ws = defaultWorkspace(legacyLogsDir);
  const preserved = await existingWorkspaceEntries(opts.configDir);
  await atomicWriteJson(workspacesFile, { activeWorkspaceId: DEFAULT_WS_ID, workspaces: [ws, ...preserved] });
  if (fs.existsSync(legacyRepos)) await fsp.unlink(legacyRepos);
  if (fs.existsSync(legacyState)) await fsp.unlink(legacyState);

  const repos = await readJsonOr<{ repos: unknown[] }>(targetRepos, { repos: [] });
  const state = await readJsonOr<{ worktrees: Record<string, unknown> }>(targetState, { worktrees: {} });
  const reposMoved = Array.isArray(repos.repos) ? repos.repos.length : 0;
  const worktreesMoved = state.worktrees ? Object.keys(state.worktrees).length : 0;

  // eslint-disable-next-line no-console
  console.log(`migrated legacy config → workspace 'default' (${reposMoved} repos, ${worktreesMoved} worktrees)`);

  return { migrated: true, alreadyMigrated: false, reposMoved, worktreesMoved };
}
