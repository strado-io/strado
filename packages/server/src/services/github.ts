import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError, AuthError } from '../errors.js';
import {
  REVIEW_PAGE_SIZE,
  type MergeRequest, type MergeRequestChange, type ReviewChanges, type ReviewCounts,
  type ReviewComment, type ReviewDiscussion, type ReviewSubmission, type ReviewCommit,
  type ReviewAnchor, type LineComment,
} from './gitlab.js';

// GitHub provider service. Mirrors gitlab.ts: same config-file pattern, same
// provider-neutral wire types (MergeRequest/MergeRequestChange — GitHub PRs
// are mapped into them so routes and the web app need no new shapes).

const ConfigSchema = z.record(z.string(), z.object({ token: z.string().min(1) }));
export type GithubConfig = z.infer<typeof ConfigSchema>;

export function githubConfigPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'github.json');
}

export async function readGithubConfig(): Promise<GithubConfig> {
  try {
    return ConfigSchema.parse(JSON.parse(await fsp.readFile(githubConfigPath(), 'utf8')));
  } catch {
    return {};
  }
}

// Owner-scoped token first (github.com/workorg), bare-host entry as the
// fallback — how separate work/personal accounts coexist on one host.
export function githubTokenFor(cfg: GithubConfig, host: string, owner: string): string | null {
  return cfg[`${host}/${owner.toLowerCase()}`]?.token ?? cfg[host]?.token ?? null;
}

// github.com serves the REST API on its own domain; GHE serves it under the
// instance domain at /api/v3.
function apiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

// An unreachable host (VPN off, DNS blackhole) otherwise hangs the TCP
// connect for ~75s per request and stalls everything queued behind it.
const REQUEST_TIMEOUT_MS = 10_000;

export async function githubApiFetch(
  host: string,
  token: string,
  pathname: string,
  init?: RequestInit,
  // Reads treat 403 as "reconnect" because it also covers rate-limit
  // exhaustion. Writes opt out: there, 403 is almost always a read-only token,
  // and the caller can say so precisely instead.
  opts?: { allowForbidden?: boolean },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(host)}${pathname}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new AppError('VALIDATION', `GitHub at ${host} did not respond within 10s — check your network/VPN`);
    }
    throw err;
  }
  if (res.status === 401 || (res.status === 403 && !opts?.allowForbidden)) {
    // 403 also covers rate-limit exhaustion; both read as "reconnect" in the
    // UI, which is acceptable at our 60s-cached request volume.
    throw new AuthError('GitHub rejected the token — check its repo access and expiry');
  }
  return res;
}

