import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertPathUnder } from '../paths.js';
import { AppError } from '../errors.js';
import { sessionKeyFor } from '../services/terminalManager.js';

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

    // Turn diary (step 4b): extract this tab's turns from its transcript. Not
    // awaited — the hook must not wait on a parse — and never rejects.
    if (status !== 'closed') void app.deps.turnDiary.refresh('codex', cwd, sessionId ?? '1', status);

    // 'closed' means the agent process is gone, which is not the same as an
    // idle one: the session leaves the map so a Shell tab stops claiming it.
    if (status === 'closed') app.deps.codexStatus.remove(cwd, sessionId ?? '1');
    else app.deps.codexStatus.set(cwd, status, sessionId ?? '1');
    // Push delivery (step 5b): `waiting` is this harness's turn-complete — its
    // Stop. It both ends the idle period (a nudge-started turn never posts
    // `working` here, so the once-per-idle marker must clear now) and is the
    // moment to look at the inbox. A user-started turn (`working`) re-arms too.
    const key = sessionKeyFor('codex', cwd, sessionId ?? '1');
    const ex = app.deps.agents.byKey(key);
    if (ex) {
      if (status === 'working') app.deps.intercomPush.turnStarted(key);
      else if (status === 'waiting') {
        app.deps.intercomPush.turnStarted(key);
        void app.deps.intercomPush.consider(ex.scopeId, ex.agentId, 'stop');
      }
    }
    // Agent turn boundaries count as activity for the Time spent column.
    if (status !== 'closed') app.deps.activity.touch(cwd);
    return { ok: true };
  });
}
