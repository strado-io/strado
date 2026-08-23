import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getTicketProvider, listTicketProviders } from '../services/tickets/registry.js';
import type { TicketIssue, TicketProviderId } from '../services/tickets/types.js';
import { writeLinearConfig, deleteLinearConfig, readLinearConfig } from '../services/tickets/linear.js';
import { hasFeature } from '../services/entitlements.js';

const ProviderParam = z.enum(['jira', 'linear']);
const RefsBody = z.object({
  refs: z.array(z.object({ provider: ProviderParam, key: z.string().min(1) })).max(200),
});
const TransitionBody = z.object({ transitionId: z.string().min(1) });

// State nonces THIS server minted via POST /connect. /connect/:state only
// ever resolves a state present here — without this, any well-formed 64-hex
// state is accepted, and the state space is not secret: an attacker can run
// their own OAuth completion against the (public) cloud broker under a state
// of their choosing, then get a victim's browser to GET
// /api/tickets/linear/connect/<that state> (a plain <img> tag — no
// preflight), and this server would happily poll the cloud, fetch the
// attacker's token, and overwrite the victim's ~/.strado/linear.json.
// Same 5-minute TTL as the cloud broker's own pending map.
const ISSUED_STATE_TTL_MS = 5 * 60_000;
// This route requires no auth (it's the pre-login step of connecting an
// integration), and a POST from a malicious page needs no CORS preflight —
// so, same reasoning as the cloud broker's MAX_PENDING/throttled sweep,
// this map needs its own cap and a sweep that isn't paid for on every call.
// 1,000 is plenty for a single desktop's worth of connect attempts.
const MAX_ISSUED_STATES = 1_000;
const ISSUED_SWEEP_INTERVAL_MS = 5_000;
const issuedStates = new Map<string, number>(); // state -> issuedAt
let lastIssuedSweepAt = 0;

function sweepIssuedStates(now: number) {
  if (now - lastIssuedSweepAt < ISSUED_SWEEP_INTERVAL_MS) return;
  lastIssuedSweepAt = now;
  for (const [state, issuedAt] of issuedStates) {
    if (now - issuedAt > ISSUED_STATE_TTL_MS) issuedStates.delete(state);
  }
}

