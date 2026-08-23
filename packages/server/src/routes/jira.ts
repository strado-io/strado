import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readJiraConfig, writeJiraConfig, getIssue, getIssues, getTransitions, doTransition, getMyOpenIssues, getOpenSprints, getSprintIssues } from '../services/jira.js';
import { AppError } from '../errors.js';
import { hasFeature } from '../services/entitlements.js';

const BatchBody = z.object({ keys: z.array(z.string().min(1)).max(100) });
const TransitionBody = z.object({ transitionId: z.string().min(1) });

// Jira is a Pro (cloud) feature that runs locally. Every data route funnels
// through requireConfig(), so the plan gate lives here too — one refusal covers
// issues, sprints and transitions alike. `config` POST and `status` are gated
// separately below (they don't call this).
async function requireConfig() {
  if (!(await hasFeature('jira'))) {
    throw new AppError('VALIDATION', 'Jira requires a Pro plan');
  }
  const cfg = await readJiraConfig();
  if (!cfg) {
    throw new AppError('VALIDATION', 'Jira is not configured — open Jira Connection in the sidebar');
  }
  return cfg;
}

// Workspace-agnostic (credentials are per machine, not per workspace).
export async function registerJiraRoutes(app: FastifyInstance) {
  app.get('/api/jira/status', async () => {
    // Called on Dashboard mount — degrade to "not configured" for a Free org
    // rather than erroring, so the board simply shows no Jira.
    if (!(await hasFeature('jira'))) return { configured: false, baseUrl: null };
    const cfg = await readJiraConfig();
    return { configured: cfg !== null, baseUrl: cfg?.baseUrl ?? null };
  });

  // The token never leaves this machine: reads report only its presence.
  app.get('/api/jira/config', async () => {
    const cfg = await readJiraConfig();
    return { baseUrl: cfg?.baseUrl ?? null, email: cfg?.email ?? null, hasToken: cfg !== null };
  });

  app.post('/api/jira/config', async (req) => {
    if (!(await hasFeature('jira'))) throw new AppError('VALIDATION', 'Jira requires a Pro plan');
    const Body = z.object({
      baseUrl: z.string().url(),
      email: z.string().email(),
      apiToken: z.string().min(1),
    });
    const body = Body.parse(req.body);
    // A trailing slash in the base URL breaks path joins downstream.
    const result = await writeJiraConfig({ ...body, baseUrl: body.baseUrl.replace(/\/+$/, '') });
    return { ok: true, accountName: result.accountName };
  });

  app.get<{ Params: { key: string } }>('/api/jira/issue/:key', async (req) => {
    const cfg = await requireConfig();
    return getIssue(cfg, req.params.key);
  });

  app.post('/api/jira/issues', async (req) => {
    const cfg = await requireConfig();
    const body = BatchBody.parse(req.body);
    return getIssues(cfg, body.keys);
  });

  app.get('/api/jira/my-issues', async () => {
    const cfg = await requireConfig();
    return { issues: await getMyOpenIssues(cfg) };
  });

  app.get<{ Querystring: { project?: string } }>('/api/jira/sprints', async (req) => {
    const cfg = await requireConfig();
    const project = z.string().min(1).max(20).parse(req.query.project);
    return { sprints: await getOpenSprints(cfg, project) };
  });

  app.get<{ Params: { sprintId: string }; Querystring: { mine?: string } }>(
    '/api/jira/sprint/:sprintId/issues',
    async (req) => {
      const cfg = await requireConfig();
      const sprintId = z.coerce.number().int().positive().parse(req.params.sprintId);
      return { issues: await getSprintIssues(cfg, sprintId, req.query.mine === '1') };
    },
  );

  app.get<{ Params: { key: string } }>('/api/jira/issue/:key/transitions', async (req) => {
    const cfg = await requireConfig();
    return { transitions: await getTransitions(cfg, req.params.key) };
  });

  app.post<{ Params: { key: string } }>('/api/jira/issue/:key/transitions', async (req) => {
    const cfg = await requireConfig();
    const body = TransitionBody.parse(req.body);
    return doTransition(cfg, req.params.key, body.transitionId);
  });
}