/** Read every page of a GitHub REST collection instead of silently stopping at 100. */
async function githubCollection<T>(
  host: string, token: string, pathname: string, what: string,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = pathname.includes('?') ? '&' : '?';
    const res = await githubApiFetch(host, token, `${pathname}${separator}per_page=100&page=${page}`);
    if (res.status === 404) {
      throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
    }
    if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} fetching ${what}`);
    const batch = (await res.json()) as T[];
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

/**
 * Why GitHub refused a write, in words the user can act on: the permission it
 * actually wanted (GitHub names it in a response header), or the rate limit.
 */
function githubForbidden(res: Response, body: unknown): AppError {
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const minutes = Number.isFinite(reset) ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000)) : null;
    return new AppError('VALIDATION', `GitHub rate limit reached${minutes ? ` — try again in about ${minutes} min` : ''}`);
  }
  const needed = res.headers.get('x-accepted-github-permissions');
  const reason = githubMessage(body, 'GitHub refused the write');
  return new AppError(
    'VALIDATION',
    needed
      ? `${reason} — this token needs "${needed}". Update its permissions on GitHub and save it again.`
      : `${reason} — the saved token looks read-only for this repository. Give it pull request write access and save it again.`,
  );
}

export async function writeGithubHost(host: string, token: string, owner?: string): Promise<{ username: string }> {
  const res = await githubApiFetch(host, token, '/user');
  if (!res.ok) throw new AppError('VALIDATION', `GitHub responded ${res.status} validating the token`);
  const me = (await res.json()) as { login?: string };
  const cfg = await readGithubConfig();
  cfg[owner ? `${host}/${owner.toLowerCase()}` : host] = { token };
  const file = githubConfigPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { username: me?.login ?? host };
}

export async function removeGithubHost(host: string): Promise<void> {
  const cfg = await readGithubConfig();
  if (!(host in cfg)) return;
  delete cfg[host];
  await fsp.writeFile(githubConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

type GithubPr = {
  number: number; title?: string; state?: string; merged_at?: string | null;
  html_url?: string; updated_at?: string; created_at?: string;
  user?: { login?: string } | null;
  head?: { ref?: string; sha?: string } | null;
  base?: { ref?: string } | null;
  changed_files?: number;
};
type GithubSearchIssue = { number?: number };
type GithubCheckRun = { status?: string; conclusion?: string | null };
type GithubFile = {
  filename?: string; previous_filename?: string; status?: string; patch?: string;
};

// Aggregate check runs into the pipeline chip states the UI already renders.
// Precedence: any hard failure → failed; anything still going → running;
// cancelled-only → canceled; all good (success/neutral/skipped) → success;
// no check runs at all → null (no chip).
function aggregateChecks(runs: GithubCheckRun[]): MergeRequest['pipeline'] {
  if (runs.length === 0) return null;
  let sawCancelled = false;
  let sawRunning = false;
  for (const r of runs) {
    if (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure') return 'failed';
    if (r.status === 'queued' || r.status === 'in_progress') sawRunning = true;
    if (r.conclusion === 'cancelled') sawCancelled = true;
  }
  if (sawRunning) return 'running';
  if (sawCancelled) return 'canceled';
  return 'success';
}

function mapPrState(pr: GithubPr): MergeRequest['state'] {
  if (pr.merged_at) return 'merged';
  return pr.state === 'open' ? 'open' : 'closed';
}

const cache = new Map<string, { at: number; mrs: MergeRequest[] }>();
const TTL_MS = 60_000;

async function mapConcurrent<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, run));
  return output;
}

async function pullRequests(
  host: string,
  token: string,
  projectPath: string,
  branch: string | null,
  opts?: { force?: boolean; state?: MergeRequest['state']; page?: number; search?: string; limit?: number },
): Promise<MergeRequest[]> {
  const requestedState = branch ? null : opts?.state ?? null;
  const page = branch ? 1 : opts?.page ?? 1;
  const search = branch ? '' : opts?.search?.trim() ?? '';
  const limit = branch ? 10 : (opts?.limit ?? REVIEW_PAGE_SIZE);
  const key = `${host}\0${projectPath}\0${branch ?? `*:${requestedState ?? 'all'}:${page}:${limit}:${search}`}`;
  const hit = cache.get(key);
  if (!opts?.force && hit && Date.now() - hit.at < TTL_MS) return hit.mrs;

  // Worktree branches are pushed to origin, so the head owner is the repo
  // owner (first projectPath segment). Fork PRs are out of scope.
  const owner = projectPath.split('/')[0] ?? '';
  const headQuery = branch ? `head=${encodeURIComponent(`${owner}:${branch}`)}&` : '';
  const providerState = requestedState === 'open' ? 'open' : requestedState ? 'closed' : 'all';
  let listed: GithubPr[];
  if (!branch && (search || requestedState === 'merged' || requestedState === 'closed')) {
    const qualifier = requestedState === 'open'
      ? 'is:open'
      : requestedState === 'merged'
        ? 'is:merged'
        : 'is:closed is:unmerged';
    const query = encodeURIComponent(`repo:${projectPath} is:pr ${qualifier}${search ? ` ${search}` : ''}`);
    const searchRes = await githubApiFetch(
      host, token, `/search/issues?q=${query}&sort=updated&order=desc&per_page=${limit}&page=${page}`,
    );
    if (searchRes.status === 404) {
      throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
    }
    if (!searchRes.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${searchRes.status} searching PRs`);
    const body = (await searchRes.json()) as { items?: GithubSearchIssue[] };
    listed = await mapConcurrent(
      (body.items ?? []).flatMap((item) => item.number ? [item.number] : []),
      async (number) => {
        const detail = await githubApiFetch(host, token, `/repos/${projectPath}/pulls/${number}`);
        if (!detail.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${detail.status} reading PR ${number}`);
        return (await detail.json()) as GithubPr;
      },
    );
  } else {
    const listRes = await githubApiFetch(
      host, token,
      `/repos/${projectPath}/pulls?${headQuery}state=${providerState}&sort=updated&direction=desc&per_page=${limit}&page=${page}`,
    );
    if (listRes.status === 404) {
      // GitHub 404s private repos the token can't see — steer to reconnect
      throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
    }
    if (!listRes.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${listRes.status} listing PRs`);
    listed = (await listRes.json()) as GithubPr[];
  }
  const raw = requestedState && requestedState !== 'open'
    ? listed.filter((pr) => mapPrState(pr) === requestedState)
    : listed;

  const mrs = await mapConcurrent(raw, async (pr): Promise<MergeRequest> => {
    const state = mapPrState(pr);
    let pipeline: MergeRequest['pipeline'] = null;
    if (state === 'open' && pr.head?.sha) {
      try {
        const cRes = await githubApiFetch(
          host, token, `/repos/${projectPath}/commits/${pr.head.sha}/check-runs?per_page=100`,
        );
        if (cRes.ok) {
          const body = (await cRes.json()) as { check_runs?: GithubCheckRun[] };
          pipeline = aggregateChecks(body.check_runs ?? []);
        }
      } catch {
        pipeline = null; // checks unavailable (token scope, GHE without Actions)
      }
    }
    return {
      number: pr.number,
      title: pr.title ?? '',
      state,
      webUrl: pr.html_url ?? '',
      pipeline,
      // Required-approval counts live in branch protection, unreadable by
      // most tokens — omit rather than mislead. The UI hides a null chip.
      approvals: null,
      sourceBranch: pr.head?.ref ?? branch ?? '',
      targetBranch: pr.base?.ref ?? null,
      updatedAt: pr.updated_at ?? '',
      author: pr.user?.login ?? null,
      createdAt: pr.created_at ?? null,
      mergedAt: pr.merged_at ?? null,
    };
  });
  mrs.sort((a, b) =>
    (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
    b.updatedAt.localeCompare(a.updatedAt),
  );
  cache.set(key, { at: Date.now(), mrs });
  return mrs;
}

export function pullRequestsForBranch(
  host: string,
  token: string,
  projectPath: string,
  branch: string,
  opts?: { force?: boolean },
): Promise<MergeRequest[]> {
  return pullRequests(host, token, projectPath, branch, opts);
}

/** The most recently updated PRs for a repository, including fork branches. */
export function pullRequestsForProject(
  host: string,
  token: string,
  projectPath: string,
  opts?: { force?: boolean; state?: MergeRequest['state']; page?: number; search?: string; limit?: number },
): Promise<MergeRequest[]> {
  return pullRequests(host, token, projectPath, null, opts);
}

const countCache = new Map<string, { at: number; counts: ReviewCounts }>();

/** Exact state totals via GitHub's search index; avoids walking every PR page. */
export async function pullRequestCountsForProject(
  host: string,
  token: string,
  projectPath: string,
  opts?: { force?: boolean },
): Promise<ReviewCounts> {
  const key = `${host}\0${projectPath}`;
  const hit = countCache.get(key);
  if (!opts?.force && hit && Date.now() - hit.at < TTL_MS) return hit.counts;
  const entries = await Promise.all(([
    ['open', 'is:open'],
    ['merged', 'is:merged'],
    ['closed', 'is:closed is:unmerged'],
  ] as const).map(async ([keyName, qualifier]) => {
    const query = encodeURIComponent(`repo:${projectPath} is:pr ${qualifier}`);
    const res = await githubApiFetch(host, token, `/search/issues?q=${query}&per_page=1`);
    if (res.status === 404) {
      throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
    }
    if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} counting PRs`);
    const body = (await res.json()) as { total_count?: number };
    return [keyName, typeof body.total_count === 'number' ? body.total_count : 0] as const;
  }));
  const counts = Object.fromEntries(entries) as ReviewCounts;
  countCache.set(key, { at: Date.now(), counts });
  return counts;
}

export function invalidateMrCache(host: string, projectPath: string, branch?: string): void {
  const prefix = `${host}\0${projectPath}\0`;
  for (const key of cache.keys()) {
    if (!branch || key === `${prefix}${branch}` || key.startsWith(`${prefix}*:`)) cache.delete(key);
  }
  countCache.delete(`${host}\0${projectPath}`);
}

// GitHub error bodies carry `message` plus, on 422, an `errors[]` array whose
// first message is the actionable one (e.g. "A pull request already exists").
function githubMessage(body: unknown, fallback: string): string {
  const b = body as { message?: string; errors?: Array<{ message?: string }> } | null;
  return b?.errors?.find((e) => e.message)?.message || b?.message || fallback;
}

function mapPr(pr: GithubPr, sourceFallback: string): MergeRequest {
  return {
    number: pr.number,
    title: pr.title ?? '',
    state: mapPrState(pr),
    webUrl: pr.html_url ?? '',
    pipeline: null,
    approvals: null,
    sourceBranch: pr.head?.ref ?? sourceFallback,
    targetBranch: pr.base?.ref ?? null,
    updatedAt: pr.updated_at ?? '',
    author: pr.user?.login ?? null,
    createdAt: pr.created_at ?? null,
    mergedAt: pr.merged_at ?? null,
  };
}

export async function createPullRequest(
  host: string, token: string, projectPath: string,
  input: { sourceBranch: string; targetBranch: string; title: string; description?: string },
): Promise<MergeRequest> {
  const owner = projectPath.split('/')[0] ?? '';
  const res = await githubApiFetch(host, token, `/repos/${projectPath}/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      head: `${owner}:${input.sourceBranch}`,
      base: input.targetBranch,
      ...(input.description ? { body: input.description } : {}),
    }),
  });
  if (res.status === 404) {
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  if (res.status === 422) {
    throw new AppError('VALIDATION', githubMessage(await res.json().catch(() => null), 'GitHub refused to create the PR (422)'));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} creating the PR`);
  const mr = mapPr((await res.json()) as GithubPr, input.sourceBranch);
  invalidateMrCache(host, projectPath, mr.sourceBranch);
  return mr;
}

export async function mergePullRequest(
  host: string, token: string, projectPath: string, number: number,
): Promise<void> {
  const res = await githubApiFetch(host, token, `/repos/${projectPath}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }, { allowForbidden: true });
  if (res.status === 403) throw githubForbidden(res, await res.json().catch(() => null));
  if (res.status === 404) {
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  if ([405, 409, 422].includes(res.status)) {
    throw new AppError('VALIDATION', githubMessage(await res.json().catch(() => null), 'GitHub refused the merge (conflicts or required checks)'));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} merging the PR`);
  invalidateMrCache(host, projectPath);
}

const changesCache = new Map<string, { at: number; changes: ReviewChanges }>();

type GithubComment = {
  id?: number; body?: string | null; created_at?: string; html_url?: string;
  user?: { login?: string } | null;
  path?: string | null; line?: number | null; original_line?: number | null; side?: string | null;
};
type GithubReview = {
  id?: number; body?: string | null; state?: string; submitted_at?: string | null; html_url?: string;
  user?: { login?: string } | null;
};

const discussionCache = new Map<string, { at: number; discussion: ReviewDiscussion }>();

function reviewKind(state: string | undefined): ReviewComment['kind'] {
  if (state === 'APPROVED') return 'approved';
  if (state === 'CHANGES_REQUESTED') return 'changes-requested';
  return 'comment';
}

/**
 * GitHub splits one conversation across three endpoints: issue comments (the
 * discussion tab), review submissions (approve / request changes, with their
 * summary body), and review comments (anchored to a diff line). They are
 * fetched together and merged back into one time-ordered thread.
 */
export async function pullRequestDiscussion(
  host: string, token: string, projectPath: string, number: number,
): Promise<ReviewDiscussion> {
  const key = `${host}\0${projectPath}\0${number}`;
  const hit = discussionCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.discussion;

  const [prRes, issueComments, reviews, inlineComments] = await Promise.all([
    githubApiFetch(host, token, `/repos/${projectPath}/pulls/${number}`),
    githubCollection<GithubComment>(host, token, `/repos/${projectPath}/issues/${number}/comments`, 'PR comments'),
    githubCollection<GithubReview>(host, token, `/repos/${projectPath}/pulls/${number}/reviews`, 'PR reviews'),
    githubCollection<GithubComment>(host, token, `/repos/${projectPath}/pulls/${number}/comments`, 'review comments'),
  ]);
  if (prRes.status === 404) {
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  if (!prRes.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${prRes.status} fetching the pull request`);
  const pr = (await prRes.json()) as { body?: string | null; head?: { sha?: string } | null };

  // Issue comments and review comments are independent id sequences, so a bare
  // id can collide across the two lists and duplicate a React key.
  const fromComment = (c: GithubComment, path: string | null, line: number | null): ReviewComment => ({
    id: `${path === null ? 'issue' : 'inline'}-${c.id ?? ''}`,
    author: c.user?.login ?? null,
    body: c.body ?? '',
    createdAt: c.created_at ?? '',
    path,
    line,
    side: c.side === 'LEFT' ? 'old' : 'new',
    kind: 'comment',
    webUrl: c.html_url ?? null,
  });

  const comments: ReviewComment[] = [
    ...issueComments.filter((c) => c.body?.trim()).map((c) => fromComment(c, null, null)),
    ...inlineComments.filter((c) => c.body?.trim())
      .map((c) => fromComment(c, c.path ?? null, c.line ?? c.original_line ?? null)),
    // A COMMENTED review with no body is just the envelope around inline
    // comments already listed above — only approvals/change requests are
    // worth a bodiless row, because the verdict itself is the content.
    ...reviews
      .filter((r) => r.state !== 'PENDING' && (r.body?.trim() || reviewKind(r.state) !== 'comment'))
      .map((r) => ({
        id: `review-${r.id ?? ''}`,
        author: r.user?.login ?? null,
        body: r.body ?? '',
        createdAt: r.submitted_at ?? '',
        path: null,
        line: null,
        side: 'new' as const,
        kind: reviewKind(r.state),
        webUrl: r.html_url ?? null,
      })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const discussion: ReviewDiscussion = {
    description: pr.body?.trim() ? pr.body : null,
    comments,
    // The head sha every new line comment has to be pinned to.
    anchor: pr.head?.sha ? { headSha: pr.head.sha, baseSha: null, startSha: null } : null,
  };
  discussionCache.set(key, { at: Date.now(), discussion });
  return discussion;
}

/**
 * Post to a pull request. A plain comment goes to the issue-comments endpoint
 * (a review with no verdict would show up as an empty review); approve and
 * request-changes go through the reviews endpoint as real verdicts.
 */
export async function postPullRequestReview(
  host: string, token: string, projectPath: string, number: number, input: ReviewSubmission,
): Promise<void> {
  const [pathname, payload] = input.event === 'comment'
    ? [`/repos/${projectPath}/issues/${number}/comments`, { body: input.body }]
    : [
        `/repos/${projectPath}/pulls/${number}/reviews`,
        { body: input.body, event: input.event === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES' },
      ];
  const res = await githubApiFetch(host, token, pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, { allowForbidden: true });
  if (res.status === 403) throw githubForbidden(res, await res.json().catch(() => null));
  if (res.status === 404) {
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  // 422 is the everyday refusal: approving your own PR, an empty
  // request-changes body, a PR that no longer accepts reviews.
  if (res.status === 422) {
    throw new AppError('VALIDATION', githubMessage(await res.json().catch(() => null), 'GitHub refused the review'));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} posting the review`);
  discussionCache.delete(`${host}\0${projectPath}\0${number}`);
  invalidateMrCache(host, projectPath);
}

type GithubCommit = {
  sha?: string; html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } | null } | null;
  author?: { login?: string } | null;
};

const commitsCache = new Map<string, { at: number; commits: ReviewCommit[] }>();

export async function pullRequestCommits(
  host: string, token: string, projectPath: string, number: number,
): Promise<ReviewCommit[]> {
  const key = `${host}\0${projectPath}\0${number}`;
  const hit = commitsCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.commits;

  const raw = await githubCollection<GithubCommit>(
    host, token, `/repos/${projectPath}/pulls/${number}/commits`, 'PR commits',
  );

  const commits: ReviewCommit[] = raw.map((commit) => ({
    sha: commit.sha ?? '',
    shortSha: (commit.sha ?? '').slice(0, 8),
    // GitHub returns the whole message; the review list wants the subject.
    title: (commit.commit?.message ?? '').split('\n')[0] || '(no message)',
    author: commit.author?.login ?? commit.commit?.author?.name ?? null,
    createdAt: commit.commit?.author?.date ?? '',
    webUrl: commit.html_url ?? null,
  }));
  commitsCache.set(key, { at: Date.now(), commits });
  return commits;
}

const commitChangesCache = new Map<string, { at: number; files: MergeRequestChange[] }>();

/** One commit's own diff — the same shape the PR-wide files endpoint returns. */
export async function commitChanges(
  host: string, token: string, projectPath: string, sha: string,
): Promise<MergeRequestChange[]> {
  const key = `${host}\0${projectPath}\0${sha}`;
  const hit = commitChangesCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;

  const raw: GithubFile[] = [];
  for (let page = 1; ; page += 1) {
    const res = await githubApiFetch(
      host, token, `/repos/${projectPath}/commits/${encodeURIComponent(sha)}?per_page=100&page=${page}`,
    );
    if (res.status === 404) {
      throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
    }
    if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} fetching the commit diff`);
    const body = (await res.json()) as { files?: GithubFile[] };
    const batch = body.files ?? [];
    raw.push(...batch);
    if (batch.length < 100) break;
  }

  const files: MergeRequestChange[] = raw.map((f) => {
    const status: MergeRequestChange['status'] =
      f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M';
    const diff = f.patch ?? '';
    return {
      path: f.filename ?? '',
      oldPath: f.status === 'renamed' ? f.previous_filename : undefined,
      status,
      diff,
      truncated: !diff && status !== 'A' ? true : undefined,
    };
  });
  commitChangesCache.set(key, { at: Date.now(), files });
  return files;
}

/** A comment pinned to a diff line, against the PR's current head commit. */
export async function postPullRequestLineComment(
  host: string, token: string, projectPath: string, number: number,
  input: LineComment, anchor: ReviewAnchor,
): Promise<void> {
  const res = await githubApiFetch(host, token, `/repos/${projectPath}/pulls/${number}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body: input.body,
      commit_id: anchor.headSha,
      path: input.path,
      line: input.line,
      side: input.side === 'old' ? 'LEFT' : 'RIGHT',
    }),
  }, { allowForbidden: true });
  if (res.status === 403) throw githubForbidden(res, await res.json().catch(() => null));
  if (res.status === 404) {
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  if (res.status === 422) {
    // Most often: the line is not part of this diff, or the head moved.
    throw new AppError('VALIDATION', githubMessage(await res.json().catch(() => null), 'GitHub could not pin a comment to that line'));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} posting the line comment`);
  discussionCache.delete(`${host}\0${projectPath}\0${number}`);
}

export async function pullRequestChanges(
  host: string, token: string, projectPath: string, number: number,
): Promise<ReviewChanges> {
  const key = `${host}\0${projectPath}\0${number}`;
  const hit = changesCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.changes;

  const detailRes = await githubApiFetch(host, token, `/repos/${projectPath}/pulls/${number}`);
  if (detailRes.status === 404) {
    // GitHub 404s private repos the token can't see — steer to reconnect
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  if (!detailRes.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${detailRes.status} fetching the PR`);
  const detail = (await detailRes.json()) as GithubPr;
  const total = typeof detail.changed_files === 'number' ? detail.changed_files : null;
  // GitHub exposes at most 3,000 files for one pull request. Fetch every page
  // it makes available and report the provider limit instead of pretending the
  // first 100 files are the whole review.
  const pageCount = Math.max(1, Math.ceil(Math.min(total ?? 3_000, 3_000) / 100));
  const raw: GithubFile[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const res = await githubApiFetch(
      host, token, `/repos/${projectPath}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} fetching PR files`);
    const batch = (await res.json()) as GithubFile[];
    raw.push(...batch);
    if (batch.length < 100) break;
  }

  const files: MergeRequestChange[] = raw.map((f) => {
    const status: MergeRequestChange['status'] =
      f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M';
    const diff = f.patch ?? '';
    return {
      path: f.filename ?? '',
      oldPath: f.status === 'renamed' ? f.previous_filename : undefined,
      status,
      diff,
      // No patch on a non-add means binary or too large — same rule as GitLab.
      truncated: !diff && status !== 'A' ? true : undefined,
    };
  });
  const changes = {
    files,
    truncated: (total !== null && total > files.length) || (total === null && files.length === 3_000),
    total,
  };
  changesCache.set(key, { at: Date.now(), changes });
  return changes;
}
