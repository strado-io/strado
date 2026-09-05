import fsp from 'node:fs/promises';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildWorktreeSlug } from '../slug.js';
import { assertPathUnder } from '../paths.js';
import { findFreePort } from '../ports.js';
import { AppError } from '../errors.js';
import { detectNodeModules, NodeModulesStatus } from '../services/nodeModulesStatus.js';
import { findExternalProcesses, hasChildProcess } from '../services/externalProcess.js';
import { isLive, type ProcStatus } from '../services/processManager.js';
import { resolveProfile } from '../profile.js';
import { addGitExclude } from '../services/gitExclude.js';
import { stepReporter } from '../services/jobSteps.js';
import { detectSandboxManifest } from '../services/sandbox/detect.js';
import { ensureBaseImage } from '../services/sandbox/image.js';
import { addSandboxWorktree, bareRepoPath, ensureBareRepo, sandboxReposDir } from '../services/sandbox/bareRepo.js';
import { sandboxSlugFor } from '../services/sandbox/sandboxes.js';
import { hooksDir } from '../services/claudeHooks.js';
import { canonicalWorktreesDir, findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { claudeKey, codexKey, opencodeKey, piKey, sessionsPayload, shellKey } from '../services/terminalManager.js';
import { githubProjectFromCloneUrl, runnerGitCredential } from '../services/runnerGitCredential.js';
import { issueSandboxGitBrokerToken } from '../services/sandboxGitBroker.js';

export type WorktreeRow = {
  path: string;
  repoId: string | null;
  branch: string | null;
  head: string;
  prunable: boolean;
  tracked: boolean;
  meta: unknown;
  process: unknown;
  nodeModules: NodeModulesStatus;
  claudeStatus: 'idle' | 'working' | 'waiting' | undefined;
  claudeStatusById: Record<string, 'idle' | 'working' | 'waiting'>;
  codexStatus: 'idle' | 'working' | 'waiting' | undefined;
  codexStatusById: Record<string, 'idle' | 'working' | 'waiting'>;
  opencodeStatus: 'idle' | 'working' | 'waiting' | undefined;
  opencodeStatusById: Record<string, 'idle' | 'working' | 'waiting'>;
  piStatus: 'idle' | 'working' | 'waiting' | undefined;
  piStatusById: Record<string, 'idle' | 'working' | 'waiting'>;
  hasClaudeSession: boolean;
  hasCodexSession: boolean;
  hasOpencodeSession: boolean;
  hasPiSession: boolean;
  hasShellSession: boolean;
  shellSessions: string[];
  claudeSessions: string[];
  codexSessions: string[];
  opencodeSessions: string[];
  piSessions: string[];
  diffStats: { additions: number; deletions: number; files: number } | null;
  activitySeconds: number;
};

const CreateBody = z.object({
  repoId: z.string(),
  ticketId: z.string(),
  title: z.string().min(1),
  sourceBranch: z.string().min(1),
  sourceWorktree: z.string().min(1),
  port: z.number().int().positive().nullable().optional(),
  env: z.record(z.string()).optional(),
  ticketProvider: z.enum(['jira', 'linear']).optional(),
  // Env for the CONTAINER (an --env-file), separate from `env` which the host
  // process manager uses. Bounded and key-constrained because it is written to
  // a file verbatim: rejecting here is a 400 the caller can read, instead of a
  // job that dies halfway through creating a worktree.
  sandboxEnv: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096))
    .refine((o) => Object.keys(o).length <= 20, 'sandboxEnv accepts at most 20 keys')
    .optional(),
});

