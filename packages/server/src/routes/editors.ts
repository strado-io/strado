// Open in editor: the person's own desktop editor, launched on this machine.
// The list is machine-wide; opening is per workspace, so the worktree can be
// checked against the repos this server owns. Both POSTs answer only this
// machine's own window: a relayed request (a runner reached over rpc) is
// refused, and a runner worktree has no local editor anyway.
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import type { Editors } from '../services/editors/open.js';
import { EDITOR_ROUTES, EDITORS, type EditorId } from '../services/editors/types.js';
import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { assertLocalHub } from './profile.js';

const EditorIdSchema = z.enum(EDITORS.map((e) => e.id) as [EditorId, ...EditorId[]]);
const PreferredBody = z.object({ editor: EditorIdSchema.nullable() }).strict();
const OpenBody = z
  .object({
    worktreePath: z.string().min(1).max(4096),
    path: z.string().min(1).max(4096).optional(),
    line: z.number().int().min(1).max(10_000_000).optional(),
    col: z.number().int().min(1).max(1_000_000).optional(),
    editor: EditorIdSchema.optional(),
  })
  .strict()
  .refine((b) => b.path !== undefined || (b.line === undefined && b.col === undefined), 'a line needs a path')
  .refine((b) => b.line !== undefined || b.col === undefined, 'a column needs a line');

/** Machine-wide: GET the list, POST the preferred one. */
export async function registerEditorAdminRoutes(app: FastifyInstance, editors: Editors) {
  app.get(EDITOR_ROUTES.list, async () => editors.list());

  app.post(EDITOR_ROUTES.setPreferred, async (req, reply) => {
    assertLocalHub(req.headers);
    const { editor } = PreferredBody.parse(req.body);
    await editors.setPreferred(editor);
    return reply.code(204).send();
  });
}

/** Mounted under /api/w/:ws (EDITOR_ROUTES.open without that prefix). */
export async function registerOpenInEditorRoute(app: FastifyInstance, editors: Editors) {
  app.post('/open-in-editor', async (req: any, reply) => {
    assertLocalHub(req.headers);
    const body = OpenBody.parse(req.body);
    const { repos } = req.workspace!.stores;
    const repo = findOwningRepo(await repos.list(), body.worktreePath, app.deps.homeStateDir, { includeRepoRoot: true });
    if (!repo) throw new AppError('NOT_FOUND', 'no repo owns that worktree');
    assertPathUnder(body.worktreePath, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
    await editors.open(body);
    return reply.code(204).send();
  });
}
