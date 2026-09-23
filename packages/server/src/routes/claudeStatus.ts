import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertPathUnder } from '../paths.js';
import { AppError } from '../errors.js';
import { sessionKeyFor } from '../services/terminalManager.js';

const Body = z.object({
  cwd: z.string().min(1),
  status: z.enum(['idle', 'working', 'waiting', 'closed']),
  // Which Claude tab this status belongs to (multi-session worktrees).
  // Absent for hooks spawned before multi-session — those are session 1.
  sessionId: z.string().regex(/^(?:\d+|shell:\d+)$/).optional(),
  providerSessionId: z.string().min(1).max(200).optional(),
  transcriptPath: z.string().min(1).max(4096).optional(),
});

export async function registerClaudeStatusRoutes(app: FastifyInstance) {
  app.post('/api/claude/status', async (req) => {
    const { cwd, status, sessionId, providerSessionId, transcriptPath } = Body.parse(req.body);

    const workspaces = await app.deps.workspaces.list();
    // NOTE: cwd is matched lexically (path.resolve via assertPathUnder), not via
    // fs.realpath. This assumes Claude's reported cwd is the same string the PTY
    // was launched with (the worktree path). If a worktree lives under a symlinked
    // root, a realpath-resolved cwd could fail this match and status would silently
    // not appear. Worktrees under the user's home dir are not symlinked in practice.
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
        mode: 'claude', worktreePath: cwd, sessionId: sessionId ?? '1', providerSessionId, transcriptPath,
      });
    }

    // Turn diary (step 4b): extract this tab's turns from its transcript. Not
    // awaited — the hook must not wait on a parse — and never rejects.
    if (status !== 'closed') void app.deps.turnDiary.refresh('claude', cwd, sessionId ?? '1', status);

    // 'closed' means the agent process is gone, which is not the same as an
    // idle one: the session leaves the map so a Shell tab stops claiming it.
    if (status === 'closed') app.deps.claudeStatus.remove(cwd, sessionId ?? '1');
    else app.deps.claudeStatus.set(cwd, status, sessionId ?? '1');
    // Push delivery (step 5): a Stop proves the tab is at its prompt, so queued
    // messages may be nudged in; a new turn clears the once-per-idle marker.
    const key = sessionKeyFor('claude', cwd, sessionId ?? '1');
    const ex = app.deps.agents.byKey(key);
    if (ex) {
      if (status === 'idle') void app.deps.intercomPush.consider(ex.scopeId, ex.agentId, 'stop');
      else if (status === 'working') app.deps.intercomPush.turnStarted(key);
    }
    // Agent turns count as activity even when the user isn't typing: the
    // prompt-submit and turn-complete hooks bracket the working period.
    if (status !== 'closed') app.deps.activity.touch(cwd);
    return { ok: true };
  });
}
