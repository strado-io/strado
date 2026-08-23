import { FastifyInstance } from 'fastify';
import { checkTools } from '../services/toolCheck.js';

// First-run environment probe: which external CLIs exist on this machine.
// Cached for the process lifetime after the first success — tool installs
// mid-session are rare and a server restart re-probes.
export async function registerEnvCheckRoutes(app: FastifyInstance) {
  let cache: Awaited<ReturnType<typeof checkTools>> | null = null;
  app.get<{ Querystring: { fresh?: string } }>('/api/env-check', async (req) => {
    if (!cache || req.query.fresh === '1') cache = await checkTools();
    return { tools: cache };
  });
}
