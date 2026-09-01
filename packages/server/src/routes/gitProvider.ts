import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec } from '../shell.js';
import { AppError, AuthError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { parseRemoteUrl, isGitlabHost, isGithubHost, resolveSshAlias } from '../services/gitProviders.js';
import {
  readGitlabConfig, writeGitlabHost, removeGitlabHost, gitlabHostToken, mergeRequestsForBranch,
  mergeRequestsForProject, mergeRequestCountsForProject, mergeRequestChanges, mergeRequestDiscussion,
  mergeRequestCommits, commitChanges as gitlabCommitChanges,
  postMergeRequestReview, postMergeRequestLineComment, createMergeRequest, mergeMergeRequest,
  REVIEW_PAGE_SIZE, type ReviewCounts, type MergeRequest,
} from '../services/gitlab.js';
import {
  readGithubConfig, writeGithubHost, removeGithubHost, githubTokenFor, pullRequestsForBranch,
  pullRequestsForProject, pullRequestCountsForProject, pullRequestChanges, pullRequestDiscussion,
  pullRequestCommits, commitChanges as githubCommitChanges,
  postPullRequestReview, postPullRequestLineComment, createPullRequest, mergePullRequest,
} from '../services/github.js';

async function originUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    return stdout.trim() || null;
  } catch { return null; }
}
async function currentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch { return null; }
}

export type Provider = 'gitlab' | 'github';

// Explicit configuration beats heuristics (a user who saved github.corp.io
// under the GitLab config chose that), and gitlab config is checked first.
function classifyHost(
  host: string,
  gitlabHosts: Set<string>,
  githubHosts: Set<string>,
): Provider | null {
  if (gitlabHosts.has(host)) return 'gitlab';
  if (githubHosts.has(host)) return 'github';
  if (isGitlabHost(host, gitlabHosts)) return 'gitlab';
  if (isGithubHost(host, githubHosts)) return 'github';
  return null;
}

// Pure classification: origin url + each provider's configured hosts →
// provider + parsed project, or null when neither claims the host.
export function resolveProvider(
  url: string | null,
  gitlabHosts: Set<string>,
  githubHosts: Set<string>,
): { provider: Provider; host: string; projectPath: string } | null {
  const parsed = url ? parseRemoteUrl(url) : null;
  if (!parsed) return null;
  const provider = classifyHost(parsed.host, gitlabHosts, githubHosts);
  return provider ? { provider, host: parsed.host, projectPath: parsed.projectPath } : null;
}

// Like resolveProvider, but when an SSH remote's host is unrecognized, ask
// OpenSSH whether it's a ~/.ssh/config alias (git@github-strado:… →
// github.com) and classify the REAL hostname. Multi-account setups live on
// exactly these aliases. HTTPS remotes never carry aliases — no probe.
export async function resolveProviderAliased(
  url: string | null,
  gitlabHosts: Set<string>,
  githubHosts: Set<string>,
  sshResolve: (host: string) => Promise<string | null> = resolveSshAlias,
): Promise<{ provider: Provider; host: string; projectPath: string } | null> {
  const parsed = url ? parseRemoteUrl(url) : null;
  if (!parsed) return null;
  const direct = classifyHost(parsed.host, gitlabHosts, githubHosts);
  if (direct) return { provider: direct, host: parsed.host, projectPath: parsed.projectPath };
  if (!parsed.ssh) return null;
  const real = await sshResolve(parsed.host);
  if (!real) return null;
  const viaAlias = classifyHost(real, gitlabHosts, githubHosts);
  return viaAlias ? { provider: viaAlias, host: real, projectPath: parsed.projectPath } : null;
}

