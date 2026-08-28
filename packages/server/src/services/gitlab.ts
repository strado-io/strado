import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError, AuthError } from '../errors.js';

const ConfigSchema = z.record(z.string(), z.object({ token: z.string().min(1) }));
export type GitlabConfig = z.infer<typeof ConfigSchema>;
export const REVIEW_PAGE_SIZE = 20;

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
  // Writes opt out of the blanket 403 so they can name the real cause: a
  // read_api-only token reads everything and refuses every write.
  opts?: { allowForbidden?: boolean },
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
  if (res.status === 401 || (res.status === 403 && !opts?.allowForbidden)) {
    throw new AuthError('GitLab rejected the token — check its scope (api) and expiry');
  }
  return res;
}

/** Read every page of a GitLab REST collection instead of silently stopping at 100. */
async function gitlabCollection<T>(
  host: string, token: string, pathname: string, what: string,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = pathname.includes('?') ? '&' : '?';
    const res = await gitlabApiFetch(host, token, `${pathname}${separator}per_page=100&page=${page}`);
    if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} fetching ${what}`);
    const batch = (await res.json()) as T[];
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

/** A GitLab write refusal, said plainly — usually a read-only token scope. */
function gitlabForbidden(body: unknown): AppError {
  const reason = gitlabMessage(body, 'GitLab refused the write');
  return new AppError(
    'VALIDATION',
    `${reason} — the saved token cannot write here. A token with the "api" scope is required ("read_api" can only read.)`,
  );
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

export type ReviewCounts = { open: number; merged: number; closed: number };

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

async function mergeRequests(
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

  const proj = encodeURIComponent(projectPath);
  const branchQuery = branch ? `source_branch=${encodeURIComponent(branch)}&` : '';
  const stateQuery = requestedState === 'open' ? 'opened' : requestedState ?? 'all';
  const searchQuery = search ? `&search=${encodeURIComponent(search)}` : '';
  const listRes = await gitlabApiFetch(
    host, token,
    `/projects/${proj}/merge_requests?${branchQuery}state=${stateQuery}&order_by=updated_at&sort=desc&per_page=${limit}&page=${page}${searchQuery}`,
  );
  if (!listRes.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${listRes.status} listing MRs`);
  const raw = (await listRes.json()) as GitlabMr[];

  const mrs = await mapConcurrent(raw, async (m): Promise<MergeRequest> => {
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
    return {
      number: m.iid,
      title: m.title ?? '',
      state,
      webUrl: m.web_url ?? '',
      pipeline: mapPipeline(m.head_pipeline?.status ?? m.pipeline?.status),
      approvals,
      sourceBranch: m.source_branch ?? branch ?? '',
      targetBranch: m.target_branch ?? null,
      updatedAt: m.updated_at ?? '',
      author: m.author?.name || m.author?.username || null,
      createdAt: m.created_at ?? null,
      mergedAt: m.merged_at ?? null,
    };
  });
  // open first, then most-recently-updated
  mrs.sort((a, b) =>
    (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
    b.updatedAt.localeCompare(a.updatedAt),
  );
  cache.set(key, { at: Date.now(), mrs });
  return mrs;
}

export function mergeRequestsForBranch(
  host: string,
  token: string,
  projectPath: string,
  branch: string,
  opts?: { force?: boolean },
): Promise<MergeRequest[]> {
  return mergeRequests(host, token, projectPath, branch, opts);
}

/** The most recently updated merge requests for a repository. */
export function mergeRequestsForProject(
  host: string,
  token: string,
  projectPath: string,
  opts?: { force?: boolean; state?: MergeRequest['state']; page?: number; search?: string; limit?: number },
): Promise<MergeRequest[]> {
  return mergeRequests(host, token, projectPath, null, opts);
}

const countCache = new Map<string, { at: number; counts: ReviewCounts }>();

