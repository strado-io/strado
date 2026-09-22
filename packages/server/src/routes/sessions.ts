// System-wide view of the pty daemon's sessions (Settings → Sessions).
//
// Registered at root, not under /api/w/:ws: the daemon is per machine and
// outlives workspaces, repos and worktrees. That is exactly why this exists —
// sessions whose worktree was deleted, or that belong to another workspace,
// never show up in any worktree listing yet still hold a shell, an agent and
// memory. Kill is by manager key so those orphans can be ended too.
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { readManifest } from '../services/ptyDaemon/supervisor.js';
import { buildSessionMetrics, sampleProcesses, sessionKeyOf } from '../services/sessionMetrics.js';

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sessions/metrics', async () => {
    const live = app.deps.terminal.liveSessions();
    const procs = await sampleProcesses();
    return buildSessionMetrics({
      live,
      pidOf: (key) => app.deps.terminal.status(key).pid,
      procs,
      serverPid: process.pid,
      daemonPid: readManifest(app.deps.homeStateDir)?.pid ?? null,
    });
  });

  app.delete<{ Params: { key: string } }>('/api/sessions/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const live = app.deps.terminal.liveSessions().some((s) => sessionKeyOf(s) === key);
    if (!live) throw new AppError('NOT_FOUND', 'no live session with that key');
    app.deps.terminal.kill(key);
    return reply.code(204).send();
  });
}
