import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const PutBody = z.object({
  path: z.string().min(1),
  // Which Browser tab of the worktree this target is (multi-tab previews);
  // absent from shells older than multi-tab — those are tab 1.
  tabId: z.string().regex(/^\d+$/).optional(),
  targetId: z.string().min(1),
  wcId: z.number().int(),
  cdpPort: z.number().int().nullable(),
});

const DeleteBody = z.object({
  // no path = clear everything (desktop shell startup: previous shell's
  // entries are stale the moment it died); path without tabId = all of that
  // worktree's tabs; path + tabId = exactly one tab.
  path: z.string().min(1).optional(),
  tabId: z.string().regex(/^\d+$/).optional(),
});

// Registry of live Browser-preview CDP targets, pushed by the desktop shell —
// the only process that knows which WebContentsView belongs to which
// worktree. The per-worktree preview MCP reads it to scope an agent to its
// own worktree's tabs. In-memory on purpose: previews die with the shell.
export async function registerPreviewTargetRoutes(app: FastifyInstance) {
  // path -> tabId -> target
  const targets = new Map<string, Map<string, { targetId: string; wcId: number; cdpPort: number | null }>>();

  app.get('/api/preview-targets', async () => ({
    targets: [...targets.entries()].flatMap(([path, tabs]) =>
      [...tabs.entries()]
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([tabId, t]) => ({ path, tabId, ...t })),
    ),
  }));

  app.put('/api/preview-targets', async (req) => {
    const body = PutBody.parse(req.body);
    const tabs = targets.get(body.path) ?? new Map();
    tabs.set(body.tabId ?? '1', {
      targetId: body.targetId,
      wcId: body.wcId,
      cdpPort: body.cdpPort,
    });
    targets.set(body.path, tabs);
    return { ok: true };
  });

  app.delete('/api/preview-targets', async (req) => {
    const body = DeleteBody.parse(req.body ?? {});
    if (body.path && body.tabId) {
      const tabs = targets.get(body.path);
      tabs?.delete(body.tabId);
      if (tabs && tabs.size === 0) targets.delete(body.path);
    } else if (body.path) {
      targets.delete(body.path);
    } else {
      targets.clear();
    }
    return { ok: true };
  });
}