// GitLab omits X-Total for very large result sets. Find the last populated
// page with exponential + binary search instead of downloading every MR.
async function countGitlabPages(
  host: string,
  token: string,
  projectPath: string,
  providerState: string,
): Promise<number> {
  const proj = encodeURIComponent(projectPath);
  const pageSizes = new Map<number, number>();
  const probe = async (page: number) => {
    const cached = pageSizes.get(page);
    if (cached != null) return cached;
    const res = await gitlabApiFetch(
      host, token,
      `/projects/${proj}/merge_requests?state=${providerState}&per_page=100&page=${page}`,
    );
    if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} counting MRs`);
    const size = ((await res.json()) as unknown[]).length;
    pageSizes.set(page, size);
    return size;
  };

  if (await probe(1) === 0) return 0;
  let populated = 1;
  let empty = 2;
  while (await probe(empty) > 0) {
    populated = empty;
    empty *= 2;
  }
  while (empty - populated > 1) {
    const middle = Math.floor((populated + empty) / 2);
    if (await probe(middle) > 0) populated = middle;
    else empty = middle;
  }
  const lastSize = await probe(populated);
  return (populated - 1) * 100 + lastSize;
}

/** Exact remote totals, with a logarithmic fallback when X-Total is omitted. */
export async function mergeRequestCountsForProject(
  host: string,
  token: string,
  projectPath: string,
  opts?: { force?: boolean },
): Promise<ReviewCounts> {
  const key = `${host}\0${projectPath}`;
  const hit = countCache.get(key);
  if (!opts?.force && hit && Date.now() - hit.at < TTL_MS) return hit.counts;
  const proj = encodeURIComponent(projectPath);
  const entries = await Promise.all(([
    ['open', 'opened'], ['merged', 'merged'], ['closed', 'closed'],
  ] as const).map(async ([keyName, providerState]) => {
    const res = await gitlabApiFetch(
      host, token,
      `/projects/${proj}/merge_requests?state=${providerState}&per_page=1&page=1`,
    );
    if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} counting MRs`);
    const header = Number.parseInt(res.headers.get('x-total') ?? '', 10);
    if (Number.isFinite(header)) return [keyName, header] as const;
    const body = (await res.json()) as unknown[];
    if (body.length === 0) return [keyName, 0] as const;
    return [keyName, await countGitlabPages(host, token, projectPath, providerState)] as const;
  }));
  const counts = Object.fromEntries(entries) as ReviewCounts;
  countCache.set(key, { at: Date.now(), counts });
  return counts;
}

/**
 * A review conversation: the merge request body plus every human note on it.
 * `path`/`line` are set for notes anchored to a diff line; `kind` carries the
 * approve / request-changes signal GitHub attaches to a review submission.
 */
export type ReviewComment = {
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  /** Which side of the diff `line` counts on — a deletion anchors on 'old'. */
  side: 'new' | 'old';
  kind: 'comment' | 'approved' | 'changes-requested';
  webUrl: string | null;
};

/** The shas a new line comment has to be positioned against. */
export type ReviewAnchor = { headSha: string; baseSha: string | null; startSha: string | null };

export type ReviewDiscussion = {
  description: string | null;
  comments: ReviewComment[];
  anchor: ReviewAnchor | null;
};

export type LineComment = {
  body: string;
  path: string;
  /** The pre-rename path; GitLab rejects a position without it on renames. */
  oldPath?: string;
  line: number;
  side: 'new' | 'old';
};

/** One commit on a review, with the subject split off the message body. */
export type ReviewCommit = {
  sha: string;
  shortSha: string;
  title: string;
  author: string | null;
  createdAt: string;
  webUrl: string | null;
};

export type MergeRequestChange = {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  diff: string;
  truncated?: boolean;
};

/** Provider-wide change collection plus an explicit completeness signal. */
export type ReviewChanges = {
  files: MergeRequestChange[];
  truncated: boolean;
  total: number | null;
};

type GitlabChange = {
  old_path?: string; new_path?: string;
  new_file?: boolean; deleted_file?: boolean; renamed_file?: boolean;
  diff?: string;
};

const changesCache = new Map<string, { at: number; changes: ReviewChanges }>();

