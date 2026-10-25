// The Files tab: read-only GETs over one worktree. Nothing here writes. The
// same routes run on a runner's own server and are reached from the laptop
// through GET /api/runners/:id/rpc.
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { listFiles, readFile, readMarks, readTree } from '../services/files/files.js';
import { FILES_ROUTES } from '../services/files/types.js';
import { searchFiles } from '../services/files/search.js';
import { LSP_ROUTES } from '../services/lsp/types.js';
import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';

type Params = { encodedPath: string };

const TreeQuery = z.object({
  dir: z.string().max(4096).default(''),
  ignored: z.enum(['0', '1', 'true', 'false']).optional(),
});
const PathQuery = z.object({ path: z.string().min(1).max(4096) });
const flag = z.enum(['0', '1', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true');
const SearchQueryParams = z.object({
  q: z.string().min(1).max(1000),
  word: flag,
  case: flag,
  regex: flag,
  glob: z.string().min(1).max(300).optional(),
}).strict();

export async function registerFilesRoutes(app: FastifyInstance) {
  async function resolveTarget(req: any): Promise<string> {
    const { repos } = req.workspace!.stores;
    const target = decodeURIComponent(req.params.encodedPath);
    const repo = findOwningRepo(await repos.list(), target, app.deps.homeStateDir, { includeRepoRoot: true });
    if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
    assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
    return target;
  }

  app.get<{ Params: Params }>(FILES_ROUTES.tree, async (req) => {
    const q = TreeQuery.parse(req.query);
    return readTree(await resolveTarget(req), q.dir, q.ignored === '1' || q.ignored === 'true');
  });

  app.get<{ Params: Params }>(FILES_ROUTES.list, async (req) => {
    return listFiles(await resolveTarget(req));
  });

  app.get<{ Params: Params }>(FILES_ROUTES.read, async (req) => {
    const { path } = PathQuery.parse(req.query);
    return readFile(await resolveTarget(req), path);
  });

  app.get<{ Params: Params }>(FILES_ROUTES.marks, async (req) => {
    const { path } = PathQuery.parse(req.query);
    return readMarks(await resolveTarget(req), path);
  });

  // ⌘⇧F (and the fallback for code navigation): rg or git grep, capped.
  app.get<{ Params: Params }>(LSP_ROUTES.search, async (req, reply) => {
    const parsed = SearchQueryParams.safeParse(req.query);
    if (!parsed.success) throw new AppError('VALIDATION', 'bad search');
    const { q, word, case: caseSensitive, regex, glob } = parsed.data;
    // The person typed on (or left): a search nobody will read stops now.
    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
    return searchFiles(await resolveTarget(req), { q, word, case: caseSensitive, regex, ...(glob ? { glob } : {}) }, { signal: ac.signal });
  });
}
