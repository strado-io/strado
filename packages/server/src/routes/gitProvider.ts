import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec } from '../shell.js';
import { AppError, AuthError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { parseRemoteUrl, isGitlabHost, isGithubHost, resolveSshAlias } from '../services/gitProviders.js';
import {
  readGitlabConfig, writeGitlabHost, removeGitlabHost, gitlabHostToken, mergeRequestsForBranch,
  mergeRequestChanges, createMergeRequest, mergeMergeRequest,
} from '../services/gitlab.js';
import {
  readGithubConfig, writeGithubHost, removeGithubHost, githubTokenFor, pullRequestsForBranch,
  pullRequestChanges, createPullRequest, mergePullRequest,
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

// Scoped under /api/w/:wsId — needs the workspace's repos to resolve a worktree.
export async function registerGitProviderWorktreeRoutes(app: FastifyInstance) {
  app.get<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/merge-requests',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      const branch = await currentBranch(target);
      if (!branch) return reply.code(204).send();
      try {
        const list = t.provider === 'gitlab'
          ? await mergeRequestsForBranch(t.host, t.token, t.projectPath, branch)
          : await pullRequestsForBranch(t.host, t.token, t.projectPath, branch);
        return {
          provider: t.provider,
          mergeRequests: list.map((m) => ({ ...m, provider: t.provider })),
        };
      } catch (err) {
        // expired/again-rejected token mid-poll → ask the user to reconnect
        if (err instanceof AuthError) {
          return { needsAuth: true, provider: t.provider };
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { encodedPath: string; iid: string } }>(
    '/worktrees/:encodedPath/merge-requests/:iid/changes',
    async (req, reply) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const iid = z.coerce.number().int().positive().parse(req.params.iid);
      const t = await resolveProviderTarget(req, target);
      if (t.kind === 'absent') return reply.code(204).send();
      if (t.kind === 'needsAuth') return { needsAuth: true, provider: t.provider };
      try {
        const files = t.provider === 'gitlab'
          ? await mergeRequestChanges(t.host, t.token, t.projectPath, iid)
          : await pullRequestChanges(t.host, t.token, t.projectPath, iid);
        return { files };
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
