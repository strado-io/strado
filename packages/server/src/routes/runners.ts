// Self-hosted runner management, proxied through the local server.
//
// The renderer must never hold the account's device token: it lives in
// ~/.strado/license.json, which only the server reads. So the UI calls these
// routes and the server talks to strado-api on its behalf (same arrangement as
// the update check).
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { createCloudApi } from '../services/cloudApi.js';
import { createForwardManager } from '../services/forwardManager.js';
import { backfillCloneUrls } from '../services/repoBackfill.js';
import { resolveSshAlias } from '../services/gitProviders.js';
import { sandboxEnvForRepo } from '../services/modelCredential.js';
import { stepReporter } from '../services/jobSteps.js';
import { followRemoteJob } from '../services/remoteJobs.js';
import { matchRepo, portableCloneUrl, repoIdentity } from '../services/repoIdentity.js';

export type RunnerRow = {
  runnerId: string;
  name: string;
  online: boolean;
  lastOnlineAt: string | null;
  createdAt: string;
  runnerVersion: string | null;
};

const TIMEOUT_MS = 10_000;

export function pickSessionFields(w: {
  hasClaudeSession?: boolean; claudeStatus?: 'idle' | 'working' | 'waiting';
  claudeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; claudeSessions?: string[];
  hasCodexSession?: boolean; codexStatus?: 'idle' | 'working' | 'waiting';
  codexStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; codexSessions?: string[];
  hasOpencodeSession?: boolean; opencodeStatus?: 'idle' | 'working' | 'waiting';
  opencodeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; opencodeSessions?: string[];
  hasShellSession?: boolean; shellSessions?: string[];
}) {
  return {
    hasClaudeSession: w.hasClaudeSession, claudeStatus: w.claudeStatus,
    claudeStatusById: w.claudeStatusById, claudeSessions: w.claudeSessions,
    hasCodexSession: w.hasCodexSession, codexStatus: w.codexStatus,
    codexStatusById: w.codexStatusById, codexSessions: w.codexSessions,
    hasOpencodeSession: w.hasOpencodeSession, opencodeStatus: w.opencodeStatus,
    opencodeStatusById: w.opencodeStatusById, opencodeSessions: w.opencodeSessions,
    hasShellSession: w.hasShellSession, shellSessions: w.shellSessions,
  };
}

/**
 * Build the runner API path for a session, e.g. for killing it.
 *
 * The default session (no id, or id '1') is addressed without a query
 * string — that's how the runner's own session routes distinguish "the one
 * session" from a specific one among several.
 */
export function runnerSessionPath(o: {
  remoteWsId: string; path: string; mode: 'claude' | 'shell' | 'codex' | 'opencode'; id?: string;
}): string {
  const base = `/api/w/${encodeURIComponent(o.remoteWsId)}/worktrees/${encodeURIComponent(o.path)}/sessions/${o.mode}`;
  return o.id && o.id !== '1' ? `${base}?id=${encodeURIComponent(o.id)}` : base;
}

/**
 * Unwrap a runner's error body down to its human sentence.
 *
 * Our own error shape is `{error:{code,message}}`, so a naive pass-through
 * shows the user JSON. Anything we can't parse falls back to naming the
 * runner and the status, which at least says which machine refused.
 */
export function runnerErrorMessage(body: string, runnerId: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const inner =
      typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message ?? parsed.message;
    if (inner) return `${runnerId}: ${inner}`;
  } catch {
    /* not JSON */
  }
  const text = body.trim();
  return text
    ? `${runnerId} returned ${status}: ${text.slice(0, 300)}`
    : `${runnerId} returned ${status}`;
}

