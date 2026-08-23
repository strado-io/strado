import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertPathUnder } from '../paths.js';
import { AppError } from '../errors.js';

const Body = z.object({
  cwd: z.string().min(1),
  status: z.enum(['idle', 'working', 'waiting']),
  // Which OpenCode tab this status belongs to (multi-session worktrees).
  sessionId: z.string().regex(/^\d+$/).optional(),
});

export async function registerOpencodeStatusRoutes(app: FastifyInstance) {
  app.post('/api/opencode/status', async (req) => {
    const { cwd, status, sessionId } = Body.parse(req.body);

    // Same lexical-ownership check as /api/codex/status: cwd must be a repo
    // root or live under a repo's worktrees dir in some workspace.
    const workspaces = await app.deps.workspaces.list();
    let owned = false;
    for (const ws of workspaces) {
      const stores = await app.deps.registry.get(ws.id);
      const repos = await stores.repos.list();
      const repo = findOwningRepo(repos, cwd, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) continue;
      try {
        assertPathUnder(cwd, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
        owned = true;
        break;
      } catch {
        // keep searching other workspaces
      }
    }
    if (!owned) throw new AppError('NOT_FOUND', `no repo owns ${cwd}`);

    app.deps.opencodeStatus.set(cwd, status, sessionId ?? '1');
    // Agent turn boundaries count as activity for the Time spent column.
    app.deps.activity.touch(cwd);
    return { ok: true };
  });
}