// Machine-level: credentials are per machine, not per workspace (mirrors Jira).
export async function registerGitProviderConfigRoutes(app: FastifyInstance) {
  app.get('/api/gitlab/config', async () => {
    const cfg = await readGitlabConfig();
    return { hosts: Object.keys(cfg) }; // never returns tokens
  });
  app.post('/api/gitlab/config', async (req) => {
    const Body = z.object({ host: z.string().min(1).max(253), token: z.string().min(1) });
    const { host, token } = Body.parse(req.body);
    const { username } = await writeGitlabHost(host, token);
    return { ok: true, host, username };
  });
  app.delete<{ Params: { host: string } }>('/api/gitlab/config/:host', async (req) => {
    const Params = z.object({ host: z.string().min(1).max(253) });
    const { host } = Params.parse(req.params);
    await removeGitlabHost(host);
    return { ok: true };
  });

  app.get('/api/github/config', async () => {
    const cfg = await readGithubConfig();
    return { hosts: Object.keys(cfg) }; // never returns tokens
  });
  app.post('/api/github/config', async (req) => {
    const Body = z.object({
      host: z.string().min(1).max(253),
      token: z.string().min(1),
      owner: z.string().min(1).max(100).regex(/^[A-Za-z0-9-_.]+$/).optional(),
    });
    const { host, token, owner } = Body.parse(req.body);
    const { username } = await writeGithubHost(host, token, owner);
    return { ok: true, host: owner ? `${host}/${owner}` : host, username };
  });
  app.delete<{ Params: { host: string } }>('/api/github/config/:host', async (req) => {
    const Params = z.object({ host: z.string().min(1).max(354) });
    const { host } = Params.parse(req.params);
    let key: string;
    try {
      key = decodeURIComponent(host);
    } catch {
      throw new AppError('VALIDATION', 'malformed host key');
    }
    await removeGithubHost(key);
    return { ok: true };
  });
}

type ProviderTarget =
  | { kind: 'absent' }
  | { kind: 'needsAuth'; provider: Provider }
  | { kind: 'ok'; provider: Provider; host: string; projectPath: string; token: string };

// Resolves a worktree/repo target to its provider project + token, or a
// terminal state (no matching repo / unknown origin / no saved token).
async function resolveProviderTarget(
  req: import('fastify').FastifyRequest, target: string,
): Promise<ProviderTarget> {
  const { repos } = req.workspace!.stores;
  const allRepos = await repos.list();
  const repo = findOwningRepo(allRepos, target, req.server.deps.homeStateDir, { includeRepoRoot: true });
  if (!repo) return { kind: 'absent' };
  assertPathUnder(target, [repo.path, ...worktreeRootsFor(req.server.deps.homeStateDir, repo)]);
  const url = await originUrl(repo.path);
  const [glCfg, ghCfg] = [await readGitlabConfig(), await readGithubConfig()];
  const resolved = await resolveProviderAliased(
    url,
    new Set(Object.keys(glCfg)),
    new Set(Object.keys(ghCfg).map((k) => k.split('/')[0] ?? k)),
  );
  if (!resolved) return { kind: 'absent' };
  const token = resolved.provider === 'gitlab'
    ? gitlabHostToken(glCfg, resolved.host)
    : githubTokenFor(ghCfg, resolved.host, resolved.projectPath.split('/')[0] ?? '');
  if (!token) return { kind: 'needsAuth', provider: resolved.provider };
  return { kind: 'ok', ...resolved, token };
}

// GitHub's Search API exposes at most 1,000 results for a query. Open PRs use
// the regular pulls endpoint and GitLab has no equivalent search-window cap.
// Twenty rows per provider page therefore gives GitHub search-backed states a
// deepest exact page of 50; the response advertises that limit when relevant.
const GITHUB_SEARCH_PAGE_LIMIT = 1_000 / REVIEW_PAGE_SIZE;
const AGGREGATE_MAX_ITEMS = 100;

// A batch answers at most this many paths, and probes at most this many at a
// time — enough to stay quick, low enough to not stampede the provider.
const BATCH_MAX_PATHS = 200;
const BATCH_CONCURRENCY = 6;

