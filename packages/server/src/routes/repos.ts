import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RepoConfigSchema } from '../repoConfig.js';
import { backfillCloneUrls } from '../services/repoBackfill.js';
import { detectRepo, uniqueRepoId } from '../services/repoDetect.js';
import { AppError } from '../errors.js';
import { githubProjectFromCloneUrl, runnerGitCredential } from '../services/runnerGitCredential.js';
import { ensureBareRepo, sandboxReposDir } from '../services/sandbox/bareRepo.js';
import { matchRepo } from '../services/repoIdentity.js';

const PortableRepoConfig = RepoConfigSchema.omit({ path: true, cloneUrl: true });

const DetectBody = z.object({ path: z.string().min(1) });
const CloneBody = z.object({
  url: z.string().min(1).max(2048),
  // Absolute target dir; omitted means <STRADO_REPOS_DIR|~/repos>/<name>.
  dest: z.string().min(1).max(4096).optional(),
  // Parent directory selected by the compact clone dialog. The repository
  // name derived from the URL is appended on the server.
  parent: z.string().min(1).max(4096).optional(),
  // A controller creating a worktree on a sandbox-capable runner already has
  // this machine-independent config. Supplying it lets the runner register a
  // hidden bare backing repository without first materialising a redundant
  // main checkout solely so detectRepo can rediscover the same values.
  config: PortableRepoConfig.optional(),
});
const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  parent: z.string().trim().min(1).max(4096).optional(),
});

export async function registerReposRoutes(app: FastifyInstance) {
  app.get('/repos', async (req) => {
    const store = req.workspace!.stores.repos;
    // Runs at most once per repo (the answer, including "no origin", is stored).
    // Recheck a previous null: an origin may have been added after the repo was
    // registered, and remote-runner creation depends on seeing that change.
    const repos = await backfillCloneUrls(store, await store.list(), { recheckNull: true });
    return { repos };
  });

  app.post('/repos/detect', async (req) => {
    const body = DetectBody.parse(req.body);
    const detected = await detectRepo(body.path);
    const existing = await req.workspace!.stores.repos.list();
    // Propose a free id rather than warning and making the user invent one.
    const unique = uniqueRepoId(detected.id, detected.path, new Set(existing.map((r) => r.id)));
    if (unique !== detected.id) {
      detected.warnings.push(`id "${detected.id}" is taken by another repo — using "${unique}" instead`);
      detected.id = unique;
    }
    return detected;
  });

  // Clone a repo onto THIS machine and register it in one step. The point of
  // the flow: a runner provisions repos itself (with its own credentials)
  // instead of the user SSHing in to clone by hand.
  app.post('/repos/clone', async (req, reply) => {
    const body = CloneBody.parse(req.body);
    const github = githubProjectFromCloneUrl(body.url);
    const credential = github
      ? await runnerGitCredential('github.com', github.projectPath, 'read')
      : null;
    const cloneUrl = credential && github ? github.httpsUrl : body.url;

    // Runner provisioning for sandboxed worktrees needs Git's object store,
    // not a second visible checkout of main. Keep the general clone endpoint's
    // old behavior unless both conditions prove this is that internal flow:
    // the caller supplied portable config AND this machine actually sandboxes.
    if (body.config && app.deps.sandbox) {
      const store = req.workspace!.stores.repos;
      const known = await store.list();
      const existing = matchRepo(
        body.url,
        known.map((repo) => ({ repo, cloneUrl: repo.cloneUrl })),
      );
      const repoId = existing?.id
        ?? uniqueRepoId(body.config.id, body.url, new Set(known.map((repo) => repo.id)));
      const bare = await ensureBareRepo({
        reposDir: sandboxReposDir(app.deps.homeStateDir),
        repoId,
        cloneUrl,
        credential: credential ? { username: credential.username, password: credential.token } : undefined,
      });
      if (existing) {
        return reply.code(200).send({
          repo: existing,
          warnings: [],
          alreadyRegistered: true,
          path: bare,
          backing: 'bare',
        });
      }
      const created = await store.add({
        ...body.config,
        id: repoId,
        path: bare,
        // Store the portable URL the runner can actually use, never a
        // controller-only SSH alias from the original RepoConfig.
        cloneUrl: body.url,
      });
      return reply.code(200).send({
        repo: created,
        warnings: [],
        alreadyRegistered: false,
        path: bare,
        backing: 'bare',
      });
    }

    const { cloneRepo } = await import('../services/repoClone.js');
    const cloned = await cloneRepo({
      url: cloneUrl,
      dest: body.dest,
      parent: body.parent,
      credential: credential ? { username: credential.username, password: credential.token } : undefined,
    });
    const detected = await detectRepo(cloned.path);
    const known = await req.workspace!.stores.repos.list();
    if (!known.some((r) => r.path === detected.path)) {
      detected.id = uniqueRepoId(detected.id, detected.path, new Set(known.map((r) => r.id)));
    }
    const { warnings, ...config } = detected;

    // Registering an already-known repo must not create a duplicate row.
    const existing = (await req.workspace!.stores.repos.list()).find(
      (r) => r.path === config.path || r.id === config.id,
    );
    if (existing) {
      return reply.code(200).send({ repo: existing, warnings, alreadyRegistered: true, path: cloned.path });
    }
    const created = await req.workspace!.stores.repos.add(config);
    return reply.code(200).send({ repo: created, warnings, alreadyRegistered: false, path: cloned.path });
  });

  app.post('/repos/create', async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const { createLocalRepo } = await import('../services/repoCreate.js');
    const createdProject = await createLocalRepo(body);
    const detected = await detectRepo(createdProject.path);
    const known = await req.workspace!.stores.repos.list();
    const existing = known.find((repo) => repo.path === detected.path);
    if (existing) {
      return reply.code(200).send({ repo: existing, path: detected.path, alreadyRegistered: true });
    }
    detected.id = uniqueRepoId(detected.id, detected.path, new Set(known.map((repo) => repo.id)));
    const { warnings: _warnings, ...config } = detected;
    const created = await req.workspace!.stores.repos.add(config);
    return reply.code(200).send({ repo: created, path: detected.path, alreadyRegistered: createdProject.alreadyPresent });
  });

  app.post('/repos', async (req, reply) => {
    let parsed;
    try {
      parsed = RepoConfigSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new AppError('VALIDATION', err.message, err.issues);
      }
      throw err;
    }
    const created = await req.workspace!.stores.repos.add(parsed);
    return reply.code(200).send(created);
  });

  app.patch<{ Params: { id: string } }>('/repos/:id', async (req) => {
    const patch = req.body as Record<string, unknown>;
    return req.workspace!.stores.repos.patch(req.params.id, patch);
  });

  app.delete<{ Params: { id: string } }>('/repos/:id', async (req, reply) => {
    await req.workspace!.stores.repos.remove(req.params.id);
    return reply.code(204).send();
  });
}
