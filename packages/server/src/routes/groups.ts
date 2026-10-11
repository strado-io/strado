import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const MemberIds = z.array(z.string().min(1).max(4096)).max(200);
const CreateBody = z.object({ name: z.string(), members: MemberIds.optional() });
const PatchBody = z.object({
  name: z.string().optional(),
  addMembers: MemberIds.optional(),
  removeMembers: MemberIds.optional(),
  // Parked groups leave the sidebar until opened again; nothing else may be stored.
  state: z.enum(['working', 'parked']).optional(),
});

// Focus groups: named cross-repo bundles of worktrees. Member ids are the
// sidebar's pin ids (local:<path> / remote:<runnerId>:<path>), opaque here.
export async function registerGroupsRoutes(app: FastifyInstance) {
  app.get('/groups', async (req) => ({ groups: await req.workspace!.stores.groups.list() }));

  app.post('/groups', async (req) => {
    const body = CreateBody.parse(req.body);
    return { group: await req.workspace!.stores.groups.create(body) };
  });

  app.patch<{ Params: { id: string } }>('/groups/:id', async (req) => {
    const body = PatchBody.parse(req.body);
    return { group: await req.workspace!.stores.groups.update(req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>('/groups/:id', async (req, reply) => {
    await req.workspace!.stores.groups.remove(req.params.id);
    return reply.code(204).send();
  });
}