export async function mergeRequestChanges(
  host: string, token: string, projectPath: string, iid: number,
): Promise<ReviewChanges> {
  const key = `${host}\0${projectPath}\0${iid}`;
  const hit = changesCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.changes;

  const proj = encodeURIComponent(projectPath);
  const res = await gitlabApiFetch(host, token, `/projects/${proj}/merge_requests/${iid}/changes`);
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} fetching MR changes`);
  const body = (await res.json()) as { changes?: GitlabChange[]; overflow?: boolean; changes_count?: string | number };

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
  const parsedTotal = typeof body.changes_count === 'number'
    ? body.changes_count
    : /^\d+$/.test(body.changes_count ?? '') ? Number.parseInt(body.changes_count!, 10) : Number.NaN;
  const total = Number.isFinite(parsedTotal) ? parsedTotal : null;
  const changes = { files, truncated: body.overflow === true || (total !== null && total > files.length), total };
  changesCache.set(key, { at: Date.now(), changes });
  return changes;
}

type GitlabNote = {
  id?: number;
  body?: string | null;
  created_at?: string;
  system?: boolean;
  author?: { name?: string; username?: string } | null;
  position?: { new_path?: string | null; old_path?: string | null; new_line?: number | null; old_line?: number | null } | null;
};

const discussionCache = new Map<string, { at: number; discussion: ReviewDiscussion }>();

export async function mergeRequestDiscussion(
  host: string, token: string, projectPath: string, iid: number,
): Promise<ReviewDiscussion> {
  const key = `${host}\0${projectPath}\0${iid}`;
  const hit = discussionCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.discussion;

  const proj = encodeURIComponent(projectPath);
  const [mrRes, notes] = await Promise.all([
    gitlabApiFetch(host, token, `/projects/${proj}/merge_requests/${iid}`),
    gitlabCollection<GitlabNote>(
      host, token, `/projects/${proj}/merge_requests/${iid}/notes?sort=asc&order_by=created_at`, 'MR notes',
    ),
  ]);
  if (!mrRes.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${mrRes.status} fetching the merge request`);
  const mr = (await mrRes.json()) as {
    description?: string | null;
    web_url?: string;
    diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } | null;
  };

  const discussion: ReviewDiscussion = {
    description: mr.description?.trim() ? mr.description : null,
    // System notes are the activity feed ("assigned to…", "added 3 commits"),
    // not conversation — they would bury the actual review.
    comments: notes.filter((note) => !note.system && note.body?.trim()).map((note) => ({
      id: String(note.id ?? ''),
      author: note.author?.name ?? note.author?.username ?? null,
      body: note.body ?? '',
      createdAt: note.created_at ?? '',
      path: note.position?.new_path ?? note.position?.old_path ?? null,
      line: note.position?.new_line ?? note.position?.old_line ?? null,
      side: note.position?.new_line ? 'new' as const : 'old' as const,
      kind: 'comment' as const,
      webUrl: mr.web_url ? `${mr.web_url}#note_${note.id}` : null,
    })).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    anchor: mr.diff_refs?.head_sha
      ? {
          headSha: mr.diff_refs.head_sha,
          baseSha: mr.diff_refs.base_sha ?? null,
          startSha: mr.diff_refs.start_sha ?? null,
        }
      : null,
  };
  discussionCache.set(key, { at: Date.now(), discussion });
  return discussion;
}

export type ReviewSubmission = { body: string; event: 'comment' | 'approve' | 'request-changes' };

/**
 * Post to a merge request: a plain note, or an approval (optionally carrying
 * a note). GitLab has no native "request changes" verdict, so that event is
 * refused here rather than silently downgraded to a comment.
 */
export async function postMergeRequestReview(
  host: string, token: string, projectPath: string, iid: number, input: ReviewSubmission,
): Promise<void> {
  if (input.event === 'request-changes') {
    throw new AppError('VALIDATION', 'GitLab has no “request changes” verdict — leave a comment instead');
  }
  const proj = encodeURIComponent(projectPath);
  const post = (pathname: string, body: unknown) => gitlabApiFetch(host, token, pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, { allowForbidden: true });

  // Approve first: this is two writes and cannot be one, so the refusable half
  // goes first. Posting the note first would leave it public after a rejected
  // approval, and the composer — which only clears on success — would tempt a
  // retry that posts it twice.
  if (input.event === 'approve') {
    const res = await post(`/projects/${proj}/merge_requests/${iid}/approve`, {});
    if (res.status === 403) throw gitlabForbidden(await res.json().catch(() => null));
    if (res.status === 404) {
      // Approvals are a paid feature on some instances; the endpoint simply
      // isn't there, which reads as 404 rather than a permissions error.
      throw new AppError('VALIDATION', 'This GitLab instance does not offer merge request approvals');
    }
    if (!res.ok) {
      throw new AppError('SHELL_FAILED', gitlabMessage(await res.json().catch(() => null), `GitLab responded ${res.status} approving the MR`));
    }
    // The approval is already public even if the optional note below fails.
    // Invalidate immediately so a failed second write cannot leave stale chips.
    invalidateMrCache(host, projectPath);
  }
  if (input.body.trim()) {
    const res = await post(`/projects/${proj}/merge_requests/${iid}/notes`, { body: input.body });
    if (res.status === 403) throw gitlabForbidden(await res.json().catch(() => null));
    if (!res.ok) {
      throw new AppError('SHELL_FAILED', gitlabMessage(await res.json().catch(() => null), `GitLab responded ${res.status} posting the comment`));
    }
  }
  discussionCache.delete(`${host}\0${projectPath}\0${iid}`);
}

type GitlabCommit = {
  id?: string; short_id?: string; title?: string; message?: string;
  author_name?: string; created_at?: string; web_url?: string;
};

