import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { resolveSshAlias } from '../services/gitProviders.js';
import { sandboxEnvForRepo } from '../services/modelCredential.js';
import { followRemoteJob, type RemoteJobEvent } from '../services/remoteJobs.js';
import { backfillCloneUrls } from '../services/repoBackfill.js';
import { matchRepo, portableCloneUrl } from '../services/repoIdentity.js';
import type { RunnerFetch } from '../services/runnerFetch.js';
import { HOST_TAB_ROUTES, RUNNER_HOST_TAB_PATHS, type LogPage, type SandboxList } from '../services/hostTabs/types.js';
import { assertHubRequest } from './appControl.js';

// A host's Sandboxes and Logs tabs: the laptop end, forwarding to the runner's
// own routes through the relay. Inputs are validated before anything leaves;
// the runner's answer is re-parsed down to the contract fields, so nothing
// else it might add (env, labels, inspect output) reaches the page; every
// error is a fixed string, never the runner's text.
//
// Actions answer to the hub only (assertHubRequest), and, like remote worktree
// delete and sandbox rebuild, a relayed window may use them: the relay always
// reaches us as loopback.

const RunnerParams = z.object({ id: z.string().min(1).max(64) });
const ActionParams = RunnerParams.extend({
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  action: z.enum(['restart', 'stop', 'start', 'rebuild', 'remove']),
});
const LogParams = z.object({
  lines: z.coerce.number().int().min(1).max(1000).optional(),
  grep: z.string().min(1).max(200).optional(),
  since: z.coerce.number().int().min(0).optional(),
}).strict();