export async function registerRunnerRoutes(app: FastifyInstance): Promise<void> {
  const apiUrl = (process.env.STRADO_LICENSE_API ?? 'https://api.strado.io').replace(/\/$/, '');
  const { token, cloud } = createCloudApi();

  app.get('/api/runners', async () => {
    const t = await token();
    return cloud<{ runners: RunnerRow[] }>(`/v1/runners?token=${encodeURIComponent(t)}`);
  });

  app.post('/api/runners/pair-code', async () => {
    const t = await token();
    const minted = await cloud<{ code: string; expiresAt: string }>('/v1/runners/pair-code', {
      method: 'POST',
      body: { token: t },
    });
    // Hand the UI the exact commands to run on the box, so the panel never
    // hardcodes (and drifts from) the installer URL.
    return {
      ...minted,
      installCommand: `curl -fsSL ${apiUrl}/install-runner.sh | sh`,
      pairCommand: `strado-runner pair --code ${minted.code}`,
    };
  });

  const RunnerParams = z.object({ id: z.string().min(1).max(64) });

  app.post('/api/runners/:id/attach', async (req) => {
    const { id } = RunnerParams.parse(req.params);
    const t = await token();
    // Attach codes are single-use: mint a fresh one per open.
    return cloud<{ code: string; expiresAt: string; url: string }>('/v1/runners/attach-code', {
      method: 'POST',
      body: { token: t, runnerId: id },
    });
  });

  // Credential for the renderer's DIRECT socket to the relay. Terminal bytes
  // must not hairpin through this server — it is the same process that
  // enumerates every worktree, and re-streaming agent output through it is how
  // the boot stall happened. So the renderer connects straight to the relay and
  // this route is the only part the server plays.
  app.post('/api/runners/:id/socket-ticket', async (req) => {
    const { id } = RunnerParams.parse(req.params);
    const t = await token();
    return cloud<{ ticket: string; expiresAt: string; wsBase: string; httpBase: string }>(
      '/v1/runners/socket-ticket',
      { method: 'POST', body: { token: t, runnerId: id } },
    );
  });

  // Tickets are reusable within their TTL, so cache them: listing remote
  // worktrees makes three calls per runner, and minting one apiece would turn
  // every sidebar refresh into a burst of writes on the cloud store.
  const tickets = new Map<string, { ticket: string; httpBase: string; expiresAt: number }>();

  async function runnerCredential(runnerId: string): Promise<{ ticket: string; httpBase: string }> {
    const hit = tickets.get(runnerId);
    // Re-mint a minute early so a call can't start with a ticket that expires
    // mid-flight.
    if (hit && hit.expiresAt - Date.now() > 60_000) return hit;
    const t = await token();
    const minted = await cloud<{ ticket: string; httpBase: string; expiresAt: string }>(
      '/v1/runners/socket-ticket',
      { method: 'POST', body: { token: t, runnerId } },
    );
    const entry = {
      ticket: minted.ticket,
      httpBase: minted.httpBase,
      expiresAt: Date.parse(minted.expiresAt),
    };
    tickets.set(runnerId, entry);
    return entry;
  }

  /** One request to a runner's own API, through the relay. */
  async function runnerFetch<T>(
    runnerId: string,
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    if (!path.startsWith('/api/')) {
      throw new AppError('VALIDATION', 'runner path must start with /api/');
    }
    const { ticket, httpBase } = await runnerCredential(runnerId);
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? TIMEOUT_MS);
    try {
      const res = await fetch(`${httpBase}${path}${sep}ticket=${ticket}`, {
        method: init?.method ?? 'GET',
        headers: init?.body ? { 'content-type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (res.status === 401) {
        // The ticket was rejected (revoked runner, or it aged out while
        // cached). Drop it so the next call mints fresh rather than repeating
        // a request that can only fail.
        tickets.delete(runnerId);
        throw new AppError('VALIDATION', `runner ${runnerId} rejected our access`);
      }
      if (!res.ok) {
        // 503 from the relay means the tunnel is down: an offline runner, not a
        // broken request, and the UI renders those differently.
        if (res.status === 503) {
          throw new AppError('CLOUD_UNREACHABLE', `runner ${runnerId} is offline`);
        }
        // The far side already wrote a message for a human (clone failed,
        // no credentials, …). Pass THAT through — wrapping it in
        // "runner returned 500: {json}" buries the sentence the user needs
        // inside a payload.
        const detail = await res.text().catch(() => '');
        throw new AppError('VALIDATION', runnerErrorMessage(detail, runnerId, res.status));
      }
      return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    } catch (err) {
      if (err instanceof AppError) throw err;
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      throw new AppError('CLOUD_UNREACHABLE', `could not reach runner ${runnerId} (${reason})`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Port forwarding ─────────────────────────────────────────────
  //
  // The listeners live in child processes, so this only tracks them; asset
  // traffic never enters the process that enumerates every worktree.
  const forwards = createForwardManager({
    // Resolved at spawn time, not now: routes register before listen(), so the
    // real port isn't known yet.
    serverOrigin: () => {
      const addr = app.server.address();
      const port = addr && typeof addr === 'object' ? addr.port : Number(process.env.PORT ?? 7777);
      return `http://127.0.0.1:${port}`;
    },
    log: (line) => app.deps.debugLog.log('forward', line),
  });
  app.addHook('onClose', async () => {
    await forwards.closeAll();
  });

  const PortBody = z.object({ remotePort: z.number().int().positive().max(65535) });

  app.get('/api/runners/forwards', async () => ({ forwards: forwards.list() }));

  app.post('/api/runners/:id/forwards', async (req) => {
    const { id } = RunnerParams.parse(req.params);
    const { remotePort } = PortBody.parse(req.body);
    try {
      return await forwards.open(id, remotePort);
    } catch (err) {
      // The child's own diagnosis is the useful one ("port N is not forwardable
      // on this runner", "cannot reach the local server for a ticket").
      throw new AppError('CLOUD_UNREACHABLE', `could not forward ${id}:${remotePort} — ${(err as Error).message}`);
    }
  });

  app.delete('/api/runners/:id/forwards/:remotePort', async (req, reply) => {
    const { id, remotePort } = z
      .object({ id: z.string().min(1), remotePort: z.coerce.number().int().positive().max(65535) })
      .parse(req.params);
    await forwards.close(id, remotePort);
    return reply.code(204).send();
  });

  const RpcQuery = z.object({ path: z.string().min(1).max(512) });

  app.get('/api/runners/:id/rpc', async (req) => {
    const { id } = RunnerParams.parse(req.params);
    const { path } = RpcQuery.parse(req.query);
    return runnerFetch<unknown>(id, path);
  });

  app.post('/api/runners/:id/rpc', async (req) => {
    const { id } = RunnerParams.parse(req.params);
    const { path } = RpcQuery.parse(req.query);
    // Longer than a read: this carries repo clones and worktree creation, which
    // do real work on the far side.
    return runnerFetch<unknown>(id, path, { method: 'POST', body: req.body, timeoutMs: 60_000 });
  });

  /**
   * Remote worktrees for every linked runner, matched to LOCAL repos.
   *
   * Deliberately its own endpoint rather than folded into
   * `/api/w/:ws/worktrees`: that route is on the boot path and already sat
   * behind an event-loop stall once. Network fan-out belongs somewhere the
   * sidebar can render late and degrade on its own.
   */
  app.get('/api/w/:ws/remote-worktrees', async (req) => {
    const { ws } = z.object({ ws: z.string().min(1) }).parse(req.params);
    const stores = await app.deps.registry.get(ws);
    const localRepos = await backfillCloneUrls(stores.repos, await stores.repos.list());
    const locals = localRepos.map((r) => ({ repo: r.id, cloneUrl: r.cloneUrl ?? null }));

    // Repos of every OTHER workspace. A runner worktree whose repo lives in
    // one of them is omitted from THIS response entirely — it renders nested
    // under that repo in its own space, and the same rows appearing both
    // there and here (in a bottom bucket) read as a glitch.
    const elsewhere: { repo: string; cloneUrl: string | null }[] = [];
    for (const other of (await app.deps.workspaces.list()).filter((w) => w.id !== ws)) {
      try {
        const os = await app.deps.registry.get(other.id);
        const repos = await backfillCloneUrls(os.repos, await os.repos.list());
        elsewhere.push(...repos.map((r) => ({ repo: r.id, cloneUrl: r.cloneUrl ?? null })));
      } catch {
        // A workspace whose store won't open must not blank out runner rows.
      }
    }

    let list: { runners: RunnerRow[] };
    try {
      const t = await token();
      list = await cloud<{ runners: RunnerRow[] }>(`/v1/runners?token=${encodeURIComponent(t)}`);
    } catch {
      // No account, or the cloud is unreachable: there are simply no remote
      // worktrees to show. Not an error the sidebar should shout about.
      return { runners: [], worktrees: [] };
    }

    const runners = await Promise.all(
      list.runners.map(async (r) => {
        if (!r.online) {
          return { runner: { runnerId: r.runnerId, name: r.name, online: false, error: null }, worktrees: [] };
        }
        try {
          const spaces = await runnerFetch<{ activeWorkspaceId: string | null; workspaces: { id: string }[] }>(
            r.runnerId,
            '/api/workspaces',
          );
          const remoteWsId = spaces.activeWorkspaceId ?? spaces.workspaces[0]?.id;
          if (!remoteWsId) {
            return { runner: { runnerId: r.runnerId, name: r.name, online: true, error: null }, worktrees: [] };
          }
          const [repos, worktrees] = await Promise.all([
            runnerFetch<{ repos: { id: string; path: string; cloneUrl?: string | null }[] }>(
              r.runnerId,
              `/api/w/${encodeURIComponent(remoteWsId)}/repos`,
            ),
            runnerFetch<{ worktrees: Array<{
              path: string; repoId: string | null; branch: string | null; head: string;
              hasClaudeSession?: boolean; claudeStatus?: 'idle' | 'working' | 'waiting';
              claudeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; claudeSessions?: string[];
              hasCodexSession?: boolean; codexStatus?: 'idle' | 'working' | 'waiting';
              codexStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; codexSessions?: string[];
              hasOpencodeSession?: boolean; opencodeStatus?: 'idle' | 'working' | 'waiting';
              opencodeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; opencodeSessions?: string[];
              hasShellSession?: boolean; shellSessions?: string[];
            }> }>(
              r.runnerId,
              `/api/w/${encodeURIComponent(remoteWsId)}/worktrees`,
            ),
          ]);
          const byId = new Map(repos.repos.map((x) => [x.id, x]));
          // The relay origin rides along so the UI never has to mint a ticket
          // just to learn where to connect.
          const { httpBase } = await runnerCredential(r.runnerId);
          const wsBase = httpBase.replace(/^https:/, 'wss:');
          return {
            runner: { runnerId: r.runnerId, name: r.name, online: true, error: null },
            worktrees: worktrees.worktrees.flatMap((w) => {
              const remoteRepo = w.repoId ? byId.get(w.repoId) : undefined;
              // null = we can't tell which local repo this belongs to, so the
              // UI groups it under a repo folder built from the remote name.
              const localRepoId = matchRepo(remoteRepo?.cloneUrl, locals);
              if (!localRepoId && matchRepo(remoteRepo?.cloneUrl, elsewhere)) return [];
              return [{
                runnerId: r.runnerId,
                runnerName: r.name,
                wsBase,
                remoteWsId,
                path: w.path,
                name: w.path.split('/').filter(Boolean).pop() ?? w.path,
                branch: w.branch,
                head: w.head,
                remoteRepoId: w.repoId,
                // A repo's main working tree is not a worktree you can remove;
                // the delete route refuses it, so the UI must not offer it.
                isRepoRoot: !!remoteRepo && remoteRepo.path === w.path,
                cloneUrl: remoteRepo?.cloneUrl ?? null,
                localRepoId,
                remoteRepoName:
                  repoIdentity(remoteRepo?.cloneUrl)?.pathKey.split('/').pop() ??
                  remoteRepo?.path.split('/').filter(Boolean).pop() ??
                  null,
                ...pickSessionFields(w),
              }];
            }),
          };
        } catch (err) {
          // One unreachable runner must not blank out the others.
          return {
            runner: { runnerId: r.runnerId, name: r.name, online: true, error: (err as Error).message },
            worktrees: [],
          };
        }
      }),
    );

    return {
      runners: runners.map((r) => r.runner),
      worktrees: runners.flatMap((r) => r.worktrees),
    };
  });

  const RemoteDelete = z.object({
    runnerId: z.string().min(1).max(64),
    remoteWsId: z.string().min(1),
    path: z.string().min(1),
    force: z.boolean().optional(),
    deleteBranch: z.boolean().optional(),
  });

  /**
   * Remove a worktree that lives on a runner.
   *
   * A job for the same reason creation is one: it removes files on another
   * machine and the interesting failures (runner offline, uncommitted changes)
   * deserve to land on a named step rather than vanish.
   */
  app.post('/api/w/:ws/remote-worktrees/delete', async (req) => {
    z.object({ ws: z.string().min(1) }).parse(req.params);
    const body = RemoteDelete.parse(req.body);

    const job = app.deps.jobs.start('remote-worktree.delete', async (ctx) => {
      const step = stepReporter(ctx, [
        { id: 'stop', label: 'Stopping processes' },
        { id: 'unlink', label: 'Unlinking node_modules' },
        { id: 'remove', label: `Removing worktree on ${body.runnerId}` },
      ]);
      step('stop');
      const q = new URLSearchParams();
      if (body.force) q.set('force', '1');
      if (body.deleteBranch) q.set('deleteBranch', '1');
      const qs = q.toString();
      const { jobId } = await runnerFetch<{ jobId: string }>(
        body.runnerId,
        `/api/w/${encodeURIComponent(body.remoteWsId)}/worktrees/${encodeURIComponent(body.path)}${qs ? `?${qs}` : ''}`,
        { method: 'DELETE' },
      );
      const { httpBase, ticket } = await runnerCredential(body.runnerId);
      await followRemoteJob(
        `${httpBase}/events/jobs/${encodeURIComponent(jobId)}?ticket=${ticket}`,
        (evt) => {
          if (evt.type !== 'progress') return;
          if (evt.step && ['stop', 'unlink', 'remove'].includes(evt.step)) step(evt.step);
          else if (evt.message) step.detail(evt.message);
        },
      );
      return { runnerId: body.runnerId, path: body.path };
    });

    return { jobId: job.id };
  });

  const RemoteKill = z.object({
    runnerId: z.string().min(1).max(64),
    remoteWsId: z.string().min(1),
    path: z.string().min(1),
    mode: z.enum(['claude', 'shell', 'codex', 'opencode']),
    id: z.string().min(1).optional(),
  });

  // Kill a session that lives on a runner. Synchronous, not a job: terminating a
  // session is fast, and the caller (the session rail) wants an immediate result.
  app.post('/api/w/:ws/remote-worktrees/kill-session', async (req) => {
    z.object({ ws: z.string().min(1) }).parse(req.params);
    const body = RemoteKill.parse(req.body);
    await runnerFetch<unknown>(body.runnerId, runnerSessionPath(body), { method: 'DELETE' });
    return { ok: true };
  });

  const RemoteCreate = z.object({
    runnerId: z.string().min(1).max(64),
    /** LOCAL repo id — the runner's own id for the same repo is resolved here. */
    repoId: z.string().min(1),
    ticketId: z.string().min(1),
    ticketProvider: z.enum(['jira', 'linear']).optional(),
    title: z.string().min(1),
    // Branch names cross machines; paths don't, so there is deliberately no
    // sourceWorktree here — the runner branches off its own clone.
    sourceBranch: z.string().min(1),
    port: z.number().int().positive().optional(),
    env: z.record(z.string()).optional(),
  });

  /**
   * Create a worktree ON a runner: provision the repo there if needed, then
   * enqueue the same job the local server would run.
   *
   * Orchestrated server-side on purpose. It is three remote calls with a real
   * partial-failure story (repo cloned but worktree failed), and one owner for
   * that is better than a client sequencing it and guessing what state the far
   * machine ended up in.
   */
  app.post('/api/w/:ws/remote-worktrees', async (req) => {
    const { ws } = z.object({ ws: z.string().min(1) }).parse(req.params);
    const body = RemoteCreate.parse(req.body);
    const stores = await app.deps.registry.get(ws);
    const localRepo = (await backfillCloneUrls(stores.repos, await stores.repos.list())).find((r) => r.id === body.repoId);
    if (!localRepo) throw new AppError('VALIDATION', `no repo ${body.repoId} in this workspace`);
    if (!localRepo.cloneUrl) {
      // The whole mechanism rests on the runner cloning the repo itself. Without
      // a clone URL there is nothing to hand it, and no cloud may ship it the
      // local files.
      throw new AppError(
        'VALIDATION',
        `${localRepo.name ?? localRepo.id} has no git remote, so a runner has no way to get it. Add an origin remote and re-add the repo.`,
      );
    }
    const repoLabel = localRepo.name ?? localRepo.id;

    // A JOB, not a blocking request. Provisioning includes a clone that can run
    // for minutes on a large repo; doing it inside the POST meant the user
    // watched a dead dialog and a ten-minute in-flight request sat at the mercy
    // of any intermediary. Now every step is reported on the same stream the
    // local create uses, so the dialog needs one code path for both.
    const job = app.deps.jobs.start('remote-worktree.create', async (ctx) => {
      const step = stepReporter(ctx, [
        { id: 'runner', label: `Checking ${body.runnerId}` },
        { id: 'clone', label: `Cloning ${repoLabel} on ${body.runnerId}` },
        { id: 'worktree', label: 'Creating git worktree' },
        { id: 'link', label: 'Linking node_modules' },
        { id: 'finalize', label: 'Finalizing' },
      ]);

      step('runner');
      const spaces = await runnerFetch<{ activeWorkspaceId: string | null; workspaces: { id: string }[] }>(
        body.runnerId,
        '/api/workspaces',
      );
      const remoteWsId = spaces.activeWorkspaceId ?? spaces.workspaces[0]?.id;
      if (!remoteWsId) throw new AppError('VALIDATION', `runner ${body.runnerId} has no workspace`);

      // De-alias before handing the URL over: `git@github-strado:…` resolves only
      // through THIS machine's ssh config, and a runner would just fail to resolve
      // the host.
      const cloneUrl = await portableCloneUrl(localRepo.cloneUrl!, resolveSshAlias);

      step('clone');
      // Idempotent on the far side: an existing clone is registered, not re-cloned.
      const cloned = await runnerFetch<{ repo: { id: string }; alreadyRegistered: boolean; path: string }>(
        body.runnerId,
        `/api/w/${encodeURIComponent(remoteWsId)}/repos/clone`,
        { method: 'POST', body: { url: cloneUrl }, timeoutMs: 10 * 60_000 },
      );
      if (cloned.alreadyRegistered) step.detail('already on this runner');

      // The user's own credentials for the sandbox: model key, git identity, and
      // a push token answered via GIT_ASKPASS. Assembled locally (never leaves
      // this machine except into the runner's 0600 env-file) and validated again
      // on the runner's CreateBody. Omitted entirely when there's nothing to send.
      const sandboxEnv = await sandboxEnvForRepo(localRepo);

      const { jobId } = await runnerFetch<{ jobId: string }>(
        body.runnerId,
        `/api/w/${encodeURIComponent(remoteWsId)}/worktrees`,
        {
          method: 'POST',
          body: {
            repoId: cloned.repo.id,
            ticketId: body.ticketId,
            title: body.title,
            sourceBranch: body.sourceBranch,
            // Branch off the runner's own copy of the repo, never a local path.
            sourceWorktree: cloned.path,
            ...(body.ticketProvider ? { ticketProvider: body.ticketProvider } : {}),
            ...(body.port ? { port: body.port } : {}),
            ...(body.env ? { env: body.env } : {}),
            ...(Object.keys(sandboxEnv).length ? { sandboxEnv } : {}),
          },
        },
      );

      step('worktree');
      const { httpBase, ticket } = await runnerCredential(body.runnerId);
      // Follow the runner's own job so its steps appear in the same list.
      await followRemoteJob(
        `${httpBase}/events/jobs/${encodeURIComponent(jobId)}?ticket=${ticket}`,
        (evt) => {
          if (evt.type !== 'progress') return;
          // A runner on our version sends step ids; anything else becomes detail
          // under the current step rather than being dropped.
          if (evt.step && ['worktree', 'link', 'finalize'].includes(evt.step)) step(evt.step);
          else if (evt.message) step.detail(evt.message);
        },
      );

      step('finalize');
      return { runnerId: body.runnerId, remoteWsId, clonedTo: cloned.path };
    });

    return { jobId: job.id };
  });

  app.post('/api/runners/:id/revoke', async (req) => {
    const { id } = RunnerParams.parse(req.params);
    const t = await token();
    return cloud<{ ok: boolean }>('/v1/runners/revoke', { method: 'POST', body: { token: t, runnerId: id } });
  });
}
