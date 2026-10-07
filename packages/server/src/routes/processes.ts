import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { evictPortListeners, findExternalProcesses } from '../services/externalProcess.js';
import { worktreeHostname } from '../services/devProxy.js';
import { findFreePort } from '../ports.js';
import type { RepoConfig } from '../repoConfig.js';
import type { StateStore, WorktreeMeta } from '../state.js';
import { defaultShell } from '../services/platform.js';
import { resolveStartCommand } from '../services/startCommand.js';
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

  // Free the port, route the worktree through the dev proxy when the repo has
  // one, and spawn the start command. With a proxy, the dev server never gets
  // the proxy's port: a worktree still configured for it (443 was the repo
  // default) is moved to a free private port, persisted so it stays stable.
  async function launch(opts: {
    target: string;
    repo: RepoConfig;
    meta: WorktreeMeta | null;
    state: StateStore;
    cwd: string;
    startCommand: string;
    env: Record<string, string>;
  }) {
    const { target, repo, meta, state } = opts;
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
    await app.deps.proc.start({
      key: target,
      cwd: opts.cwd,
      command: defaultShell(),
      args: ['-ilc', opts.startCommand],
      env: opts.env,
      port,
      proxyUrl,
      proxyPort: proxy?.port ?? null,
      notices: warning ? [warning] : [],
    });
    return { warning };
  }
  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/start',
    async (req) => {
      const { repos, state } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const repoList = await repos.list();
      const repo = findOwningRepo(repoList, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);

      const meta = await state.get(target);
      const cwd = repo.projectSubdir ? path.join(target, repo.projectSubdir) : target;
      if (!(meta?.startCommand?.trim() || repo.startCommand.trim())) {
        throw new AppError('VALIDATION', 'empty startCommand');
      }

      const { command: startCommand, profile: resolvedProfile, envFile, interpolated } = resolveStartCommand(
        repo,
        meta?.activeEnvProfile ?? null,
        meta?.startCommand ?? null,
      );
      const env = await resolveStartEnv({ cwd, envFile, interpolated, worktreeEnv: meta?.env ?? {} });

      const { warning } = await launch({ target, repo, meta, state, cwd, startCommand, env });

      if (meta) {
        const patch: Record<string, unknown> = { lastStartedAt: new Date().toISOString() };
        if (resolvedProfile && meta.activeEnvProfile !== resolvedProfile) {
          patch.activeEnvProfile = resolvedProfile;
        }
        await state.patch(target, patch);
      }
      return { ...app.deps.proc.status(target), ...(warning ? { proxyWarning: warning } : {}) };
    },
  );

  const EnvProfileBody = z.object({ profile: z.string().min(1) });

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/env-profile',
    async (req) => {
      const { repos, state } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const { profile } = EnvProfileBody.parse(req.body);

      const repoList = await repos.list();
      const repo = findOwningRepo(repoList, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);

      const profiles = repo.envProfiles ?? [];
      if (!profiles.some((p) => p.name === profile)) {
        throw new AppError('VALIDATION', `unknown env profile: ${profile}`);
      }

      const meta = await state.get(target);
      if (!meta) throw new AppError('NOT_FOUND', `worktree not tracked: ${target}`);

      const wasRunning =
        app.deps.proc.status(target).status === 'running' ||
        app.deps.proc.status(target).status === 'starting';

      if (wasRunning) {
        await app.deps.proc.stop(target);
      }

      await state.patch(target, { activeEnvProfile: profile });
      app.deps.bus.emit('worktrees', {
        type: 'worktree.updated',
        data: { path: target, activeEnvProfile: profile },
      });

      if (wasRunning) {
        const cwd = repo.projectSubdir ? path.join(target, repo.projectSubdir) : target;
        const { command: startCommand, envFile, interpolated } = resolveStartCommand(repo, profile, meta.startCommand ?? null);
        const env = await resolveStartEnv({ cwd, envFile, interpolated, worktreeEnv: meta.env ?? {} });
        await launch({ target, repo, meta, state, cwd, startCommand, env });
        await state.patch(target, { lastStartedAt: new Date().toISOString() });
      }

      return {
        activeEnvProfile: profile,
        restarted: wasRunning,
        process: app.deps.proc.status(target),
      };
    },
  );

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/stop',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      await app.deps.proc.stop(target);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/status',
    async (req) => {
      const target = decodeURIComponent(req.params.encodedPath);
      return app.deps.proc.status(target);
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
