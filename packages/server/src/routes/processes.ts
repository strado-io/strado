import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import path from 'node:path';
import { FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { evictPortListeners, findExternalProcesses } from '../services/externalProcess.js';
import { worktreeHostname } from '../services/devProxy.js';
import { findFreePort } from '../ports.js';
import type { RepoConfig } from '../repoConfig.js';
import type { StateStore, WorktreeMeta } from '../state.js';
import { defaultShell } from '../services/platform.js';
import { resolveRunCommand, type ResolvedRun } from '../services/startCommand.js';
import { procKey } from '../services/processManager.js';
import { resolveStartEnv } from '../services/startEnv.js';

export async function registerProcessRoutes(app: FastifyInstance) {
  // Starting on an occupied port used to leave the new process to crash on
  // EADDRINUSE. Evict the configured port up front: our own managed dev
  // servers stop cleanly (state + SSE), anything else is killed and waited
  // out. Commands that bind a DIFFERENT port than the configured one (e.g.
  // webpack-dev-server on :443) are covered reactively by the process
  // manager's crash-retry, which reads the real port from the error output.
  async function freePort(port: number, exceptKey: string) {
    for (const key of app.deps.proc.runningOnPort(port)) {
      if (key !== exceptKey) await app.deps.proc.stop(key);
    }
    await evictPortListeners(port);
  }

  // The default run: free its port, route the worktree through the dev proxy
  // when the repo has one, and spawn it with PORT. With a proxy, the dev
  // server never gets the proxy's port: a worktree still configured for it
  // (443 was the repo default) is moved to a free private port, persisted so
  // it stays stable. Any other run command just runs, in its own terminal.
  async function launch(opts: {
    target: string;
    repo: RepoConfig;
    meta: WorktreeMeta | null;
    state: StateStore;
    cwd: string;
    run: ResolvedRun;
    env: Record<string, string>;
  }) {
    const { target, repo, meta, state, run } = opts;
    // When the command ends, its tab becomes a plain login shell (no run env).
    const shell = { file: defaultShell(), args: ['-il'] };
    const base = { cwd: opts.cwd, command: defaultShell(), args: ['-ilc', run.command], env: opts.env, worktree: target, runId: run.id, name: run.name, shell };
    if (!run.isDefault) {
      await app.deps.proc.start({ ...base, key: procKey(target, run), primary: false, port: 0 });
      return { warning: null };
    }
    let port = meta?.port ?? repo.defaultPort;
    const proxy = repo.devProxy ?? null;
    let proxyUrl: string | null = null;
    let warning: string | null = null;
    if (proxy) {
      if (port === proxy.port) {
        const reserved = new Set(
          (await state.list())
            .map((e) => e.meta.port)
            .filter((p): p is number => typeof p === 'number'),
        );
        reserved.add(proxy.port);
        port = await findFreePort(proxy.port, reserved);
        if (meta) await state.patch(target, { port });
      }
      // Whatever still holds the proxy port (a dev server from before the
      // proxy was configured) has to go before the proxy can bind it.
      if (!app.deps.devProxy.listenPorts().has(proxy.port)) await freePort(proxy.port, target);
      const registered = await app.deps.devProxy.register({
        key: target,
        hostname: worktreeHostname(proxy.host, target, repo.path),
        config: proxy,
        resolvePort: () => {
          const info = app.deps.proc.status(target);
          return info.status === 'running' || info.status === 'starting' ? info.port : null;
        },
      });
      proxyUrl = registered.url;
      warning = registered.warning;
    }

    await freePort(port, target);
    await app.deps.proc.start({ ...base, key: target, port, proxyUrl, proxyPort: proxy?.port ?? null, notices: warning ? [warning] : [] });
    return { warning };
  }

  // The worktree's repo (checked to own it) and which run command `runId` names.
  async function runOf(req: FastifyRequest, target: string, runId: string | null) {
    const { repos, state } = req.workspace!.stores;
    const repo = findOwningRepo(await repos.list(), target, app.deps.homeStateDir, { includeRepoRoot: true });
    if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
    assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
    const meta = await state.get(target);
    return { repo, meta, state, run: resolveRunCommand(repo, runId, meta?.startCommand ?? null) };
  }

  const RunBody = z.object({ runId: z.string().min(1).nullable().optional(), force: z.boolean().optional() }).nullish();
  const runIdOf = (body: unknown) => RunBody.parse(body ?? undefined)?.runId ?? null;

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/start',
    async (req) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const { repo, meta, state, run } = await runOf(req, target, runIdOf(req.body));
      // The last run's tab is a shell now; a new Run replaces it. If the user is
      // running something there, say so first (the web confirms, then forces).
      if (!RunBody.parse(req.body ?? undefined)?.force && await app.deps.proc.runTabBusy(procKey(target, run))) {
        throw new AppError('CONFLICT', 'the run tab is running something: stop it, or run anyway', { reason: 'run_tab_busy' });
      }
      const cwd = repo.projectSubdir ? path.join(target, repo.projectSubdir) : target;
      const env = await resolveStartEnv({ cwd, envFile: run.envFile, interpolated: false, worktreeEnv: meta?.env ?? {} });

      const { warning } = await launch({ target, repo, meta, state, cwd, run, env });

      if (meta && run.isDefault) await state.patch(target, { lastStartedAt: new Date().toISOString() });
      return { ...app.deps.proc.status(procKey(target, run)), ...(warning ? { proxyWarning: warning } : {}) };
    },
  );

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/stop',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const runId = runIdOf(req.body);
      // No runId: the default, as ever — no repo lookup needed for that.
      const key = runId ? procKey(target, (await runOf(req, target, runId)).run) : target;
      await app.deps.proc.stop(key);
      return reply.code(204).send();
    },
  );

  // Closing a run's tab: kill the shell a finished run left in it. A live run
  // is not killed this way (CONFLICT 'running'); the tab just detaches.
  app.delete<{ Params: { encodedPath: string }; Querystring: { runId?: string } }>(
    '/worktrees/:encodedPath/run-tab',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const runId = req.query.runId || null;
      app.deps.proc.closeTab(runId ? procKey(target, (await runOf(req, target, runId)).run) : target);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { encodedPath: string }; Querystring: { runId?: string } }>(
    '/worktrees/:encodedPath/status',
    async (req) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const runId = req.query.runId || null;
      return app.deps.proc.status(runId ? procKey(target, (await runOf(req, target, runId)).run) : target);
    },
  );

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/kill-external',
    async (req, reply) => {
      const { repos } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const repoList = await repos.list();
      const repo = findOwningRepo(repoList, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);

      const meta = await req.workspace!.stores.state.get(target);
      const found = await findExternalProcesses(
        [{ worktreePath: target, projectSubdir: repo.projectSubdir, port: meta?.port ?? repo.defaultPort ?? null }],
        app.deps.proc.ownedPids(),
      );
      const hit = found.get(target);
      if (!hit) throw new AppError('NOT_FOUND', 'no external process detected for this worktree');

      try {
        process.kill(hit.pid, 'SIGTERM');
      } catch (err) {
        throw new AppError('SHELL_FAILED', `failed to signal pid ${hit.pid}: ${(err as Error).message}`);
      }
      setTimeout(() => {
        try {
          process.kill(hit.pid, 0);
          process.kill(hit.pid, 'SIGKILL');
        } catch {
          // process already gone
        }
      }, 5_000);

      app.deps.bus.emit('worktrees', {
        type: 'worktree.updated',
        data: { path: target, killedExternalPid: hit.pid },
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { encodedPath: string }; Querystring: { tail?: string } }>(
    '/worktrees/:encodedPath/logs',
    async (req) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const tail = req.query.tail ? Number(req.query.tail) : 500;
      return { lines: app.deps.proc.snapshot(target, tail) };
    },
  );
}
