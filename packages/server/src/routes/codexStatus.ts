import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertPathUnder } from '../paths.js';
import { AppError } from '../errors.js';

const Body = z.object({
  cwd: z.string().min(1),
  status: z.enum(['idle', 'working', 'waiting', 'closed']),
  // Which Codex tab this status belongs to (multi-session worktrees).
  sessionId: z.string().regex(/^(?:\d+|shell:\d+)$/).optional(),
  providerSessionId: z.string().min(1).max(200).optional(),
});

export async function registerCodexStatusRoutes(app: FastifyInstance) {
  app.post('/api/codex/status', async (req) => {
    const { cwd, status, sessionId, providerSessionId } = Body.parse(req.body);

    // Same lexical-ownership check as /api/claude/status: cwd must be a repo
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

    if (providerSessionId) {
      await app.deps.agentSessions.set({
        mode: 'codex', worktreePath: cwd, sessionId: sessionId ?? '1', providerSessionId,
      });
    }

    // 'closed' means the agent process is gone, which is not the same as an
    // idle one: the session leaves the map so a Shell tab stops claiming it.
    if (status === 'closed') app.deps.codexStatus.remove(cwd, sessionId ?? '1');
    else app.deps.codexStatus.set(cwd, status, sessionId ?? '1');
    // Agent turn boundaries count as activity for the Time spent column.
    if (status !== 'closed') app.deps.activity.touch(cwd);
    return { ok: true };
  });
}
