import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgent } from '../hooks/requireAgent.js';

const AliasBody = z.object({ alias: z.string().nullable() });

/** Root-level intercom routes: authenticated by execution token, not workspace URL. */
export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agents/me', async (req) => {
    const ex = requireAgent(app, req);
    const me = await app.deps.agents.resolve(ex.scopeId, ex.agentId);
    return {
      agentId: me.agentId,
      scopeId: me.scopeId,
      executionId: ex.executionId,
      alias: me.alias,
      lifecycle: me.lifecycle,
    };
  });
}

/** Workspace-scoped UI routes. No auth, like every other /api/w route today. */
export async function registerAgentScopedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/agents', async (req) => {
    return { agents: await app.deps.agents.list(req.workspace!.id) };
  });

  app.put<{ Params: { agentId: string } }>('/agents/:agentId/alias', async (req) => {
    const { alias } = AliasBody.parse(req.body);
    // Fastify/find-my-way already decodes path params — decoding again here
    // is a double-decode, and a malformed sequence like "%zz" (perfectly
    // valid as an already-decoded param) throws URIError, turning a routine
    // NOT_FOUND into an unhandled 500.
    return { agent: await app.deps.agents.setAlias(req.workspace!.id, req.params.agentId, alias) };
  });
}
