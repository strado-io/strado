import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertPathUnder } from '../paths.js';
import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { AppError } from '../errors.js';
import { listMarkdownFiles, readMarkdownFile } from '../services/markdownIndex.js';

const FileQuery = z.object({ file: z.string().min(1) });

export function parseKbFileQuery(query: unknown): { file: string } {
  return FileQuery.parse(query);
}

export async function registerKnowledgeBaseRoutes(app: FastifyInstance) {
  // Same shape as routes/gitChanges.ts:26 — repo ownership first, then
  // assertPathUnder — so an :encodedPath can't be aimed outside a known repo.
  async function resolveTarget(req: any): Promise<string> {
    const { repos } = req.workspace!.stores;
    const target = decodeURIComponent(req.params.encodedPath);
    const allRepos = await repos.list();
    const repo = findOwningRepo(allRepos as any, target, app.deps.homeStateDir, { includeRepoRoot: true });
    if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
    assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
    return target;
  }

  // assertPathUnder's client-facing message and toResponse's details-stripping (both
  // in main now) already guarantee a PATH_FORBIDDEN from resolveTarget can't leak an
  // absolute path to the client — no rebuilding needed here. What's still missing
  // without this wrapper is the server-side record: the sanitized error carries only
  // the caller-independent message, so this is the only place the rejected target
  // (and the roots it was checked against) get logged before the original error
  // continues on unchanged.
  async function resolveTargetSafe(req: any): Promise<string> {
    try {
      return await resolveTarget(req);
    } catch (err) {
      if (err instanceof AppError && err.code === 'PATH_FORBIDDEN') {
        const details = err.details as { target?: string; allowedRoots?: unknown } | undefined;
        const roots = Array.isArray(details?.allowedRoots) ? details.allowedRoots.join(', ') : undefined;
        app.deps.debugLog.log(
          'kb',
          `worktree rejected as not-owned-or-escaping: target=${details?.target}${roots ? ` allowedRoots=${roots}` : ''}`,
        );
      }
      throw err;
    }
  }

  app.get<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/kb/files', async (req) => {
    return listMarkdownFiles(await resolveTargetSafe(req), app.deps.debugLog);
  });

  app.get<{ Params: { encodedPath: string }; Querystring: { file?: string } }>(
    '/worktrees/:encodedPath/kb/file',
    async (req) => {
      const { file } = parseKbFileQuery(req.query);
      const target = await resolveTargetSafe(req);
      try {
        return await readMarkdownFile(target, file);
      } catch (err) {
        // readMarkdownFile's own catches discard the errno, so this is the
        // only place the underlying cause is ever recorded. Logged
        // server-side only (may name absolute paths) — the error rethrown
        // below is unchanged, so the client-facing response never sees it.
        const code = err instanceof AppError ? err.code : 'UNKNOWN';
        const message = err instanceof Error ? err.message : String(err);
        app.deps.debugLog.log('kb', `file read failed for ${target} (file=${file}): ${code} ${message}`);
        throw err;
      }
    },
  );
}
