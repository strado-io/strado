import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const MemberIds = z.array(z.string().min(1).max(4096)).max(200);
const CreateBody = z.object({ name: z.string(), members: MemberIds.optional() });
const PatchBody = z.object({
  name: z.string().optional(),
  addMembers: MemberIds.optional(),
  removeMembers: MemberIds.optional(),
  // The client activated it: stamp lastActiveAt. Nothing else may be stored.
  touch: z.boolean().optional(),
}).strict();

// Focuses: named cross-repo sets of worktrees, one per task. Member ids are
// the sidebar's pin ids (local:<path> / remote:<runnerId>:<path>), opaque here.
export async function registerFocusesRoutes(app: FastifyInstance) {
  app.get('/focuses', async (req) => ({ focuses: await req.workspace!.stores.focuses.list() }));

  app.post('/focuses', async (req) => {
    const body = CreateBody.parse(req.body);
    return { focus: await req.workspace!.stores.focuses.create(body) };
  });

  app.patch<{ Params: { id: string } }>('/focuses/:id', async (req) => {
    const body = PatchBody.parse(req.body);
    return { focus: await req.workspace!.stores.focuses.update(req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>('/focuses/:id', async (req, reply) => {
    await req.workspace!.stores.focuses.remove(req.params.id);
    return reply.code(204).send();
  });
}
