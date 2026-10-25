// Code navigation for the Files tab (definition, references, hover, outline)
// and the machine-wide language-server settings. Navigation is read-only and
// runs the same on a runner, reached through /api/runners/:id/rpc; the
// settings POSTs are for this machine's own window only.
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import type { LspManager } from '../services/lsp/manager.js';
import { LSP_ADMIN_ROUTES, LSP_ROUTES, LSP_SERVERS, type LspServerId } from '../services/lsp/types.js';
import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { assertLocalHub } from './profile.js';

type Params = { encodedPath: string };

const PosQuery = z.object({
  path: z.string().min(1).max(4096),
  line: z.coerce.number().int().min(1).max(10_000_000),
  col: z.coerce.number().int().min(1).max(1_000_000),
});
const PathQuery = z.object({ path: z.string().min(1).max(4096) });
const IdParams = z.object({
  id: z.string().refine((id): id is LspServerId => LSP_SERVERS.some((s) => s.id === id), 'unknown language server'),
});
const EnabledBody = z.object({ enabled: z.boolean() });
/** Optional: stop only this worktree's instance. */
const StopBody = z.object({ worktreePath: z.string().min(1).max(4096) }).strict().nullish();

/** Per-worktree navigation: mounted under /api/w/:ws, like the Files routes. */
export async function registerLspRoutes(app: FastifyInstance, lsp: LspManager) {
  async function resolveTarget(req: any): Promise<string> {
    const { repos } = req.workspace!.stores;
    const target = decodeURIComponent(req.params.encodedPath);
    const repo = findOwningRepo(await repos.list(), target, app.deps.homeStateDir, { includeRepoRoot: true });
    if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
    assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
    return target;
  }

  app.get<{ Params: Params }>(LSP_ROUTES.definition, async (req) => {
    const q = PosQuery.parse(req.query);
    return lsp.definition(await resolveTarget(req), q.path, q.line, q.col);
  });

  app.get<{ Params: Params }>(LSP_ROUTES.references, async (req) => {
    const q = PosQuery.parse(req.query);
    return lsp.references(await resolveTarget(req), q.path, q.line, q.col);
  });

  app.get<{ Params: Params }>(LSP_ROUTES.hover, async (req) => {
    const q = PosQuery.parse(req.query);
    return lsp.hover(await resolveTarget(req), q.path, q.line, q.col);
  });

  app.get<{ Params: Params }>(LSP_ROUTES.outline, async (req) => {
    const { path } = PathQuery.parse(req.query);
    return lsp.outline(await resolveTarget(req), path);
  });
}

/** Settings › Files › Language servers. */
export async function registerLspAdminRoutes(app: FastifyInstance, lsp: LspManager) {
  app.get(LSP_ADMIN_ROUTES.servers, async () => ({ servers: await lsp.servers() }));

  app.post(LSP_ADMIN_ROUTES.setEnabled, async (req, reply) => {
    assertLocalHub(req.headers);
    const { id } = IdParams.parse(req.params);
    const { enabled } = EnabledBody.parse(req.body);
    await lsp.setEnabled(id as LspServerId, enabled);
    return reply.code(204).send();
  });

  app.post(LSP_ADMIN_ROUTES.stop, async (req, reply) => {
    assertLocalHub(req.headers);
    const { id } = IdParams.parse(req.params);
    const body = StopBody.parse(req.body);
    if (body) await lsp.stop(id as LspServerId, body.worktreePath);
    else await lsp.stop(id as LspServerId);
    return reply.code(204).send();
  });
}
