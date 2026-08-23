import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { detectNodeModules } from '../services/nodeModulesStatus.js';
import type { WorkspaceStores } from '../workspaceRegistry.js';

const LinkBody = z.object({
  sourceWorktree: z.string().min(1),
  replace: z.boolean().optional(),
});

const RelinkBody = z.object({
  sourceWorktree: z.string().min(1),
});

async function resolveProjectDir(
  stores: WorkspaceStores,
  target: string,
  homeStateDir: string,
): Promise<{ projectDir: string; repoId: string; projectSubdir: string | null }> {
  const repos = await stores.repos.list();
  const repo = findOwningRepo(repos, target, homeStateDir, { includeRepoRoot: true });
  if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
  assertPathUnder(target, [repo.path, ...worktreeRootsFor(homeStateDir, repo)]);
  const projectDir = repo.projectSubdir ? path.join(target, repo.projectSubdir) : target;
  return { projectDir, repoId: repo.id, projectSubdir: repo.projectSubdir };
}

async function emitNodeModulesUpdate(
  app: FastifyInstance,
  target: string,
  projectSubdir: string | null,
) {
  const nodeModules = await detectNodeModules(target, projectSubdir);
  app.deps.bus.emit('worktrees', {
    type: 'worktree.updated',
    data: { path: target, nodeModules },
  });
}

export async function registerLinkingRoutes(app: FastifyInstance) {
  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/link',
    async (req) => {
      const stores = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const body = LinkBody.parse(req.body);
      const { projectDir, projectSubdir } = await resolveProjectDir(stores, target, app.deps.homeStateDir);
      const source = await resolveProjectDir(stores, body.sourceWorktree, app.deps.homeStateDir);
      const result = await app.deps.link.link({
        sourceProjectDir: source.projectDir,
        targetProjectDir: projectDir,
        replace: body.replace ?? false,
      });
      await stores.state
        .patch(target, { linkedFrom: body.sourceWorktree, linkedAt: new Date().toISOString() })
        .catch(() => undefined);
      await emitNodeModulesUpdate(app, target, projectSubdir);
      return result;
    },
  );

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/unlink',
    async (req, reply) => {
      const stores = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const { projectDir, projectSubdir } = await resolveProjectDir(stores, target, app.deps.homeStateDir);
      await app.deps.link.unlink(projectDir);
      await stores.state.patch(target, { linkedFrom: null, linkedAt: null }).catch(() => undefined);
      await emitNodeModulesUpdate(app, target, projectSubdir);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/relink',
    async (req) => {
      const stores = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const body = RelinkBody.parse(req.body);
      const { projectDir, projectSubdir } = await resolveProjectDir(stores, target, app.deps.homeStateDir);
      const source = await resolveProjectDir(stores, body.sourceWorktree, app.deps.homeStateDir);
      const result = await app.deps.link.relink({
        sourceProjectDir: source.projectDir,
        targetProjectDir: projectDir,
        replace: true,
      });
      await stores.state
        .patch(target, { linkedFrom: body.sourceWorktree, linkedAt: new Date().toISOString() })
        .catch(() => undefined);
      await emitNodeModulesUpdate(app, target, projectSubdir);
      return result;
    },
  );
}
