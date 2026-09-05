import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { evictPortListeners, findExternalProcesses } from '../services/externalProcess.js';
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
      const port = meta?.port ?? repo.defaultPort;
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

      await freePort(port, target);

      const shell = defaultShell();
      await app.deps.proc.start({
        key: target,
        cwd,
        command: shell,
        args: ['-ilc', startCommand],
        env,
        port,
      });

      if (meta) {
        const patch: Record<string, unknown> = { lastStartedAt: new Date().toISOString() };
        if (resolvedProfile && meta.activeEnvProfile !== resolvedProfile) {
          patch.activeEnvProfile = resolvedProfile;
        }
        await state.patch(target, patch);
      }
      return app.deps.proc.status(target);
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
        const port = meta.port ?? repo.defaultPort;
        const cwd = repo.projectSubdir ? path.join(target, repo.projectSubdir) : target;
        const { command: startCommand, envFile, interpolated } = resolveStartCommand(repo, profile, meta.startCommand ?? null);
        const env = await resolveStartEnv({ cwd, envFile, interpolated, worktreeEnv: meta.env ?? {} });
        await freePort(port, target);
        const shell = defaultShell();
        await app.deps.proc.start({
          key: target,
          cwd,
          command: shell,
          args: ['-ilc', startCommand],
          env,
          port,
        });
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
