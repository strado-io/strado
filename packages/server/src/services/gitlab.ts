import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError, AuthError } from '../errors.js';

const ConfigSchema = z.record(z.string(), z.object({ token: z.string().min(1) }));
export type GitlabConfig = z.infer<typeof ConfigSchema>;

export function gitlabConfigPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'gitlab.json');
}

export async function readGitlabConfig(): Promise<GitlabConfig> {
  try {
    return ConfigSchema.parse(JSON.parse(await fsp.readFile(gitlabConfigPath(), 'utf8')));
  } catch {
    return {};
  }
}

export function gitlabHostToken(cfg: GitlabConfig, host: string): string | null {
  return cfg[host]?.token ?? null;
}

// An unreachable host (VPN off, DNS blackhole) otherwise hangs the TCP
// connect for ~75s per request and stalls everything queued behind it.
const REQUEST_TIMEOUT_MS = 10_000;

// Shared fetch: PRIVATE-TOKEN auth, normalized error mapping.
export async function gitlabApiFetch(
  host: string,
  token: string,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`https://${host}/api/v4${pathname}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'PRIVATE-TOKEN': token, accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new AppError('VALIDATION', `GitLab at ${host} did not respond within 10s — check your network/VPN`);
    }
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError('GitLab rejected the token — check its scope (api) and expiry');
  }
  return res;
}

export async function writeGitlabHost(host: string, token: string): Promise<{ username: string }> {
  const res = await gitlabApiFetch(host, token, '/user');
  if (!res.ok) throw new AppError('VALIDATION', `GitLab responded ${res.status} validating the token`);
  const me = (await res.json()) as { username?: string };
  const cfg = await readGitlabConfig();
  cfg[host] = { token };
  const file = gitlabConfigPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { username: me?.username ?? host };
}

export async function removeGitlabHost(host: string): Promise<void> {
  const cfg = await readGitlabConfig();
  if (!(host in cfg)) return;
  delete cfg[host];
  await fsp.writeFile(gitlabConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export type MergeRequest = {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  webUrl: string;
  pipeline: 'success' | 'failed' | 'running' | 'pending' | 'canceled' | null;
  approvals: { given: number; required: number } | null;
  sourceBranch: string;
  targetBranch: string | null;
  updatedAt: string;
  author: string | null;
  createdAt: string | null;
  mergedAt: string | null;
};

type GitlabMr = {
  iid: number; title?: string; state?: string; web_url?: string;
  source_branch?: string; target_branch?: string; updated_at?: string;
  created_at?: string; merged_at?: string | null;
  author?: { name?: string; username?: string } | null;
  head_pipeline?: { status?: string } | null; pipeline?: { status?: string } | null;
};

const PIPELINE = new Set(['success', 'failed', 'running', 'pending', 'canceled']);
function mapPipeline(s?: string): MergeRequest['pipeline'] {
  return s && PIPELINE.has(s) ? (s as MergeRequest['pipeline']) : null;
}
function mapState(s?: string): MergeRequest['state'] {
  return s === 'opened' ? 'open' : s === 'merged' ? 'merged' : 'closed';
}

const cache = new Map<string, { at: number; mrs: MergeRequest[] }>();
const TTL_MS = 60_000;

export async function mergeRequestsForBranch(
  host: string,
  token: string,
  projectPath: string,
  branch: string,
  opts?: { force?: boolean },
): Promise<MergeRequest[]> {
  const key = `${host}\0${projectPath}\0${branch}`;
  const hit = cache.get(key);
  if (!opts?.force && hit && Date.now() - hit.at < TTL_MS) return hit.mrs;

  const proj = encodeURIComponent(projectPath);
  const listRes = await gitlabApiFetch(
    host, token,
    `/projects/${proj}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&per_page=10`,
  );
  if (!listRes.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${listRes.status} listing MRs`);
  const raw = (await listRes.json()) as GitlabMr[];

  const mrs: MergeRequest[] = [];
  for (const m of raw) {
    const state = mapState(m.state);
    let approvals: MergeRequest['approvals'] = null;
    if (state === 'open') {
      try {
        const aRes = await gitlabApiFetch(host, token, `/projects/${proj}/merge_requests/${m.iid}/approvals`);
        if (aRes.ok) {
          const a = (await aRes.json()) as { approvals_required?: number; approved_by?: unknown[] };
          if (typeof a.approvals_required === 'number') {
            approvals = { given: a.approved_by?.length ?? 0, required: a.approvals_required };
          }
        }
      } catch {
        approvals = null; // CE / no approval rules
      }
    }
    mrs.push({
      number: m.iid,
      title: m.title ?? '',
      state,
      webUrl: m.web_url ?? '',
      pipeline: mapPipeline(m.head_pipeline?.status ?? m.pipeline?.status),
      approvals,
      sourceBranch: m.source_branch ?? branch,
      targetBranch: m.target_branch ?? null,
      updatedAt: m.updated_at ?? '',
      author: m.author?.name || m.author?.username || null,
      createdAt: m.created_at ?? null,
      mergedAt: m.merged_at ?? null,
    });
  }
  // open first, then most-recently-updated
  mrs.sort((a, b) =>
    (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
    b.updatedAt.localeCompare(a.updatedAt),
  );
  cache.set(key, { at: Date.now(), mrs });
  return mrs;
}

