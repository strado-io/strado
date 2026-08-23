import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError, AuthError } from '../errors.js';
import type { MergeRequest, MergeRequestChange } from './gitlab.js';

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
  if (res.status === 401 || res.status === 403) {
    // 403 also covers rate-limit exhaustion; both read as "reconnect" in the
    // UI, which is acceptable at our 60s-cached request volume.
    throw new AuthError('GitHub rejected the token — check its repo access and expiry');
  }
  return res;
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
};
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

export async function pullRequestsForBranch(
  host: string,
  token: string,
  projectPath: string,
  branch: string,
  opts?: { force?: boolean },
): Promise<MergeRequest[]> {
  const key = `${host}\0${projectPath}\0${branch}`;
  const hit = cache.get(key);
  if (!opts?.force && hit && Date.now() - hit.at < TTL_MS) return hit.mrs;

  // Worktree branches are pushed to origin, so the head owner is the repo
  // owner (first projectPath segment). Fork PRs are out of scope.
  const owner = projectPath.split('/')[0] ?? '';
  const head = encodeURIComponent(`${owner}:${branch}`);
  const listRes = await githubApiFetch(
    host, token,
    `/repos/${projectPath}/pulls?head=${head}&state=all&sort=updated&direction=desc&per_page=10`,
  );
  if (listRes.status === 404) {
    // GitHub 404s private repos the token can't see — steer to reconnect
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  if (!listRes.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${listRes.status} listing PRs`);
  const raw = (await listRes.json()) as GithubPr[];

  const mrs: MergeRequest[] = [];
  for (const pr of raw) {
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
    mrs.push({
      number: pr.number,
      title: pr.title ?? '',
      state,
      webUrl: pr.html_url ?? '',
      pipeline,
      // Required-approval counts live in branch protection, unreadable by
      // most tokens — omit rather than mislead. The UI hides a null chip.
      approvals: null,
      sourceBranch: pr.head?.ref ?? branch,
      targetBranch: pr.base?.ref ?? null,
      updatedAt: pr.updated_at ?? '',
      author: pr.user?.login ?? null,
      createdAt: pr.created_at ?? null,
      mergedAt: pr.merged_at ?? null,
    });
  }
  mrs.sort((a, b) =>
    (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
    b.updatedAt.localeCompare(a.updatedAt),
  );
  cache.set(key, { at: Date.now(), mrs });
  return mrs;
}

export function invalidateMrCache(host: string, projectPath: string, branch: string): void {
  cache.delete(`${host}\0${projectPath}\0${branch}`);
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
  });
  if (res.status === 404) {
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  if ([405, 409, 422].includes(res.status)) {
    throw new AppError('VALIDATION', githubMessage(await res.json().catch(() => null), 'GitHub refused the merge (conflicts or required checks)'));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} merging the PR`);
}

const changesCache = new Map<string, { at: number; files: MergeRequestChange[] }>();

export async function pullRequestChanges(
  host: string, token: string, projectPath: string, number: number,
): Promise<MergeRequestChange[]> {
  const key = `${host}\0${projectPath}\0${number}`;
  const hit = changesCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;

  const res = await githubApiFetch(
    host, token, `/repos/${projectPath}/pulls/${number}/files?per_page=100`,
  );
  if (res.status === 404) {
    // GitHub 404s private repos the token can't see — steer to reconnect
    throw new AuthError('GitHub returned 404 — the saved token cannot see this repository; add a token for its owner');
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitHub responded ${res.status} fetching PR files`);
  const raw = (await res.json()) as GithubFile[];

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
  changesCache.set(key, { at: Date.now(), files });
  return files;
}
