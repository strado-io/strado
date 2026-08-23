import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertPathUnder } from '../paths.js';
import { AppError } from '../errors.js';

const FileBody = z.object({ file: z.string().min(1) });
const HunkBody = z.object({ patch: z.string().min(1), reverse: z.boolean().optional() });
const CommitBody = z.object({ message: z.string().min(1) });
const RemoteBody = z.object({ remote: z.string().min(1) });
const PullBody = z.object({ source: z.string().min(1) });
const DiffQuery = z.object({
  file: z.string().min(1),
  scope: z.enum(['unstaged', 'staged', 'branch']),
  base: z.string().min(1).optional(),
});
const BranchChangesQuery = z.object({ base: z.string().min(1).optional() });
const Hash = z.string().regex(/^[0-9a-f]{4,40}$/i);
const LogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  q: z.string().min(1).max(200).optional(),
});
const CommitQuery = z.object({ hash: Hash });
const CommitDiffQuery = z.object({ hash: Hash, file: z.string().min(1) });

export async function registerGitChangesRoutes(app: FastifyInstance) {
  async function resolveTarget(req: any): Promise<string> {
    const { repos } = req.workspace!.stores;
    const target = decodeURIComponent(req.params.encodedPath);
    const allRepos = await repos.list();
    const repo = findOwningRepo(allRepos, target, app.deps.homeStateDir, { includeRepoRoot: true });
    if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
    assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
    return target;
  }

  app.get<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/changes', async (req) => {
    return app.deps.gitChanges.listWorktreeChanges(await resolveTarget(req));
  });

  app.get<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/branches', async (req) => {
    return app.deps.gitChanges.listBranches(await resolveTarget(req));
  });

  app.get<{ Params: { encodedPath: string }; Querystring: { base?: string } }>(
    '/worktrees/:encodedPath/git/branch-changes',
    async (req) => {
      const q = BranchChangesQuery.parse(req.query);
      return app.deps.gitChanges.listBranchChanges(await resolveTarget(req), q.base);
    },
  );

  app.get<{ Params: { encodedPath: string }; Querystring: { file?: string; scope?: string } }>(
    '/worktrees/:encodedPath/git/diff',
    async (req) => {
      const q = DiffQuery.parse(req.query);
      return app.deps.gitChanges.fileDiff(await resolveTarget(req), q.file, q.scope, q.base);
    },
  );

  app.get<{ Params: { encodedPath: string }; Querystring: { limit?: string; q?: string } }>(
    '/worktrees/:encodedPath/git/log',
    async (req) => {
      const { limit, q } = LogQuery.parse(req.query);
      return app.deps.gitChanges.log(await resolveTarget(req), limit, q);
    },
  );

  app.get<{ Params: { encodedPath: string }; Querystring: { hash?: string } }>(
    '/worktrees/:encodedPath/git/commit-info',
    async (req) => {
      const { hash } = CommitQuery.parse(req.query);
      return app.deps.gitChanges.commitInfo(await resolveTarget(req), hash);
    },
  );

  app.get<{ Params: { encodedPath: string }; Querystring: { hash?: string; file?: string } }>(
    '/worktrees/:encodedPath/git/commit-diff',
    async (req) => {
      const { hash, file } = CommitDiffQuery.parse(req.query);
      return app.deps.gitChanges.commitFileDiff(await resolveTarget(req), hash, file);
    },
  );

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/stage', async (req, reply) => {
    const { file } = FileBody.parse(req.body);
    await app.deps.gitChanges.stageFile(await resolveTarget(req), file);
    return reply.code(204).send();
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/unstage', async (req, reply) => {
    const { file } = FileBody.parse(req.body);
    await app.deps.gitChanges.unstageFile(await resolveTarget(req), file);
    return reply.code(204).send();
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/discard', async (req, reply) => {
    const { file } = FileBody.parse(req.body);
    await app.deps.gitChanges.discardFile(await resolveTarget(req), file);
    return reply.code(204).send();
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/stage-all', async (req, reply) => {
    await app.deps.gitChanges.stageAll(await resolveTarget(req));
    return reply.code(204).send();
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/unstage-all', async (req, reply) => {
    await app.deps.gitChanges.unstageAll(await resolveTarget(req));
    return reply.code(204).send();
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/discard-all', async (req, reply) => {
    await app.deps.gitChanges.discardAll(await resolveTarget(req));
    return reply.code(204).send();
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/stage-hunk', async (req, reply) => {
    const { patch, reverse } = HunkBody.parse(req.body);
    await app.deps.gitChanges.applyHunk(await resolveTarget(req), patch, reverse ?? false);
    return reply.code(204).send();
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/discard-hunk', async (req, reply) => {
    const { patch } = HunkBody.parse(req.body);
    await app.deps.gitChanges.discardHunk(await resolveTarget(req), patch);
    return reply.code(204).send();
  });

  app.get<{ Params: { encodedPath: string }; Querystring: { target?: string } }>(
    '/worktrees/:encodedPath/git/mr-url',
    async (req) => {
      const target = z.string().min(1).parse(req.query.target);
      return app.deps.gitChanges.mergeRequestUrl(await resolveTarget(req), target);
    },
  );

  app.get<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/remotes', async (req) => {
    return app.deps.gitChanges.listRemotes(await resolveTarget(req));
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/push', async (req) => {
    const { remote } = RemoteBody.parse(req.body);
    return app.deps.gitChanges.push(await resolveTarget(req), remote);
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/pull', async (req) => {
    const { source } = PullBody.parse(req.body);
    return app.deps.gitChanges.pull(await resolveTarget(req), source);
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/git/commit', async (req) => {
    const { message } = CommitBody.parse(req.body);
    return app.deps.gitChanges.commit(await resolveTarget(req), message);
  });
}
