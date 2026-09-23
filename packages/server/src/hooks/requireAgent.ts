import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import type { Execution } from '../services/agentRegistry.js';

/** Sender identity for intercom routes comes from the execution token and nothing
 * else. A body or query that names an agent is ignored, never merged. */
export function requireAgent(app: FastifyInstance, req: FastifyRequest): Execution {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const ex = token ? app.deps.agents.byToken(token) : null;
  if (!ex) throw new AppError('UNAUTHENTICATED', 'missing or invalid agent token');
  return ex;
}