async function mapConcurrent<T, R>(
  items: T[], limit: number, worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

type BranchMergeRequests =
  | { kind: 'absent' }
  | { kind: 'needsAuth'; provider: Provider }
  | { kind: 'list'; provider: Provider; mergeRequests: MergeRequest[] }
  // `error` carries the original so the single-worktree route can rethrow it
  // verbatim (its status code is part of that route's contract); the batch
  // keeps only the message, since one bad path must not fail the response.
  | { kind: 'error'; error: unknown; message: string };

/** The MRs open on a worktree's current branch, or why there are none. */
async function branchMergeRequests(
  req: import('fastify').FastifyRequest, target: string,
): Promise<BranchMergeRequests> {
  let t: ProviderTarget;
  try {
    t = await resolveProviderTarget(req, target);
  } catch (err) {
    // Unknown/out-of-tree path: absent for the caller, never fatal for a batch.
    return { kind: 'error', error: err, message: err instanceof Error ? err.message : String(err) };
  }
  if (t.kind === 'absent') return { kind: 'absent' };
  if (t.kind === 'needsAuth') return { kind: 'needsAuth', provider: t.provider };
  const branch = await currentBranch(target);
  if (!branch) return { kind: 'absent' };
  try {
    const list = t.provider === 'gitlab'
      ? await mergeRequestsForBranch(t.host, t.token, t.projectPath, branch)
      : await pullRequestsForBranch(t.host, t.token, t.projectPath, branch);
    return {
      kind: 'list',
      provider: t.provider,
      mergeRequests: list.map((m) => ({ ...m, provider: t.provider })),
    };
  } catch (err) {
    // expired/again-rejected token mid-poll → ask the user to reconnect
    if (err instanceof AuthError) return { kind: 'needsAuth', provider: t.provider };
    return { kind: 'error', error: err, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function registerGitProviderWorktreeRoutes(app: FastifyInstance) {
  // Workspace-wide review inbox. Unlike the branch endpoint below, this starts
  // from every registered repository, so it includes fork PRs and branches
  // whose local worktree has already been removed.
  app.get<{ Querystring: { state?: string; page?: string; search?: string; repoId?: string } }>('/merge-requests', async (req) => {
    const state = z.enum(['open', 'merged', 'closed']).default('open').parse(req.query.state);
    const page = z.coerce.number().int().min(1).max(10_000).default(1).parse(req.query.page);
    const search = z.string().max(200).default('').parse(req.query.search).trim();
    const repoId = z.string().max(200).default('').parse(req.query.repoId).trim();
    const repos = await req.workspace!.stores.repos.list();
    // One repository, or one picked: that repository's own paging is exact, so
    // ask it for the page directly. A merged inbox asks every provider for one
    // growing page-1 window through the requested row. Asking each repository
    // for only page N loses rows discarded by the earlier global merge forever.
    const scoped = !!repoId || repos.length === 1;
    const windowEnd = page * REVIEW_PAGE_SIZE;
    const limit = scoped ? REVIEW_PAGE_SIZE : Math.min(windowEnd, AGGREGATE_MAX_ITEMS);
    const listPage = scoped ? page : 1;
    const results = await Promise.all(repos.map(async (repo) => {
      // Every repository still reports its counts — they fill the state tabs
      // and the picker — but only the picked one is paged through, so its
      // page numbers line up with its own totals instead of the merged list.
      const listed = !repoId || repo.id === repoId;
      const target = await resolveProviderTarget(req, repo.path);
      if (target.kind === 'absent') {
        return { repository: { repoId: repo.id, repoName: repo.name, status: 'unsupported' as const }, reviews: [] };
      }
      if (target.kind === 'needsAuth') {
        return {
          repository: { repoId: repo.id, repoName: repo.name, provider: target.provider, status: 'needsAuth' as const },
          reviews: [],
        };
      }
      try {
        const counts = target.provider === 'gitlab'
          ? await mergeRequestCountsForProject(target.host, target.token, target.projectPath)
          : await pullRequestCountsForProject(target.host, target.token, target.projectPath);
        const githubSearchLimited = listed && target.provider === 'github'
          && (search.length > 0 || state !== 'open')
          && (search.length > 0 || counts[state] > 1_000);
        const reviews = !listed ? [] : target.provider === 'gitlab'
          ? await mergeRequestsForProject(target.host, target.token, target.projectPath, {
              state, page: listPage, search, limit,
            })
          : await pullRequestsForProject(target.host, target.token, target.projectPath, {
              state, page: listPage, search, limit,
            });
        return {
          repository: { repoId: repo.id, repoName: repo.name, provider: target.provider, status: 'ok' as const, counts },
          githubSearchLimited,
          reviews: reviews.map((review) => ({
            ...review,
            provider: target.provider,
            repoId: repo.id,
            repoName: repo.name,
          })),
        };
      } catch (err) {
        if (err instanceof AuthError) {
          return {
            repository: { repoId: repo.id, repoName: repo.name, provider: target.provider, status: 'needsAuth' as const },
            reviews: [],
          };
        }
        return {
          repository: {
            repoId: repo.id,
            repoName: repo.name,
            provider: target.provider,
            status: 'error' as const,
            error: err instanceof Error ? err.message : String(err),
          },
          reviews: [],
        };
      }
    }));

    const merged = results.flatMap((result) => result.reviews).sort((a, b) =>
      (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
      b.updatedAt.localeCompare(a.updatedAt),
    );
    const reviews = scoped
      ? merged.slice(0, REVIEW_PAGE_SIZE)
      : merged.slice(windowEnd - REVIEW_PAGE_SIZE, windowEnd);
    const counts = results.reduce<ReviewCounts>((total, result) => {
      const repoCounts = 'counts' in result.repository ? result.repository.counts : undefined;
      if (repoCounts) {
        total.open += repoCounts.open;
        total.merged += repoCounts.merged;
        total.closed += repoCounts.closed;
      }
      return total;
    }, { open: 0, merged: 0, closed: 0 });
    const hasMore = scoped
      ? results.some((result) => {
          if (repoId && result.repository.repoId !== repoId) return false;
          if (!('counts' in result.repository) || !result.repository.counts) return false;
          if (search) return result.reviews.length === REVIEW_PAGE_SIZE;
          const repoCounts = result.repository.counts;
          return windowEnd < repoCounts[state];
        })
      : merged.length > windowEnd;
    const pageLimit = scoped
      ? results.some((result) => 'githubSearchLimited' in result && result.githubSearchLimited)
        ? GITHUB_SEARCH_PAGE_LIMIT
        : null
      : AGGREGATE_MAX_ITEMS / REVIEW_PAGE_SIZE;
    return {
      reviews,
      repositories: results.map((result) => result.repository),
      counts,
      page,
      pageSize: REVIEW_PAGE_SIZE,
      hasMore,
      // A merged inbox deliberately caps its exact combined window at 100;
      // selecting a repository pages its entire collection directly. GitHub
      // search-backed states have their own upstream 1,000-result limit.
      pageLimit,
    };
  });

  app.get<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/merge-requests',
    async (req, reply) => {
      const entry = await branchMergeRequests(req, decodeURIComponent(req.params.encodedPath));
      if (entry.kind === 'absent') return reply.code(204).send();
      if (entry.kind === 'needsAuth') return { needsAuth: true, provider: entry.provider };
      if (entry.kind === 'error') throw entry.error;
      return { provider: entry.provider, mergeRequests: entry.mergeRequests };
    },
  );

  // One call for every worktree's branch MR, instead of one call per worktree.
  //
  // Why it exists: the board polls a chip per worktree. A repo with two dozen
  // worktrees therefore fired two dozen requests per tick, and a browser only
  // lends an origin six HTTP/1.1 sockets — several of which SSE holds — so the
  // fan-out queued behind itself and starved every unrelated call (closing a
  // shell included). Collapsing it to one request removes the amplification.
  //
  // POST because the paths are absolute and numerous: a query string of two
  // dozen of them runs past what a URL should carry. It is a read; it has no
  // side effects.
  const BatchBody = z.object({
    paths: z.array(z.string().min(1).max(4096)).max(BATCH_MAX_PATHS),
  });
  app.post('/merge-requests/batch', async (req) => {
    const { paths } = BatchBody.parse(req.body);
    // De-duplicated so a path listed twice costs one lookup.
    const unique = [...new Set(paths)];
    const entries = await mapConcurrent(unique, BATCH_CONCURRENCY, async (target) => {
      const entry = await branchMergeRequests(req, target);
      return [target, entry.kind === 'error'
        ? { kind: 'error' as const, message: entry.message }
        : entry] as const;
    });
    return { results: Object.fromEntries(entries) };
  });

  app.get<{ Params: { encodedPath: string; iid: string } }>(
    '/worktrees/:encodedPath/merge-requests/:iid/changes',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const iid = z.coerce.number().int().positive().parse(req.params.iid);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      try {
        const changes = t.provider === 'gitlab'
          ? await mergeRequestChanges(t.host, t.token, t.projectPath, iid)
          : await pullRequestChanges(t.host, t.token, t.projectPath, iid);
        return changes;
      } catch (err) {
        if (err instanceof AuthError) {
          return { needsAuth: true, provider: t.provider };
        }
        throw err;
      }
    },
  );

  // The conversation half of a review: description plus every human comment.
  // Separate from /changes so a slow diff never delays it (and vice versa).
  app.get<{ Params: { encodedPath: string; iid: string } }>(
    '/worktrees/:encodedPath/merge-requests/:iid/discussion',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const iid = z.coerce.number().int().positive().parse(req.params.iid);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      try {
        const discussion = t.provider === 'gitlab'
          ? await mergeRequestDiscussion(t.host, t.token, t.projectPath, iid)
          : await pullRequestDiscussion(t.host, t.token, t.projectPath, iid);
        return { discussion };
      } catch (err) {
        if (err instanceof AuthError) {
          return { needsAuth: true, provider: t.provider };
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { encodedPath: string; iid: string } }>(
    '/worktrees/:encodedPath/merge-requests/:iid/commits',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const iid = z.coerce.number().int().positive().parse(req.params.iid);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      try {
        const commits = t.provider === 'gitlab'
          ? await mergeRequestCommits(t.host, t.token, t.projectPath, iid)
          : await pullRequestCommits(t.host, t.token, t.projectPath, iid);
        return { commits };
      } catch (err) {
        if (err instanceof AuthError) {
          return { needsAuth: true, provider: t.provider };
        }
        throw err;
      }
    },
  );

  // A single commit's diff, so a review can be read commit by commit without
  // leaving the pane. Repo-scoped rather than review-scoped: the sha is enough.
  app.get<{ Params: { encodedPath: string; sha: string } }>(
    '/worktrees/:encodedPath/commits/:sha/changes',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const sha = z.string().regex(/^[0-9a-f]{7,64}$/i, 'invalid commit sha').parse(req.params.sha);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      try {
        const files = t.provider === 'gitlab'
          ? await gitlabCommitChanges(t.host, t.token, t.projectPath, sha)
          : await githubCommitChanges(t.host, t.token, t.projectPath, sha);
        return { files };
      } catch (err) {
        if (err instanceof AuthError) {
          return { needsAuth: true, provider: t.provider };
        }
        throw err;
      }
    },
  );

  const ReviewBody = z.object({
    body: z.string().max(65_536).default(''),
    event: z.enum(['comment', 'approve', 'request-changes']),
  }).refine((input) => input.event !== 'comment' || input.body.trim().length > 0, {
    message: 'a comment needs a body',
  });
  app.post<{ Params: { encodedPath: string; iid: string } }>(
    '/worktrees/:encodedPath/merge-requests/:iid/review',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const iid = z.coerce.number().int().positive().parse(req.params.iid);
      const input = ReviewBody.parse(req.body);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      try {
        if (t.provider === 'gitlab') await postMergeRequestReview(t.host, t.token, t.projectPath, iid, input);
        else await postPullRequestReview(t.host, t.token, t.projectPath, iid, input);
        return { posted: true };
      } catch (err) {
        if (err instanceof AuthError) {
          return { needsAuth: true, provider: t.provider };
        }
        throw err;
      }
    },
  );

  const LineCommentBody = z.object({
    body: z.string().min(1).max(65_536),
    path: z.string().min(1).max(4096),
    oldPath: z.string().max(4096).optional(),
    line: z.number().int().positive().max(10_000_000),
    side: z.enum(['new', 'old']).default('new'),
  });
  app.post<{ Params: { encodedPath: string; iid: string } }>(
    '/worktrees/:encodedPath/merge-requests/:iid/line-comment',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const iid = z.coerce.number().int().positive().parse(req.params.iid);
      const input = LineCommentBody.parse(req.body);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      try {
        // The position shas come from the provider, never the client — the
        // discussion fetch is cached, so this is usually free.
        const { anchor } = t.provider === 'gitlab'
          ? await mergeRequestDiscussion(t.host, t.token, t.projectPath, iid)
          : await pullRequestDiscussion(t.host, t.token, t.projectPath, iid);
        if (!anchor) throw new AppError('VALIDATION', 'This review has no diff to pin a comment to');
        if (t.provider === 'gitlab') await postMergeRequestLineComment(t.host, t.token, t.projectPath, iid, input, anchor);
        else await postPullRequestLineComment(t.host, t.token, t.projectPath, iid, input, anchor);
        return { posted: true };
      } catch (err) {
        if (err instanceof AuthError) {
          return { needsAuth: true, provider: t.provider };
        }
        throw err;
      }
    },
  );

  const CreateBody = z.object({
    target: z.string().min(1).max(255).regex(/^[^\s-][^\s]*$/, 'invalid target branch'),
    title: z.string().min(1).max(255),
    description: z.string().max(10_000).optional(),
  });
  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/merge-requests',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const body = CreateBody.parse(req.body);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      const branch = await currentBranch(target);
      if (!branch) throw new AppError('VALIDATION', 'cannot create an MR from a detached HEAD');
      const input = { sourceBranch: branch, targetBranch: body.target, title: body.title, description: body.description };
      try {
        const mr = t.provider === 'gitlab'
          ? await createMergeRequest(t.host, t.token, t.projectPath, input)
          : await createPullRequest(t.host, t.token, t.projectPath, input);
        return { mergeRequest: { ...mr, provider: t.provider } };
      } catch (err) {
        if (err instanceof AuthError) return { needsAuth: true, provider: t.provider };
        throw err;
      }
    },
  );

  app.post<{ Params: { encodedPath: string; iid: string } }>(
    '/worktrees/:encodedPath/merge-requests/:iid/merge',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const iid = z.coerce.number().int().positive().parse(req.params.iid);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      try {
        if (t.provider === 'gitlab') {
          const mr = await mergeMergeRequest(t.host, t.token, t.projectPath, iid);
          return { mergeRequest: { ...mr, provider: t.provider } };
        }
        await mergePullRequest(t.host, t.token, t.projectPath, iid);
        // The merge has succeeded on GitHub — nothing past this line may fail
        // the response. GitHub's merge response carries no PR body, so we
        // re-list (fresh) and find it purely to enrich the reply; if that
        // re-read throws (flaky AuthError, 500, etc.) or the PR isn't found,
        // fall back to a synthesized merged MR rather than mislabeling a
        // successful merge as an error or an auth failure.
        const branch = await currentBranch(target);
        let listed;
        try {
          listed = branch
            ? (await pullRequestsForBranch(t.host, t.token, t.projectPath, branch, { force: true }))
                .find((m) => m.number === iid)
            : undefined;
        } catch {
          listed = undefined; // stale/erroring re-read must not mislabel a successful merge
        }
        return {
          mergeRequest: listed
            ? { ...listed, provider: t.provider }
            : {
                number: iid, title: '', state: 'merged' as const, webUrl: '', pipeline: null,
                approvals: null, sourceBranch: branch ?? '', targetBranch: null, updatedAt: '',
                provider: t.provider,
              },
        };
      } catch (err) {
        if (err instanceof AuthError) return { needsAuth: true, provider: t.provider };
        throw err;
      }
    },
  );
}