export async function registerWorktreesRoutes(app: FastifyInstance) {
  /**
   * The repo's bare clone, if it has one — the second place its worktrees can
   * live. Sandboxed worktrees are registered in `<home>/sandbox/repos/<id>.git`
   * and are invisible to `git worktree list` on the normal clone, so every
   * caller that enumerates or removes worktrees has to ask here too.
   *
   * realpath doubles as the existence probe AND makes the answer comparable to
   * the canonical paths git writes into worktree pointer files.
   */
  async function bareRepoFor(repoId: string): Promise<string | null> {
    const p = bareRepoPath(sandboxReposDir(app.deps.homeStateDir), repoId);
    return fsp.realpath(p).then(
      (resolved) => resolved,
      () => null,
    );
  }

  // Worktree state is useful metadata, but Git remains the authority for which
  // repository owns a checkout. In particular, a sandbox container can be
  // removed before `git worktree remove` succeeds; that deliberately clears
  // meta.sandbox, while the checkout is still registered in the bare clone.
  // A retry must therefore inspect both repositories instead of falling back
  // to the normal clone solely because the sandbox metadata is gone.
  async function gitOwnerOfWorktree(
    repoPath: string,
    repoId: string,
    target: string,
  ): Promise<{ repoPath: string; bare: boolean } | null> {
    const bare = await bareRepoFor(repoId);
    const sameAsBare = bare !== null && path.resolve(repoPath) === path.resolve(bare);
    const candidates = sameAsBare
      ? [{ repoPath: bare, bare: true }]
      : [
          { repoPath, bare: false },
          ...(bare ? [{ repoPath: bare, bare: true }] : []),
        ];
    const normalizedTarget = path.resolve(target);
    const lists = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      worktrees: await app.deps.git.list(candidate.repoPath).catch(() => []),
    })));
    return lists.find(({ worktrees }) =>
      worktrees.some((worktree) => path.resolve(worktree.path) === normalizedTarget))?.candidate ?? null;
  }

  app.get('/worktrees', async (req) => {
    const { repos, state } = req.workspace!.stores;
    const repoList = await repos.list();
    const stateEntries = await state.list();
    const stateByPath = new Map(stateEntries.map((e) => [e.path, e.meta]));

    const live = app.deps.terminal.liveSessions();
    const liveByPath = new Map<string, typeof live>();
    for (const s of live) {
      const list = liveByPath.get(s.path) ?? [];
      list.push(s);
      liveByPath.set(s.path, list);
    }
    const sessionsOf = (p: string) => sessionsPayload(liveByPath.get(p) ?? []);

    // List every repo's worktrees in parallel — each `git worktree list` is an
    // independent subprocess. One broken repo (bad path, not a git repo yet)
    // must not take down the whole dashboard, so a failure just drops that repo.
    const perRepo = await Promise.all(
      repoList.map(async (repo) => {
        try {
          // Two possible homes for one repo's worktrees: the normal clone, and
          // the bare clone sandboxed ones hang off. Both are listed and merged,
          // so a sandboxed worktree is an ordinary row in the sidebar — the
          // sandbox is a property of a worktree, not a separate list.
          const bare = await bareRepoFor(repo.id);
          const repoPathIsBare = bare !== null && path.resolve(repo.path) === path.resolve(bare);
          const [normal, sandboxed] = await Promise.all([
            repoPathIsBare ? Promise.resolve([]) : app.deps.git.list(repo.path),
            bare
              ? app.deps.git.list(bare).catch((err) => {
                  req.log.warn({ repoId: repo.id, bare, err }, 'skipping bare repo: git worktree list failed');
                  return [];
                })
              : Promise.resolve([]),
          ]);
          const seen = new Set<string>();
          const list = [...normal, ...sandboxed].filter((w) => {
            // A bare repo reports ITSELF as its main worktree; it is a git dir,
            // not a checkout, and must never become a row.
            if (w.path === bare) return false;
            if (seen.has(w.path)) return false;
            // Only rows the app can actually operate on: the checkout itself
            // plus worktrees under this repo's allowed roots — the SAME
            // predicate terminal/diff/delete enforce. Agents create worktrees
            // in arbitrary places (~/.claude, <repo>.worktree, …); git lists
            // them all, but a row whose every action would be refused with
            // "no repo owns <path>" is a dead row wearing a live badge.
            if (!findOwningRepo([repo], w.path, app.deps.homeStateDir, { includeRepoRoot: true })) return false;
            seen.add(w.path);
            return true;
          });
          return { repo, list };
        } catch (err) {
          req.log.warn({ repoId: repo.id, path: repo.path, err }, 'skipping repo: git worktree list failed');
          return null;
        }
      }),
    );

    const flat = perRepo
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .flatMap((e) => e.list.map((w) => ({ repo: e.repo, w })));

    // Per-worktree node_modules + diff stats are independent read-only probes;
    // fan them all out at once instead of awaiting each in a chain. Promise.all
    // preserves order, so rows keep their original repo/worktree ordering.
    const rows: WorktreeRow[] = await Promise.all(
      flat.map(async ({ repo, w }) => {
        const [nodeModules, diffStats] = await Promise.all([
          detectNodeModules(w.path, repo.projectSubdir),
          app.deps.gitChanges.shortStat(w.path),
        ]);
        let meta = stateByPath.get(w.path) ?? null;
        // Auto-adopt the repo's main worktree (the repo root) so its Settings
        // work without a manual Adopt step — Strado owns the repo, so it owns
        // its primary worktree. Empty ticketId marks it as "no ticket" (the
        // label falls back to the branch); port stays null so start uses the
        // repo's defaultPort.
        if (meta === null && w.path === repo.path) {
          meta = {
            repoId: repo.id,
            ticketId: '',
            title: repo.name,
            linkedFrom: null,
            linkedAt: null,
            port: null,
            env: {},
            lastStartedAt: null,
          };
          await state.upsert(w.path, meta);
        }
        return {
          path: w.path,
          repoId: repo.id,
          branch: w.branch,
          head: w.head,
          prunable: w.prunable,
          tracked: meta !== null,
          meta,
          process: app.deps.proc.status(w.path),
          nodeModules,
          claudeStatus: app.deps.claudeStatus.get(w.path),
          claudeStatusById: app.deps.claudeStatus.sessions(w.path),
          codexStatus: app.deps.codexStatus.get(w.path),
          codexStatusById: app.deps.codexStatus.sessions(w.path),
          opencodeStatus: app.deps.opencodeStatus.get(w.path),
          opencodeStatusById: app.deps.opencodeStatus.sessions(w.path),
          piStatus: app.deps.piStatus.get(w.path),
          piStatusById: app.deps.piStatus.sessions(w.path),
          ...sessionsOf(w.path),
          diffStats,
          activitySeconds: app.deps.activity.get(w.path),
        };
      }),
    );

    // Keep the file-save watcher covering every known worktree; additive, so
    // listing one workspace never drops another workspace's watchers.
    app.deps.activityWatch.ensure(rows.map((r) => r.path));

    // Dev servers started outside Strado (an agent's `npm run dev`, say).
    // Knowing each worktree's configured port lets the probe pick the app
    // port over HMR/inspector side channels; our own HTTP and CDP ports can
    // never be a worktree's dev server.
    const profile = resolveProfile();
    const probeTargets = flat.map(({ repo, w }, i) => ({
      worktreePath: w.path,
      projectSubdir: repo.projectSubdir,
      port: (rows[i]?.meta as { port?: number | null } | null)?.port ?? repo.defaultPort ?? null,
    }));
    const external = await findExternalProcesses(probeTargets, app.deps.proc.ownedPids(), {
      ignorePorts: new Set([profile.port, profile.cdpPort]),
    });
    for (const row of rows) {
      const hit = external.get(row.path);
      if (!hit) continue;
      const proc = row.process as { status?: ProcStatus };
      // A managed process that is up, coming up or on its way down owns the
      // row — re-detecting a stopping server as "external" would make Stop
      // look like it did nothing.
      if (proc?.status && isLive(proc.status)) continue;
      row.process = {
        status: 'running',
        pid: hit.pid,
        startedAt: null,
        port: hit.port,
        detectedUrl: null,
        exitCode: null,
        external: true,
      };
    }

    return { worktrees: rows };
  });

  app.post('/worktrees', async (req, reply) => {
    const { repos, state } = req.workspace!.stores;
    const body = CreateBody.parse(req.body);
    const repo = await repos.get(body.repoId);
    if (!repo) throw new AppError('NOT_FOUND', `repo ${body.repoId} not found`);

    const reservedPorts = new Set(
      (await state.list())
        .map((e) => e.meta.port)
        .filter((p): p is number => typeof p === 'number'),
    );
    const port = body.port
      ?? (repo.fixedPort ? repo.defaultPort : await findFreePort(repo.defaultPort, reservedPorts));

    // Sandboxing is all-or-nothing per install: non-null only on a runner with
    // a container runtime. Captured once so every branch below reads the same
    // decision, and so TypeScript keeps the narrowing inside the job.
    const sandbox = app.deps.sandbox;
    const sandboxRuntime = app.deps.sandboxRuntime;
    const sandboxed = sandbox !== null && sandboxRuntime !== null;

    const job = app.deps.jobs.start('worktree.create', async (ctx) => {
      // Same step ids as a remote create, so the dialog renders one way and a
      // runner's forwarded steps land on the right lines. The sandbox lines are
      // APPENDED, never inserted, so an unsandboxed install sees exactly the
      // three steps it always has.
      const step = stepReporter(ctx, [
        { id: 'worktree', label: 'Creating git worktree' },
        { id: 'link', label: 'Linking node_modules' },
        { id: 'finalize', label: 'Finalizing' },
        ...(sandboxed
          ? [
              { id: 'sandbox-detect', label: 'Detecting sandbox deps' },
              { id: 'sandbox-build', label: 'Building sandbox' },
            ]
          : []),
      ]);
      const slug = buildWorktreeSlug(body.ticketId, body.title);
      // Always the canonical location — computed, never stored, so ownership
      // checks answer from the repo id alone.
      let worktreesDir = canonicalWorktreesDir(app.deps.homeStateDir, repo.id);
      if (sandboxed) {
        // The container bind-mounts the worktree at its OWN absolute path, and
        // git's pointer file inside it is canonical. A root reached through a
        // symlink would name a path the container never mounted, so resolve it
        // BEFORE anything derives from it. (If STRADO_HOME itself sits behind a
        // symlink this diverges from the computed canonical root — a real
        // ~/.strado never does.)
        await fsp.mkdir(worktreesDir, { recursive: true });
        worktreesDir = await fsp.realpath(worktreesDir);
      }
      const targetWorktree = path.join(worktreesDir, slug);
      assertPathUnder(targetWorktree, [worktreesDir]);

      step('worktree');
      // `git worktree add` will not create missing parent directories, so the
      // FIRST worktree under a fresh root (a new ~/.strado/worktrees/<repo>)
      // fails without this.
      await fsp.mkdir(worktreesDir, { recursive: true });
      if (sandboxed) {
        // Sandboxed worktrees hang off ONE bare clone per repo instead of the
        // developer's normal checkout: the container has to mount the git dir
        // too, and mounting a whole clone (with every other worktree in it)
        // would defeat the isolation. Existing normal clones are untouched.
        const github = repo.cloneUrl ? githubProjectFromCloneUrl(repo.cloneUrl) : null;
        const githubCredential = github
          ? await runnerGitCredential('github.com', github.projectPath, 'read')
          : null;
        const bareRepo = await ensureBareRepo({
          reposDir: sandboxReposDir(app.deps.homeStateDir),
          repoId: repo.id,
          // A repo registered from a local path has no remote; the clone itself
          // is a perfectly good origin to bare-clone from.
          cloneUrl: githubCredential && github ? github.httpsUrl : repo.cloneUrl ?? repo.path,
          credential: githubCredential
            ? { username: githubCredential.username, password: githubCredential.token }
            : undefined,
        });
        await addSandboxWorktree({
          bareRepo,
          targetPath: targetWorktree,
          branch: slug,
          sourceBranch: body.sourceBranch,
        });
      } else {
        await app.deps.git.create({
          repoPath: repo.path,
          branch: slug,
          sourceBranch: body.sourceBranch,
          targetPath: targetWorktree,
        });
      }

      const projectSubdir = repo.projectSubdir;
      const targetProjectDir = projectSubdir
        ? path.join(targetWorktree, projectSubdir)
        : targetWorktree;
      const sourceProjectDir = projectSubdir
        ? path.join(body.sourceWorktree, projectSubdir)
        : body.sourceWorktree;

      step('link');
      let linkedFrom: string | null = null;
      let linkedAt: string | null = null;
      let linkWarnings: string[] = [];
      if (sandboxed) {
        // The sandbox mounts the new worktree and its bare git directory only.
        // A symlink to the runner's source checkout would therefore be broken
        // inside the container, and host-built native modules may be ABI-
        // incompatible anyway. Dependencies belong to the isolated worktree.
        linkWarnings = ['NODE_MODULES_ISOLATED'];
        step.detail('skipped — install dependencies inside the sandbox');
      } else {
        try {
          const link = await app.deps.link.link({
            sourceProjectDir,
            targetProjectDir,
            replace: false,
          });
          linkedFrom = body.sourceWorktree;
          linkedAt = new Date().toISOString();
          linkWarnings = link.warnings;
        } catch (err) {
          if (!(err instanceof AppError) || err.code !== 'SOURCE_MISSING') throw err;
          // A freshly cloned runner repo normally has no node_modules yet.
          // Reusing dependencies is an optimization, not a prerequisite for a
          // valid git worktree, so leave it unlinked and let the user/agent run
          // the repository's normal install command there.
          linkWarnings = ['SOURCE_NODE_MODULES_MISSING'];
          step.detail('skipped — source has no node_modules; install dependencies in this worktree');
        }
      }

      step('finalize');
      await state.upsert(targetWorktree, {
        repoId: repo.id,
        ticketId: body.ticketId,
        title: body.title,
        linkedFrom,
        linkedAt,
        port,
        env: body.env ?? {},
        lastStartedAt: null,
        ticketProvider: body.ticketProvider ?? null,
        sandbox: null,
      });

      // Announced BEFORE the sandbox steps: from here on the worktree exists
      // and is usable, so a sandbox failure must not hide it from the UI.
      app.deps.bus.emit('worktrees', {
        type: 'worktree.updated',
        data: { path: targetWorktree, warnings: linkWarnings },
      });
      app.deps.debugLog.log('server', `worktree created: ${targetWorktree}${linkWarnings.length ? ` (warnings: ${linkWarnings.join('; ')})` : ''}`);

      if (sandbox && sandboxRuntime) {
        step('sandbox-detect');
        // The PROJECT dir, not the worktree root: in a monorepo the root has no
        // .nvmrc or engines and the app subdir does, so reading the root builds
        // an image the project cannot run on.
        const manifest = await detectSandboxManifest(targetProjectDir);

        step('sandbox-build');
        // Attached to the build step, which takes minutes — on the detect step
        // this would be on screen for the milliseconds detection takes. What we
        // detected has to be visible: "wrong node version" is the failure mode,
        // and guessing silently makes it unanswerable.
        step.detail(`sandbox: ${manifest.summary}`);
        app.deps.debugLog.log('server', `sandbox detect ${targetWorktree}: ${manifest.summary}`);
        // Container and env-file identity, which is NOT the worktree slug:
        // ticket+title repeats across repos, container names are global.
        const sandboxSlug = sandboxSlugFor(slug, targetWorktree);
        try {
          const image = await ensureBaseImage(sandboxRuntime, { node: manifest.node });
          // A previous attempt that died after `create` left the container
          // behind (we never tear down on failure, by design), so a retry would
          // collide on the name. Remove it — but only after proving it is this
          // worktree's: `rm -f` on someone else's running container destroys
          // work, and a name is not proof. The label is.
          if ((await sandbox.status(sandboxSlug)) !== 'absent') {
            const owner = await sandbox.worktreeOf(sandboxSlug);
            if (owner !== targetWorktree) {
              throw new AppError(
                'SANDBOX_CONFLICT',
                `container ${sandbox.containerName(sandboxSlug)} belongs to ${owner ?? 'an unlabelled worktree'}, not ${targetWorktree} — refusing to remove it`,
              );
            }
            await sandbox.remove(sandboxSlug);
          }
          let sandboxEnv = { ...(body.sandboxEnv ?? {}) };
          const github = repo.cloneUrl ? githubProjectFromCloneUrl(repo.cloneUrl) : null;
          if (github && app.deps.sandboxSocketPath && !sandboxEnv.GITHUB_TOKEN) {
            const brokerToken = await issueSandboxGitBrokerToken(targetWorktree, github.projectPath);
            if (brokerToken) {
              sandboxEnv = {
                ...sandboxEnv,
                GIT_ASKPASS: '/usr/local/bin/strado-askpass',
                GIT_HTTP_USER: 'x-access-token',
                STRADO_GIT_BROKER_TOKEN: brokerToken,
              };
            }
          }
          await sandbox.create({
            worktreePath: targetWorktree,
            slug: sandboxSlug,
            image,
            port,
            env: sandboxEnv,
            socketPath: app.deps.sandboxSocketPath,
            // The claude/codex hook scripts, mounted at the same absolute
            // path inside: installClaudeHooks writes the HOST path into the
            // worktree's settings, and the container runs that exact command.
            hooksPath: hooksDir(),
          });
          await sandbox.start(sandboxSlug);
          // Only now: the flag means "a container exists", and terminals are
          // routed into it on the strength of it.
          await state.patch(targetWorktree, { sandbox: { slug: sandboxSlug } });
          // The synchronous face of that flag, for terminal spawning. Written
          // beside the state patch and from the same value — never recomputed.
          app.deps.sandboxSlugs.set(targetWorktree, sandboxSlug);
          app.deps.bus.emit('worktrees', {
            type: 'worktree.updated',
            data: { path: targetWorktree },
          });
        } catch (err) {
          // Deliberately no teardown: the half-built container and its env file
          // are the only evidence of WHY this failed. The worktree itself is
          // fine — it just runs unsandboxed until this is retried.
          app.deps.debugLog.log('server', `sandbox build failed for ${targetWorktree}: ${String(err)}`);
          throw err;
        }
      }

      return { path: targetWorktree, warnings: linkWarnings, port };
    });

    return reply.code(202).send({ jobId: job.id });
  });

  app.delete<{ Params: { encodedPath: string }; Querystring: { force?: string; deleteBranch?: string } }>(
    '/worktrees/:encodedPath',
    async (req, reply) => {
      const { repos, state } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const allRepos = await repos.list();
      const repo = findOwningRepo(allRepos, target, app.deps.homeStateDir);
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, worktreeRootsFor(app.deps.homeStateDir, repo));

      const job = app.deps.jobs.start('worktree.delete', async (ctx) => {
        // Same ids a remote delete declares, so a runner's forwarded steps land
        // on the right lines.
        const step = stepReporter(ctx, [
          { id: 'stop', label: 'Stopping processes' },
          { id: 'unlink', label: 'Unlinking node_modules' },
          { id: 'remove', label: 'Removing worktree' },
        ]);
        // A sandboxed worktree is registered in the repo's BARE clone. Resolve
        // ownership from Git itself so retries still work after a partial
        // delete has cleared the sandbox metadata.
        const savedState = await state.get(target);
        const gitOwner = await gitOwnerOfWorktree(repo.path, repo.id, target);
        const targetExists = await fsp.lstat(target).then(() => true, () => false);
        if (!gitOwner && targetExists) {
          step('remove');
          throw new AppError(
            'SHELL_FAILED',
            `could not remove worktree: ${target} exists but is not registered in either the normal or sandbox Git repository`,
          );
        }
        const bare = await bareRepoFor(repo.id);
        const gitRepoPath = gitOwner?.repoPath
          ?? (savedState?.sandbox?.slug && bare ? bare : repo.path);
        // If the state was cleared by an earlier partial delete, the bare-repo
        // ownership is enough to recover the deterministic container slug and
        // finish any remaining cleanup safely.
        const sandboxSlug = savedState?.sandbox?.slug
          ?? (gitOwner?.bare ? sandboxSlugFor(path.basename(target), target) : null);

        step('stop');
        await app.deps.proc.stop(target);
        app.deps.terminal.killUnder(target);
        if (sandboxSlug && app.deps.sandbox) {
          // Same rule as creation: destroy only what is provably this
          // worktree's. The slug is path-derived so a mismatch should be
          // impossible — but if it ever happens, deleting one worktree must
          // not kill another's container. Logged and skipped rather than
          // thrown: the user asked to delete THIS worktree, and a container
          // inconsistency is no reason to refuse.
          const owner = await app.deps.sandbox.worktreeOf(sandboxSlug);
          if (owner === null || owner === target) {
            await app.deps.sandbox.stop(sandboxSlug);
            await app.deps.sandbox.remove(sandboxSlug);
            // The container is gone as of this line, but the rest of the
            // delete can still fail (a dirty worktree makes `git worktree
            // remove` throw). Give up the sandbox identity NOW: left behind,
            // it points every terminal in this worktree at a container that
            // no longer exists, and the next boot re-hydrates the dead slug
            // from state.
            // A create can fail after `git worktree add` but before the
            // finalize step writes state. Such an orphan is still a valid
            // bare-repo worktree and must remain deletable; there is simply no
            // persisted sandbox identity to clear in that case.
            if (savedState) await state.patch(target, { sandbox: null });
            app.deps.sandboxSlugs.delete(target);
          } else {
            app.deps.debugLog.log('server', `sandbox ${sandboxSlug} is labelled for ${owner}, not ${target}; leaving it alone`);
          }
        }

        step('unlink');
        const projectDir = repo.projectSubdir ? path.join(target, repo.projectSubdir) : target;
        if (targetExists) {
          await app.deps.link.unlink(projectDir).catch((err) => {
            if (err.code !== 'NOT_SYMLINK') throw err;
          });
        }

        step('remove');
        if (gitOwner) {
          await app.deps.git.remove({
            repoPath: gitRepoPath,
            targetPath: target,
            force: req.query.force === '1',
          });
        }
        if (sandboxSlug && app.deps.sandbox) {
          // The env file outlives the container it was written for; left behind
          // it would be handed to whatever next claims this slug.
          await fsp.rm(app.deps.sandbox.envFilePath(sandboxSlug), { force: true });
        }

        if (req.query.deleteBranch === '1' && gitOwner) {
          const meta = await state.get(target);
          const branch =
            meta?.title ? buildWorktreeSlug(meta.ticketId ?? '', meta.title) : null;
          if (branch) await app.deps.git.deleteBranch(gitRepoPath, branch).catch(() => undefined);
        }

        await state.remove(target);
        // Unconditional: a path that no longer exists must not keep routing
        // terminals into a container that was just removed, and re-creating
        // the same worktree would otherwise inherit a stale slug.
        app.deps.sandboxSlugs.delete(target);
        app.deps.activity.remove(target);
        app.deps.activityWatch.remove(target);
        // Worktree paths are deterministic (buildWorktreeSlug(ticketId, title)),
        // so recreating a worktree for the same ticket/title lands at this
        // IDENTICAL path — a leaked stale timestamp would make the new
        // sandbox read old (already-idle) activity instead of null,
        // defeating the "just created is never parked on first sight"
        // guarantee in park.ts.
        app.deps.forgetSandboxActivity(target);
        app.deps.bus.emit('worktrees', { type: 'worktree.updated', data: { path: target, removed: true } });
        app.deps.debugLog.log('server', `worktree removed: ${target}`);
        return { path: target };
      });
      return reply.code(202).send({ jobId: job.id });
    },
  );

  // Is a command currently running in this session's pty? Used to warn before
  // closing a busy shell tab.
  app.get<{ Params: { encodedPath: string; mode: string }; Querystring: { id?: string } }>(
    '/worktrees/:encodedPath/sessions/:mode/busy',
    async (req) => {
      const { repos } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const mode =
        req.params.mode === 'shell' ? 'shell'
        : req.params.mode === 'codex' ? 'codex'
        : req.params.mode === 'opencode' ? 'opencode'
        : req.params.mode === 'pi' ? 'pi'
        : 'claude';
      const id = /^\d+$/.test(req.query.id ?? '') ? req.query.id! : '1';
      const allRepos = await repos.list();
      const repo = findOwningRepo(allRepos, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
      const key =
        mode === 'shell' ? shellKey(target, id)
        : mode === 'codex' ? codexKey(target, id)
        : mode === 'opencode' ? opencodeKey(target, id)
        : mode === 'pi' ? piKey(target, id)
        : claudeKey(target, id);
      const info = app.deps.terminal.status(key);
      const busy =
        info.status === 'running' && info.pid != null ? await hasChildProcess(info.pid) : false;
      return { busy };
    },
  );

  app.delete<{ Params: { encodedPath: string; mode: string }; Querystring: { id?: string } }>(
    '/worktrees/:encodedPath/sessions/:mode',
    async (req, reply) => {
      const { repos } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const mode =
        req.params.mode === 'shell' ? 'shell'
        : req.params.mode === 'codex' ? 'codex'
        : req.params.mode === 'opencode' ? 'opencode'
        : req.params.mode === 'pi' ? 'pi'
        : 'claude';
      const id = /^\d+$/.test(req.query.id ?? '') ? req.query.id! : '1';
      const allRepos = await repos.list();
      const repo = findOwningRepo(allRepos, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);

      app.deps.terminal.kill(
        mode === 'shell' ? shellKey(target, id)
        : mode === 'codex' ? codexKey(target, id)
        : mode === 'opencode' ? opencodeKey(target, id)
        : mode === 'pi' ? piKey(target, id)
        : claudeKey(target, id),
      );
      if (mode === 'claude') app.deps.claudeStatus.clear(target, id);
      if (mode === 'codex') app.deps.codexStatus.clear(target, id);
      if (mode === 'opencode') app.deps.opencodeStatus.clear(target, id);
      if (mode === 'pi') app.deps.piStatus.clear(target, id);

      // pty death is async; report the killed session as gone immediately.
      const live = app.deps.terminal
        .liveSessions()
        .filter((s) => s.path === target && !(s.mode === mode && s.id === id));
      app.deps.bus.emit('worktrees', {
        type: 'worktree.updated',
        data: { path: target, ...sessionsPayload(live) },
      });
      return reply.code(204).send();
    },
  );

  const PatchBody = z.object({
    port: z.number().int().positive().optional(),
    env: z.record(z.string()).optional(),
    title: z.string().optional(),
    workflowStatus: z
      .enum(['todo', 'in_progress', 'ready_for_qa', 'retest_failed', 'verified', 'done'])
      .nullable()
      .optional(),
    note: z.string().nullable().optional(),
    order: z.number().nullable().optional(),
    ticketId: z.string().min(1).optional(),
    startCommand: z.string().nullable().optional(),
    previewUrl: z.string().nullable().optional(),
  });

  app.patch<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath', async (req) => {
    const { repos, state } = req.workspace!.stores;
    const target = decodeURIComponent(req.params.encodedPath);
    const body = PatchBody.parse(req.body);
    const assignsMembership =
      body.workflowStatus !== undefined ||
      body.note !== undefined ||
      body.order !== undefined;
    if (assignsMembership && (await state.get(target)) === null) {
      const repoList = await repos.list();
      const owningRepo = repoList.find(
        (r) => r.path === target || worktreeRootsFor(app.deps.homeStateDir, r).some((root) => target.startsWith(root + path.sep)),
      );
      if (!owningRepo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      const basename = path.basename(target);
      const ticketMatch = basename.match(/^([A-Za-z]+-\d+)/);
      const ticketId = ticketMatch?.[1] ?? basename;
      await state.upsert(target, {
        repoId: owningRepo.id,
        ticketId,
        title: basename,
        linkedFrom: null,
        linkedAt: null,
        port: null,
        env: {},
        lastStartedAt: null,
      });
    }
    const updated = await state.patch(target, body);
    app.deps.bus.emit('worktrees', { type: 'worktree.updated', data: { path: target, meta: updated } });
    return updated;
  });

  const AdoptBody = z.object({
    repoId: z.string(),
    ticketId: z.string(),
    title: z.string().min(1),
    port: z.number().int().positive().optional(),
    env: z.record(z.string()).optional(),
  });

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/adopt',
    async (req) => {
      const { repos, state } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const body = AdoptBody.parse(req.body);
      const repo = await repos.get(body.repoId);
      if (!repo) throw new AppError('NOT_FOUND', `repo ${body.repoId} not found`);
      const reserved = new Set(
        (await state.list()).map((e) => e.meta.port).filter((p): p is number => typeof p === 'number'),
      );
      const port = body.port
        ?? (repo.fixedPort ? repo.defaultPort : await findFreePort(repo.defaultPort, reserved));
      await state.upsert(target, {
        repoId: body.repoId,
        ticketId: body.ticketId,
        title: body.title,
        linkedFrom: null,
        linkedAt: null,
        port,
        env: body.env ?? {},
        lastStartedAt: null,
      });
      app.deps.bus.emit('worktrees', { type: 'worktree.updated', data: { path: target } });
      return { path: target, port };
    },
  );

  const UploadBody = z.object({
    name: z.string().min(1),
    dataBase64: z.string().min(1),
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/upload', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const { repos } = req.workspace!.stores;
    const target = decodeURIComponent(req.params.encodedPath);
    const body = UploadBody.parse(req.body);
    const repoList = await repos.list();
    const owningRepo = repoList.find(
      (r) => r.path === target || worktreeRootsFor(app.deps.homeStateDir, r).some((root) => target.startsWith(root + path.sep)),
    );
    if (!owningRepo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
    assertPathUnder(target, [owningRepo.path, ...worktreeRootsFor(app.deps.homeStateDir, owningRepo)]);
    const bytes = Buffer.from(body.dataBase64, 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new AppError('VALIDATION', 'file exceeds 10MB');
    const safeName = path.basename(body.name).replace(/[^A-Za-z0-9._-]/g, '_');
    const dir = path.join(target, '.strado-uploads');
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${Date.now()}-${safeName}`);
    await fsp.writeFile(filePath, bytes);
    await addGitExclude(target, '.strado-uploads/');
    return reply.code(200).send({ path: filePath });
  });
}
