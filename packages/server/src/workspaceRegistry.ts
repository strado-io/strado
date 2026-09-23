import path from 'node:path';
import { AppError } from './errors.js';
import { createRepoConfigStore, RepoConfigStore } from './repoConfig.js';
import { createStateStore, StateStore } from './state.js';
import { WorkspaceConfigStore } from './workspaceConfig.js';

export type WorkspaceStores = { repos: RepoConfigStore; state: StateStore };

export type WorkspaceStoreRegistry = {
  get(wsId: string): Promise<WorkspaceStores>;
  evict(wsId: string): void;
  rootDir: string;
  workspaceDir(wsId: string): string;
};

export function createWorkspaceStoreRegistry(
  workspaceConfig: WorkspaceConfigStore,
  rootDir: string,
): WorkspaceStoreRegistry {
  const cache = new Map<string, Promise<WorkspaceStores>>();

  function workspaceDir(wsId: string): string {
    return path.join(rootDir, 'workspaces', wsId);
  }

  return {
    rootDir,
    workspaceDir,
    get(wsId) {
      const hit = cache.get(wsId);
      if (hit) return hit;
      const p = (async () => {
        const ws = await workspaceConfig.get(wsId);
        if (!ws) throw new AppError('NOT_FOUND', `workspace ${wsId} not found`);
        const dir = workspaceDir(wsId);
        return {
          repos: createRepoConfigStore(path.join(dir, 'repos.json')),
          state: createStateStore(path.join(dir, 'state.json')),
        };
      })();
      cache.set(wsId, p);
      p.catch(() => cache.delete(wsId));   // keep failed lookups retryable
      return p;
    },
    evict(wsId) { cache.delete(wsId); },
  };
}