const commitsCache = new Map<string, { at: number; commits: ReviewCommit[] }>();

export async function mergeRequestCommits(
  host: string, token: string, projectPath: string, iid: number,
): Promise<ReviewCommit[]> {
  const key = `${host}\0${projectPath}\0${iid}`;
  const hit = commitsCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.commits;

  const proj = encodeURIComponent(projectPath);
  const raw = await gitlabCollection<GitlabCommit>(
    host, token, `/projects/${proj}/merge_requests/${iid}/commits`, 'MR commits',
  );

  const commits: ReviewCommit[] = raw.map((commit) => ({
    sha: commit.id ?? '',
    shortSha: commit.short_id ?? (commit.id ?? '').slice(0, 8),
    title: commit.title || (commit.message ?? '').split('\n')[0] || '(no message)',
    author: commit.author_name ?? null,
    createdAt: commit.created_at ?? '',
    webUrl: commit.web_url ?? null,
  }));
  commitsCache.set(key, { at: Date.now(), commits });
  return commits;
}

const commitChangesCache = new Map<string, { at: number; files: MergeRequestChange[] }>();

/** One commit's own diff — the same shape the MR-wide changes endpoint returns. */
export async function commitChanges(
  host: string, token: string, projectPath: string, sha: string,
): Promise<MergeRequestChange[]> {
  const key = `${host}\0${projectPath}\0${sha}`;
  const hit = commitChangesCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;

  const proj = encodeURIComponent(projectPath);
  const raw = await gitlabCollection<GitlabChange>(
    host, token, `/projects/${proj}/repository/commits/${encodeURIComponent(sha)}/diff`, 'the commit diff',
  );

  const files: MergeRequestChange[] = raw.map((c) => {
    const status: MergeRequestChange['status'] =
      c.new_file ? 'A' : c.deleted_file ? 'D' : c.renamed_file ? 'R' : 'M';
    const diff = c.diff ?? '';
    return {
      path: c.new_path || c.old_path || '',
      oldPath: c.renamed_file ? c.old_path : undefined,
      status,
      diff,
      truncated: !diff && status !== 'A' ? true : undefined,
    };
  });
  commitChangesCache.set(key, { at: Date.now(), files });
  return files;
}

/**
 * A note pinned to a diff line. GitLab wants the full position — both paths
 * and the three shas the diff was taken against — or it rejects the note.
 */
export async function postMergeRequestLineComment(
  host: string, token: string, projectPath: string, iid: number,
  input: LineComment, anchor: ReviewAnchor,
): Promise<void> {
  const proj = encodeURIComponent(projectPath);
  const position: Record<string, unknown> = {
    position_type: 'text',
    base_sha: anchor.baseSha ?? anchor.headSha,
    start_sha: anchor.startSha ?? anchor.baseSha ?? anchor.headSha,
    head_sha: anchor.headSha,
    new_path: input.path,
    old_path: input.oldPath || input.path,
  };
  if (input.side === 'new') position.new_line = input.line;
  else position.old_line = input.line;

  const res = await gitlabApiFetch(host, token, `/projects/${proj}/merge_requests/${iid}/discussions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: input.body, position }),
  }, { allowForbidden: true });
  if (res.status === 403) throw gitlabForbidden(await res.json().catch(() => null));
  if ([400, 422].includes(res.status)) {
    throw new AppError('VALIDATION', gitlabMessage(await res.json().catch(() => null), 'GitLab could not pin a note to that line'));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} posting the line comment`);
  discussionCache.delete(`${host}\0${projectPath}\0${iid}`);
}

export function invalidateMrCache(host: string, projectPath: string, branch?: string): void {
  const prefix = `${host}\0${projectPath}\0`;
  for (const key of cache.keys()) {
    if (!branch || key === `${prefix}${branch}` || key.startsWith(`${prefix}*:`)) cache.delete(key);
  }
  countCache.delete(`${host}\0${projectPath}`);
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
  }, { allowForbidden: true });
  if (res.status === 403) throw gitlabForbidden(await res.json().catch(() => null));
  if ([405, 406, 409, 422].includes(res.status)) {
    throw new AppError('VALIDATION', gitlabMessage(await res.json().catch(() => null), 'GitLab refused the merge (conflicts or unmet requirements)'));
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `GitLab responded ${res.status} merging the MR`);
  const mr = mapMr((await res.json()) as GitlabMr, '');
  if (mr.sourceBranch) invalidateMrCache(host, projectPath, mr.sourceBranch);
  return mr;
}