export async function registerTicketRoutes(app: FastifyInstance) {
  // Jira and Linear are Pro (cloud) features that happen to run locally, so the
  // gate lives here. Free orgs never see them in the provider list, and every
  // per-provider route refuses — hiding alone would be bypassable.
  const guardProvider = async (
    provider: TicketProviderId,
    reply: import('fastify').FastifyReply,
  ): Promise<boolean> => {
    if (await hasFeature(provider)) return true;
    reply.code(402).send({ error: `${provider} requires a Pro plan`, code: 'UPGRADE_REQUIRED' });
    return false;
  };

  app.get('/api/tickets/providers', async () => {
    const all = await listTicketProviders();
    const gated = await Promise.all(all.map(async (p) => ((await hasFeature(p.provider)) ? p : null)));
    return { providers: gated.filter(Boolean) };
  });

  app.get<{ Params: { provider: string } }>('/api/tickets/:provider/my-issues', async (req, reply) => {
    const provider = ProviderParam.parse(req.params.provider);
    if (!(await guardProvider(provider, reply))) return reply;
    return { issues: await getTicketProvider(provider).getMyOpenIssues() };
  });

  app.get<{ Params: { provider: string }; Querystring: { project?: string } }>(
    '/api/tickets/:provider/sprints',
    async (req, reply) => {
      const provider = ProviderParam.parse(req.params.provider);
      if (!(await guardProvider(provider, reply))) return reply;
      return { sprints: await getTicketProvider(provider).getSprints(req.query.project) };
    },
  );

  app.get<{ Params: { provider: string; sprintId: string }; Querystring: { mine?: string } }>(
    '/api/tickets/:provider/sprint/:sprintId/issues',
    async (req, reply) => {
      const provider = ProviderParam.parse(req.params.provider);
      if (!(await guardProvider(provider, reply))) return reply;
      return { issues: await getTicketProvider(provider).getSprintIssues(req.params.sprintId, req.query.mine === '1') };
    },
  );

  app.get<{ Params: { provider: string; key: string } }>('/api/tickets/:provider/issue/:key', async (req, reply) => {
    const provider = ProviderParam.parse(req.params.provider);
    if (!(await guardProvider(provider, reply))) return reply;
    return getTicketProvider(provider).getIssue(req.params.key);
  });

  app.get<{ Params: { provider: string; key: string } }>('/api/tickets/:provider/issue/:key/transitions', async (req, reply) => {
    const provider = ProviderParam.parse(req.params.provider);
    if (!(await guardProvider(provider, reply))) return reply;
    return { transitions: await getTicketProvider(provider).getTransitions(req.params.key) };
  });

  app.post<{ Params: { provider: string; key: string } }>('/api/tickets/:provider/issue/:key/transitions', async (req, reply) => {
    const provider = ProviderParam.parse(req.params.provider);
    if (!(await guardProvider(provider, reply))) return reply;
    const body = TransitionBody.parse(req.body);
    return getTicketProvider(provider).doTransition(req.params.key, body.transitionId);
  });

  // Batch with per-provider isolation: one provider failing must never blank
  // the other's chips — its keys land in `errors`, not `missing`.
  app.post('/api/tickets/issues', async (req) => {
    const { refs } = RefsBody.parse(req.body);
    const byProvider = new Map<TicketProviderId, string[]>();
    for (const r of refs) {
      // Drop refs for providers this plan can't use — a Free org's board must
      // not be able to pull Jira/Linear issues through the batch endpoint.
      if (!(await hasFeature(r.provider))) continue;
      const list = byProvider.get(r.provider) ?? [];
      list.push(r.key);
      byProvider.set(r.provider, list);
    }
    const issues: Record<string, TicketIssue> = {};
    const missing: string[] = [];
    const errors: Partial<Record<TicketProviderId, string>> = {};
    await Promise.all([...byProvider.entries()].map(async ([provider, keys]) => {
      try {
        const res = await getTicketProvider(provider).getIssues(keys);
        for (const [k, v] of Object.entries(res.issues)) issues[`${provider}:${k}`] = v;
        for (const k of res.missing) missing.push(`${provider}:${k}`);
      } catch (err) {
        errors[provider] = err instanceof Error ? err.message : String(err);
      }
    }));
    return { issues, missing, errors };
  });

  // Linear OAuth: the cloud broker holds the client secret (never in this
  // package or desktop) and hands back a token via the poll route below.
  // Same STRADO_LICENSE_API expression as routes/license.ts.
  const cloudBase = () => (process.env.STRADO_LICENSE_API ?? 'https://api.strado.io').replace(/\/$/, '');

  app.post('/api/tickets/linear/connect', async (_req, reply) => {
    if (!(await guardProvider('linear', reply))) return reply;
    sweepIssuedStates(Date.now());
    if (issuedStates.size >= MAX_ISSUED_STATES) {
      return reply.code(429).send({ error: 'too many pending connections' });
    }
    const state = crypto.randomBytes(32).toString('hex');
    issuedStates.set(state, Date.now());
    return { state, url: `${cloudBase()}/v1/integrations/linear/start?state=${state}` };
  });

  app.get<{ Params: { state: string } }>('/api/tickets/linear/connect/:state', async (req, reply) => {
    const state = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.state);
    sweepIssuedStates(Date.now());
    // Reject before making any cloud request — a state we never issued gets
    // no cloud contact at all, so there's nothing for an attacker to learn
    // from timing or response shape either.
    if (!issuedStates.has(state)) return reply.code(404).send({ connected: false });
    const res = await fetch(`${cloudBase()}/v1/integrations/linear/poll?state=${state}`);
    if (!res.ok) return { connected: false };
    const body = (await res.json()) as { pending: boolean; accessToken?: string };
    if (body.pending || !body.accessToken) return { connected: false };
    issuedStates.delete(state); // single-use once the connection actually completes
    const { workspaceName } = await writeLinearConfig(body.accessToken);
    return { connected: true, workspaceName };
  });

  app.get('/api/tickets/linear/config', async () => {
    const cfg = await readLinearConfig();
    return { connected: cfg !== null, workspaceName: cfg?.workspaceName ?? null };
  });

  app.delete('/api/tickets/linear/config', async () => {
    await deleteLinearConfig();
    return { ok: true };
  });
}