const AGENT = z.enum(['claude', 'codex', 'opencode', 'pi']);
const Row = z.object({
  slug: z.string(),
  worktreePath: z.string().nullable(),
  repoName: z.string().nullable(),
  worktreeName: z.string().nullable(),
  status: z.enum(['running', 'stopped', 'creating', 'unknown']),
  image: z.string(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  cpuPercent: z.number().nullable(),
  memBytes: z.number().nullable(),
  memLimitBytes: z.number().nullable(),
  staleLogins: z.array(AGENT),
});
const List: z.ZodType<SandboxList> = z.object({ sandboxes: z.array(Row), runtime: z.enum(['podman', 'docker']).nullable() });
const Page: z.ZodType<LogPage> = z.object({
  lines: z.array(z.object({ ts: z.number(), level: z.enum(['info', 'warn', 'error', 'debug']), text: z.string() })).max(1000),
  source: z.enum(['journal', 'file', 'none']),
  nextSince: z.number().nullable(),
});
const Ok = z.object({ ok: z.literal(true) });
const RemoteJob = z.object({ jobId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

const UNUSABLE = 'the runner sent an unusable answer';
const STEP_TEXT: Record<string, string> = {
  'sandbox-detect': 'Detecting sandbox deps…',
  'sandbox-build': 'Building the sandbox…',
};

/** A runner failure as one of our fixed strings. A 404 on a read is a runner
 *  without these routes; on an action, a sandbox it doesn't have. */
function mapRunnerError(err: unknown, kind: 'read' | 'action'): AppError {
  const code = err instanceof AppError ? err.code : null;
  if (code === 'NOT_FOUND') {
    return new AppError('NOT_FOUND', kind === 'read' ? 'update this runner to use this tab' : 'no such sandbox on this runner');
  }
  if (code === 'VALIDATION' || code === 'CONFLICT') return new AppError('VALIDATION', 'the runner refused that');
  return new AppError('CLOUD_UNREACHABLE', 'runner is offline or unreachable');
}

async function ask<T>(p: Promise<unknown>, schema: z.ZodType<T>, kind: 'read' | 'action'): Promise<T> {
  let body: unknown;
  try {
    body = await p;
  } catch (err) {
    throw mapRunnerError(err, kind);
  }
  const res = schema.safeParse(body);
  if (!res.success) throw new AppError('CLOUD_UNREACHABLE', UNUSABLE);
  return res.data;
}

type LocalRepo = { path: string; cloneUrl: string | null };

export async function registerHostTabRoutes(
  app: FastifyInstance,
  runner: RunnerFetch,
  opts: {
    follow?: typeof followRemoteJob;
    /** Every local repo, in every workspace, with its clone URL. */
    localRepos?: () => Promise<{ repo: LocalRepo; cloneUrl: string | null }[]>;
    sandboxEnv?: (repo: LocalRepo) => Promise<Record<string, string>>;
  } = {},
): Promise<void> {
  const follow = opts.follow ?? followRemoteJob;
  const localRepos = opts.localRepos ?? (async () => {
    const out: { repo: LocalRepo; cloneUrl: string | null }[] = [];
    for (const w of await app.deps.workspaces.list()) {
      try {
        const stores = await app.deps.registry.get(w.id);
        for (const r of await backfillCloneUrls(stores.repos, await stores.repos.list())) {
          out.push({ repo: { path: r.path, cloneUrl: r.cloneUrl ?? null }, cloneUrl: r.cloneUrl ?? null });
        }
      } catch {
        // A workspace whose store won't open just has no repos to match.
      }
    }
    return out;
  });
  // The same env /remote-worktrees/rebuild-sandbox sends: de-aliased, since the
  // token lookup is by real host.
  const sandboxEnv = opts.sandboxEnv ?? (async (repo: LocalRepo) => sandboxEnvForRepo({
    ...repo,
    cloneUrl: repo.cloneUrl ? await portableCloneUrl(repo.cloneUrl, resolveSshAlias) : repo.cloneUrl,
  }));

  /** The local repo this sandbox's worktree belongs to, or null: no label, no
   *  such worktree, no single match, or any lookup failing. */
  const localRepoFor = async (id: string, slug: string): Promise<LocalRepo | null> => {
    try {
      const list = List.parse(await runner.fetch(id, RUNNER_HOST_TAB_PATHS.sandboxes));
      const wt = list.sandboxes.find((r) => r.slug === slug)?.worktreePath;
      if (!wt) return null;
      const spaces = await runner.fetch<{ activeWorkspaceId: string | null; workspaces: { id: string }[] }>(id, '/api/workspaces');
      const ids = [...new Set([spaces.activeWorkspaceId, ...spaces.workspaces.map((w) => w.id)].filter((x): x is string => !!x))];
      for (const ws of ids) {
        const [wts, repos] = await Promise.all([
          runner.fetch<{ worktrees: { path: string; repoId: string | null }[] }>(id, `/api/w/${encodeURIComponent(ws)}/worktrees`),
          runner.fetch<{ repos: { id: string; cloneUrl?: string | null }[] }>(id, `/api/w/${encodeURIComponent(ws)}/repos`),
        ]);
        const w = wts.worktrees.find((x) => x.path === wt);
        if (!w) continue;
        const remote = repos.repos.find((r) => r.id === w.repoId);
        return matchRepo(remote?.cloneUrl, await localRepos());
      }
      return null;
    } catch {
      return null;
    }
  };

  app.get(HOST_TAB_ROUTES.sandboxes, async (req) => {
    assertHubRequest(req.headers);
    const { id } = RunnerParams.parse(req.params);
    return ask(runner.fetch(id, RUNNER_HOST_TAB_PATHS.sandboxes), List, 'read');
  });

  app.get(HOST_TAB_ROUTES.logs, async (req) => {
    assertHubRequest(req.headers);
    const { id } = RunnerParams.parse(req.params);
    const q = LogParams.parse(req.query);
    const qs = new URLSearchParams();
    if (q.lines !== undefined) qs.set('lines', String(q.lines));
    if (q.grep !== undefined) qs.set('grep', q.grep);
    if (q.since !== undefined) qs.set('since', String(q.since));
    const s = qs.toString();
    return ask(runner.fetch(id, `${RUNNER_HOST_TAB_PATHS.logs}${s ? `?${s}` : ''}`), Page, 'read');
  });

  app.post(HOST_TAB_ROUTES.action, async (req) => {
    assertHubRequest(req.headers);
    const { id, slug, action } = ActionParams.parse(req.params);
    const path = RUNNER_HOST_TAB_PATHS.action.replace(':slug', encodeURIComponent(slug)).replace(':action', action);
    // Container work (stop waits out a grace period, remove ends terminals).
    if (action !== 'rebuild') return ask(runner.fetch(id, path, { method: 'POST', timeoutMs: 60_000 }), Ok, 'action');

    // A worktree that maps to a local repo gets this laptop's repo tokens and
    // git identity, as the worktree's own rebuild sends; otherwise the runner
    // rebuilds from what it has.
    const repo = await localRepoFor(id, slug);
    const env = repo ? await sandboxEnv(repo) : {};
    const call = runner.fetch(id, path, {
      method: 'POST', timeoutMs: 60_000, ...(Object.keys(env).length ? { body: { sandboxEnv: env } } : {}),
    });
    const { jobId: remoteJobId } = await ask(call, RemoteJob, 'action');
    const job = app.deps.jobs.start('host-sandbox.rebuild', async (ctx) => {
      ctx.progress('Rebuilding the sandbox on the runner…', { step: 'sandbox-detect' });
      try {
        const { httpBase, ticket } = await runner.credential(id);
        // Only known step ids pass, as our own text: the runner's messages
        // carry build output.
        await follow(`${httpBase}/events/jobs/${encodeURIComponent(remoteJobId)}?ticket=${ticket}`, (evt: RemoteJobEvent) => {
          if (evt.type === 'progress' && evt.step && STEP_TEXT[evt.step]) ctx.progress(STEP_TEXT[evt.step]!, { step: evt.step });
        });
      } catch {
        throw new AppError('SHELL_FAILED', 'rebuild failed on the runner');
      }
      return { runnerId: id, slug };
    });
    return { jobId: job.id };
  });
}