export type MergeRequestChange = {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  diff: string;
  truncated?: boolean;
};

type GitlabChange = {
  old_path?: string; new_path?: string;
  new_file?: boolean; deleted_file?: boolean; renamed_file?: boolean;
  diff?: string;
};

const changesCache = new Map<string, { at: number; files: MergeRequestChange[] }>();

export async function mergeRequestChanges(
  host: string, token: string, projectPath: string, iid: number,
): Promise<MergeRequestChange[]> {
  const key = `${host}\0${projectPath}\0${iid}`;
  const hit = changesCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;

  const proj = encodeURIComponent(projectPath);
  const res = await gitlabApiFetch(host, token, `/projects/${proj}/merge_requests/${iid}/changes`);
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} fetching MR changes`);
  const body = (await res.json()) as { changes?: GitlabChange[] };

  const files: MergeRequestChange[] = (body.changes ?? []).map((c) => {
    const status: MergeRequestChange['status'] =
      c.new_file ? 'A' : c.deleted_file ? 'D' : c.renamed_file ? 'R' : 'M';
    const diff = c.diff ?? '';
    return {
      path: c.new_path || c.old_path || '',
      oldPath: c.renamed_file ? c.old_path : undefined,
      status,
      diff,
      // GitLab collapses large diffs: a non-add file with no diff string is truncated/binary.
      truncated: !diff && status !== 'A' ? true : undefined,
    };
  });
  changesCache.set(key, { at: Date.now(), files });
  return files;
}

export function invalidateMrCache(host: string, projectPath: string, branch: string): void {
  cache.delete(`${host}\0${projectPath}\0${branch}`);
}

// GitLab error bodies carry `message` as a string or array of strings.
function gitlabMessage(body: unknown, fallback: string): string {
  const m = (body as { message?: string | string[] } | null)?.message;
  return Array.isArray(m) ? m.join('; ') : m || fallback;
}

function mapMr(m: GitlabMr, sourceFallback: string): MergeRequest {
  return {
    number: m.iid,
    title: m.title ?? '',
    state: mapState(m.state),
    webUrl: m.web_url ?? '',
    pipeline: mapPipeline(m.head_pipeline?.status ?? m.pipeline?.status),
    approvals: null,
    sourceBranch: m.source_branch ?? sourceFallback,
    targetBranch: m.target_branch ?? null,
    updatedAt: m.updated_at ?? '',
    author: m.author?.name || m.author?.username || null,
    createdAt: m.created_at ?? null,
    mergedAt: m.merged_at ?? null,
  };
}

export async function createMergeRequest(
  host: string, token: string, projectPath: string,
  input: { sourceBranch: string; targetBranch: string; title: string; description?: string },
): Promise<MergeRequest> {
  const proj = encodeURIComponent(projectPath);
  const res = await gitlabApiFetch(host, token, `/projects/${proj}/merge_requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
    }),
  });
  if (res.status === 409 || res.status === 422 || res.status === 400) {
    throw new AppError('VALIDATION', gitlabMessage(await res.json().catch(() => null), `GitLab refused to create the MR (${res.status})`));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} creating the MR`);
  const mr = mapMr((await res.json()) as GitlabMr, input.sourceBranch);
  invalidateMrCache(host, projectPath, mr.sourceBranch);
  return mr;
}

export async function mergeMergeRequest(
  host: string, token: string, projectPath: string, iid: number,
): Promise<MergeRequest> {
  const proj = encodeURIComponent(projectPath);
  const res = await gitlabApiFetch(host, token, `/projects/${proj}/merge_requests/${iid}/merge`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if ([405, 406, 409, 422].includes(res.status)) {
    throw new AppError('VALIDATION', gitlabMessage(await res.json().catch(() => null), 'GitLab refused the merge (conflicts or unmet requirements)'));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} merging the MR`);
  const mr = mapMr((await res.json()) as GitlabMr, '');
  if (mr.sourceBranch) invalidateMrCache(host, projectPath, mr.sourceBranch);
  return mr;
}
