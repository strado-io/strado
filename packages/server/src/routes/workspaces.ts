import { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { WorkspaceSchema } from '../workspaceConfig.js';
import { AppError } from '../errors.js';
import { findOwningRepo } from '../services/worktreeRoot.js';

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.get('/api/workspaces', async () => {
    const workspaces = await app.deps.workspaces.list();
    const active = await app.deps.workspaces.getActive();
    return { activeWorkspaceId: active?.id ?? null, workspaces };
  });

  app.post('/api/workspaces', async (req, reply) => {
    let parsed;
    try { parsed = WorkspaceSchema.parse(req.body); }
    catch (err) {
      if (err instanceof z.ZodError) throw new AppError('VALIDATION', err.message, err.issues);
      throw err;
    }
    const dir = app.deps.registry.workspaceDir(parsed.id);
    // refuse if dir already exists from a stale prior workspace
    let exists = false;
    try { await fsp.access(dir); exists = true; } catch { /* not present, good */ }
    if (exists) throw new AppError('VALIDATION', `workspace dir already exists at ${dir}`);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'repos.json'), JSON.stringify({ repos: [] }, null, 2));
    await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify({ worktrees: {} }, null, 2));
    const created = await app.deps.workspaces.add(parsed);
    app.deps.bus.emit('workspaces', { type: 'workspace.created', data: created });
    return reply.code(200).send(created);
  });

  app.patch<{ Params: { wsId: string } }>('/api/workspaces/:wsId', async (req) => {
    const patch = { ...(req.body as Record<string, unknown>) };
    // The worktree location is no longer a setting — everything goes under
    // `<home>/worktrees/<repoId>`. Old clients may still send the field;
    // dropping it here keeps their whole patch from failing.
    delete patch.worktreeRoot;
    const updated = await app.deps.workspaces.patch(req.params.wsId, patch);
    app.deps.bus.emit('workspaces', { type: 'workspace.updated', data: updated });
    return updated;
  });

  // Order is the array order in workspaces.json — the same order the sidebar
  // dots and the swipe run through. The whole list is sent, not a move, so a
  // stale client can't half-apply a rearrangement.
  app.post('/api/workspaces/order', async (req) => {
    const parsed = z.object({ ids: z.array(z.string().min(1)).min(1) }).safeParse(req.body);
    if (!parsed.success) throw new AppError('VALIDATION', parsed.error.message, parsed.error.issues);
    const workspaces = await app.deps.workspaces.reorder(parsed.data.ids);
    // No bus event: the `workspaces` channel's types each carry one workspace,
    // and an order change is about all of them. Broadcasting it needs a new
    // event type and a consumer, which is the deferred multi-window work.
    return { workspaces };
  });

  app.delete<{ Params: { wsId: string }; Querystring: { confirm?: string } }>(
    '/api/workspaces/:wsId',
    async (req, reply) => {
      if (req.query.confirm !== '1') throw new AppError('VALIDATION', 'confirm=1 required');
      const wsId = req.params.wsId;
      const stores = await app.deps.registry.get(wsId);
      const repos = await stores.repos.list();
      const allWorktrees = await stores.state.list();
      const runningPaths = allWorktrees
        .filter((wt) => !!findOwningRepo(repos, wt.path, app.deps.homeStateDir))
        .filter((wt) => app.deps.proc.isRunning(wt.path))
        .map((wt) => wt.path);
      if (runningPaths.length > 0) {
        throw new AppError('WORKSPACE_HAS_RUNNING_PROCESSES',
          'stop running processes before deleting workspace', { runningPaths });
      }
      await app.deps.workspaces.remove(wsId);
      app.deps.registry.evict(wsId);
      const dir = app.deps.registry.workspaceDir(wsId);
      await fsp.rm(dir, { recursive: true, force: true });
      const newActive = await app.deps.workspaces.getActive();
      app.deps.bus.emit('workspaces',
        { type: 'workspace.deleted', data: { deletedId: wsId, newActiveId: newActive?.id ?? null } });
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { id: string } }>('/api/workspaces/active', async (req) => {
    const parsed = z.object({ id: z.string() }).parse(req.body);
    const ws = await app.deps.workspaces.setActive(parsed.id);
    app.deps.bus.emit('workspaces', { type: 'workspace.active-changed', data: { id: ws.id } });
    return { activeWorkspaceId: ws.id };
  });
}
