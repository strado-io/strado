import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertPathUnder } from '../paths.js';
import { AppError } from '../errors.js';

const Body = z.object({
  path: z.string().min(1),
});

// Focus heartbeat from the web app: fired while a worktree-scoped view
// (terminal tab, embedded VS Code, diff view) is open in a focused window.
// Covers reading/reviewing time that produces no keystrokes or file saves.
export async function registerActivityRoutes(app: FastifyInstance) {
  // Same lexical-ownership check as /api/claude/status: only paths a
  // configured repo owns may be touched.
  async function assertOwned(target: string) {
    const workspaces = await app.deps.workspaces.list();
    for (const ws of workspaces) {
      const stores = await app.deps.registry.get(ws.id);
      const repos = await stores.repos.list();
      const repo = findOwningRepo(repos, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) continue;
      try {
        assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
        return;
      } catch {
        // keep searching other workspaces
      }
    }
    throw new AppError('NOT_FOUND', `no repo owns ${target}`);
  }

  app.post('/api/activity/beat', async (req) => {
    const { path: target } = Body.parse(req.body);
    await assertOwned(target);
    app.deps.activity.touch(target);
    return { ok: true };
  });

  // Zero a worktree's tracked time (memory + file), e.g. after a ticket is
  // re-scoped or a worktree gets reused for new work.
  app.delete<{ Params: { encodedPath: string } }>('/api/activity/:encodedPath', async (req, reply) => {
    const target = decodeURIComponent(req.params.encodedPath);
    await assertOwned(target);
    app.deps.activity.remove(target);
    await app.deps.activity.flush();
    app.deps.bus.emit('worktrees', { type: 'worktree.updated', data: { path: target, activitySeconds: 0 } });
    return reply.code(204).send();
  });
}
