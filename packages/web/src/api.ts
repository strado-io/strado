import type { RepoConfig, Worktree, ProcInfo, Workspace, WorkflowStatus, MergeRequest, MergeRequestChange, ReviewDiscussion, ReviewCommit, CodeReview, CodeReviewCounts, CodeReviewRepository, MachineSample, UsageAccount, UsageSummary } from './types';

/** Per-worktree outcome of a merge-request lookup, as the batch route reports it. */
export type WorktreeMergeRequests =
  | { kind: 'absent' }
  | { kind: 'needsAuth'; provider: 'gitlab' | 'github' }
  | { kind: 'list'; provider: 'gitlab' | 'github'; mergeRequests: MergeRequest[] }
  | { kind: 'error'; message: string };

export class ApiClientError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Every call gets a deadline. The server already caps each upstream provider
// call at 10s, but a route can chain several, and a browser only gives an
// origin six HTTP/1.1 sockets — a couple of which SSE holds permanently. One
// unreachable host (VPN off) was enough to park every remaining socket on
// 10s requests, so unrelated calls — closing a shell, listing worktrees —
// queued in the browser and the app looked frozen. A client-side deadline is
// the backstop that guarantees a socket always comes back.
const DEFAULT_TIMEOUT_MS = 30_000;

/** Opt out with `timeoutMs: 0` for calls that are legitimately unbounded (git clone). */
type RequestOpts = { timeoutMs?: number };

async function request<T>(url: string, init?: RequestInit, opts?: RequestOpts): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body != null) headers['content-type'] = 'application/json';
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A plain AbortController + setTimeout rather than AbortSignal.timeout: it
  // composes with a caller-supplied signal and is clearable, so a settled
  // request leaves no pending timer behind.
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const caller = init?.signal;
  const onCallerAbort = () => controller?.abort();
  if (controller && caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, ...(controller ? { signal: controller.signal } : {}) });
  } catch (err) {
    // Only *our* deadline becomes TIMEOUT; a caller-driven abort (unmount)
    // must stay an abort so callers can keep ignoring it.
    if (controller?.signal.aborted && !caller?.aborted) {
      throw new ApiClientError('TIMEOUT', `Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    caller?.removeEventListener('abort', onCallerAbort);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiClientError(body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return body as T;
}

function wsBase(wsId: string): string {
  return `/api/w/${encodeURIComponent(wsId)}`;
}

export type DetectedRepo = RepoConfig & { warnings: string[] };

export type JiraIssueDto = {
  key: string;
  summary: string;
  status: string;
  category: 'new' | 'indeterminate' | 'done';
  assignee: string | null;
  priority: string | null;
  estimate: string | null;
  timeSpent: string | null;
  remaining: string | null;
  timeSpentSeconds: number | null;
  remainingSeconds: number | null;
};

export type JiraTransitionDto = {
  id: string;
  name: string;
  toStatus: string;
  toCategory: JiraIssueDto['category'];
};

export type TicketProviderId = 'jira' | 'linear';
export type TicketIssueDto = JiraIssueDto & { provider: TicketProviderId; url: string };
export type TicketSprintDto = { id: string; name: string; state: 'active' | 'future'; startDate: string | null; endDate: string | null };
export type TicketTransitionDto = { id: string; name: string; toStatus: string; toCategory: 'new' | 'indeterminate' | 'done' };

export type ToolStatus = {
  id: string;
  label: string;
  found: boolean;
  version: string | null;
  optional: boolean;
  hint: string | null;
  installable: boolean;
  installCommand: string | null;
};

export type Profile = { fullName: string; callMe: string; telemetryOptOut: boolean };
export type ModelCredentialSummary = { present: boolean; last4: string | null };

export type KbFile = { path: string; size: number; mtimeMs: number };

export type AgentMode = 'claude' | 'codex' | 'opencode' | 'pi';
export type Handoff = {
  id: string;
  workspaceId: string;
  worktreePath: string;
  taskLabel: string;
  source: { mode: AgentMode; sessionId: string };
  target: { mode: AgentMode; sessionId: string };
  status: 'ready' | 'accepted' | 'cancelled';
  notes: string;
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>;
  contextSource: 'claude-history' | 'codex-history' | 'opencode-history' | 'none';
  repository: { branch: string; head: string; status: string[]; diffStat: string };
  createdAt: string;
  acceptedAt: string | null;
};

export const api = {
  terminal: {
    peek: (ws: string, path: string, mode: string, session = '1') =>
      request<{ lines: string[] }>(
        `/api/terminal/peek?ws=${encodeURIComponent(ws)}&path=${encodeURIComponent(path)}&mode=${mode}&session=${session}`,
      ).then((b) => b.lines),
  },
  feedback: {
    submit: (body: {
      category: 'bug' | 'idea' | 'other';
      message: string;
      email?: string;
      includeDiagnostics: boolean;
      context?: string;
    }) =>
      request<{ ok: boolean }>('/api/feedback', { method: 'POST', body: JSON.stringify(body) }),
  },
  update: {
    check: () => request<{
      updateAvailable: boolean;
      current?: string;
      version?: string;
      url?: string;
      sha256?: string;
      debUrl?: string;
      notes?: string;
      mandatory?: boolean;
    }>('/api/update-check'),
  },
  envCheck: (fresh = false) =>
    request<{ tools: ToolStatus[] }>(`/api/env-check${fresh ? '?fresh=1' : ''}`).then((b) => b.tools),
  envInstall: {
    // The id is all the server accepts — the command it runs comes from the
    // server's own table, so nothing here can choose what executes.
    start: (id: string) => request<{ started: true }>(`/api/env-check/install/${encodeURIComponent(id)}`, { method: 'POST' }),
    cancel: (id: string) => request<{ cancelled: true }>(`/api/env-check/install/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  activity: {
    beat: (path: string) =>
      request<{ ok: boolean }>('/api/activity/beat', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    reset: (path: string) =>
      request<void>(`/api/activity/${encodeURIComponent(path)}`, { method: 'DELETE' }),
  },
  jira: {
    status: () => request<{ configured: boolean; baseUrl: string | null }>('/api/jira/status'),
    config: () =>
      request<{ baseUrl: string | null; email: string | null; hasToken: boolean }>('/api/jira/config'),
    saveConfig: (input: { baseUrl: string; email: string; apiToken: string }) =>
      request<{ ok: boolean; accountName: string }>('/api/jira/config', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    testConfig: () => request<{ ok: boolean; accountName: string }>('/api/jira/config/test', { method: 'POST' }),
  },
  tickets: {
    providers: () => request<{ providers: Array<{ provider: TicketProviderId; configured: boolean; label: string }> }>('/api/tickets/providers').then((b) => b.providers),
    issues: (refs: Array<{ provider: TicketProviderId; key: string }>) =>
      request<{ issues: Record<string, TicketIssueDto>; missing: string[]; errors: Partial<Record<TicketProviderId, string>> }>(
        '/api/tickets/issues', { method: 'POST', body: JSON.stringify({ refs }) }),
    myIssues: (provider: TicketProviderId) =>
      request<{ issues: TicketIssueDto[] }>(`/api/tickets/${provider}/my-issues`).then((b) => b.issues),
    sprints: (provider: TicketProviderId, project?: string) =>
      request<{ sprints: TicketSprintDto[] }>(`/api/tickets/${provider}/sprints${project ? `?project=${encodeURIComponent(project)}` : ''}`).then((b) => b.sprints),
    sprintIssues: (provider: TicketProviderId, sprintId: string, onlyMine = false) =>
      request<{ issues: TicketIssueDto[] }>(`/api/tickets/${provider}/sprint/${encodeURIComponent(sprintId)}/issues${onlyMine ? '?mine=1' : ''}`).then((b) => b.issues),
    transitions: (provider: TicketProviderId, key: string) =>
      request<{ transitions: TicketTransitionDto[] }>(`/api/tickets/${provider}/issue/${encodeURIComponent(key)}/transitions`).then((b) => b.transitions),
    transition: (provider: TicketProviderId, key: string, transitionId: string) =>
      request<TicketIssueDto>(`/api/tickets/${provider}/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: JSON.stringify({ transitionId }) }),
    linearConnectStart: () => request<{ url: string; state: string }>('/api/tickets/linear/connect', { method: 'POST' }),
    linearConnectStatus: (state: string) => request<{ connected: boolean; workspaceName?: string }>(`/api/tickets/linear/connect/${state}`),
    linearConfig: () => request<{ connected: boolean; workspaceName: string | null }>('/api/tickets/linear/config'),
    linearTest: () => request<{ ok: boolean; workspaceName: string }>('/api/tickets/linear/config/test', { method: 'POST' }),
    linearDisconnect: () => request<{ ok: boolean }>('/api/tickets/linear/config', { method: 'DELETE' }),
  },
  gitlab: {
    config: () => request<{ hosts: string[] }>('/api/gitlab/config'),
    saveConfig: (input: { host: string; token: string }) =>
      request<{ ok: boolean; host: string; username: string }>('/api/gitlab/config', {
        method: 'POST', body: JSON.stringify(input),
      }),
    removeConfig: (host: string) =>
      request<{ ok: boolean }>(`/api/gitlab/config/${encodeURIComponent(host)}`, { method: 'DELETE' }),
    testConfig: () => request<{ ok: boolean; accounts: number }>('/api/gitlab/config/test', { method: 'POST' }),
  },
  github: {
    config: () => request<{ hosts: string[] }>('/api/github/config'),
    saveConfig: (input: { host: string; token: string; owner?: string }) =>
      request<{ ok: boolean; host: string; username: string }>('/api/github/config', {
        method: 'POST', body: JSON.stringify(input),
      }),
    removeConfig: (host: string) =>
      request<{ ok: boolean }>(`/api/github/config/${encodeURIComponent(host)}`, { method: 'DELETE' }),
    testConfig: () => request<{ ok: boolean; accounts: number }>('/api/github/config/test', { method: 'POST' }),
    appConnect: () =>
      request<{ state: string; url: string; expiresAt: string }>('/api/github/app/connect', { method: 'POST' }),
    appStatus: () =>
      request<{
        installations: Array<{
          installationId: number;
          accountLogin: string;
          accountType: 'Organization' | 'User';
          repositorySelection: 'all' | 'selected';
          suspended: boolean;
        }>;
      }>('/api/github/app/status'),
    appDisconnect: (installationId: number) =>
      request<{ ok: boolean }>(`/api/github/app/disconnect/${installationId}`, { method: 'POST' }),
  },
  repos: {
    list: (wsId: string) =>
      request<{ repos: RepoConfig[] }>(`${wsBase(wsId)}/repos`).then((b) => b.repos),
    detect: (wsId: string, path: string) =>
      request<DetectedRepo>(`${wsBase(wsId)}/repos/detect`, { method: 'POST', body: JSON.stringify({ path }) }),
    add: (wsId: string, repo: RepoConfig) =>
      request<RepoConfig>(`${wsBase(wsId)}/repos`, { method: 'POST', body: JSON.stringify(repo) }),
    // Clone onto the machine running THIS server (the point of the flow: a
    // runner provisions repos itself instead of you SSHing in to clone).
    clone: (wsId: string, url: string, parent?: string) =>
      request<{ repo: RepoConfig; warnings: string[]; alreadyRegistered: boolean; path: string }>(
        `${wsBase(wsId)}/repos/clone`,
        { method: 'POST', body: JSON.stringify(parent ? { url, parent } : { url }) },
        // A clone of a large repo legitimately runs for minutes.
        { timeoutMs: 0 },
      ),
    create: (wsId: string, name: string, parent?: string) =>
      request<{ repo: RepoConfig; path: string; alreadyRegistered: boolean }>(
        `${wsBase(wsId)}/repos/create`,
        { method: 'POST', body: JSON.stringify(parent ? { name, parent } : { name }) },
      ),
    patch: (wsId: string, id: string, patch: Partial<RepoConfig>) =>
      request<RepoConfig>(`${wsBase(wsId)}/repos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (wsId: string, id: string) =>
      request<void>(`${wsBase(wsId)}/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  reviews: {
    list: (wsId: string, state: MergeRequest['state'] = 'open', page = 1, search = '', repoId = '') => {
      const query = new URLSearchParams({ state, page: String(page) });
      if (search.trim()) query.set('search', search.trim());
      if (repoId && repoId !== 'all') query.set('repoId', repoId);
      return request<{
        reviews: CodeReview[];
        repositories: CodeReviewRepository[];
        counts: CodeReviewCounts;
        page: number;
        pageSize: number;
        hasMore: boolean;
        pageLimit: number | null;
      }>(`${wsBase(wsId)}/merge-requests?${query}`);
    },
  },
  usage: {
    summary: (wsId: string, days: 7 | 30 | 90) =>
      request<UsageSummary>(`${wsBase(wsId)}/usage/summary?days=${days}`),
    accounts: (wsId: string) =>
      request<{ accounts: UsageAccount[] }>(`${wsBase(wsId)}/usage/accounts`).then((b) => b.accounts),
    machine: (wsId: string) => request<MachineSample>(`${wsBase(wsId)}/usage/machine`),
  },
  worktrees: {
    list: (wsId: string) =>
      request<{ worktrees: Worktree[] }>(`${wsBase(wsId)}/worktrees`).then((b) => b.worktrees),
    create: (wsId: string, payload: {
      repoId: string;
      ticketId: string;
      title: string;
      sourceBranch: string;
      sourceWorktree: string;
      port?: number;
      env?: Record<string, string>;
      ticketProvider?: TicketProviderId;
    }) =>
      request<{ jobId: string }>(`${wsBase(wsId)}/worktrees`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    remove: (wsId: string, p: string, opts: { force?: boolean; deleteBranch?: boolean } = {}) => {
      const q = new URLSearchParams();
      if (opts.force) q.set('force', '1');
      if (opts.deleteBranch) q.set('deleteBranch', '1');
      const qs = q.toString();
      return request<{ jobId: string }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}${qs ? '?' + qs : ''}`,
        { method: 'DELETE' },
      );
    },
    patch: (wsId: string, p: string, patch: Partial<{ port: number; env: Record<string, string>; title: string; ticketId: string; workflowStatus: WorkflowStatus | null; note: string | null; order: number | null; startCommand: string | null; previewUrl: string | null }>) =>
      request(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    adopt: (wsId: string, p: string, payload: { repoId: string; ticketId: string; title: string; port?: number }) =>
      request(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/adopt`, { method: 'POST', body: JSON.stringify(payload) }),
    link: (wsId: string, p: string, sourceWorktree: string, replace = false) =>
      request<{ warnings: string[] }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/link`,
        { method: 'POST', body: JSON.stringify({ sourceWorktree, replace }) },
      ),
    unlink: (wsId: string, p: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/unlink`, { method: 'POST' }),
    relink: (wsId: string, p: string, sourceWorktree: string) =>
      request<{ warnings: string[] }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/relink`,
        { method: 'POST', body: JSON.stringify({ sourceWorktree }) },
      ),
    start: (wsId: string, p: string) =>
      request<ProcInfo>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/start`, { method: 'POST' }),
    stop: (wsId: string, p: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/stop`, { method: 'POST' }),
    setEnvProfile: (wsId: string, p: string, profile: string) =>
      request<{ activeEnvProfile: string; restarted: boolean; process: ProcInfo }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/env-profile`,
        { method: 'POST', body: JSON.stringify({ profile }) },
      ),
    killSession: (wsId: string, p: string, mode: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi', id?: string) =>
      request<void>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/sessions/${mode}${id && id !== '1' ? `?id=${encodeURIComponent(id)}` : ''}`,
        { method: 'DELETE' },
      ),
    sessionBusy: (wsId: string, p: string, mode: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi', id?: string) =>
      request<{ busy: boolean }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/sessions/${mode}/busy${id && id !== '1' ? `?id=${encodeURIComponent(id)}` : ''}`,
      ),
    killExternal: (wsId: string, p: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/kill-external`, { method: 'POST' }),
    status: (wsId: string, p: string) =>
      request<ProcInfo>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/status`),
    logs: (wsId: string, p: string, tail = 500) =>
      request<{ lines: string[] }>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/logs?tail=${tail}`),
    openEditor: (wsId: string, p: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/open-editor`, { method: 'POST' }),
    openTerminal: (wsId: string, p: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/open-terminal`, { method: 'POST' }),
    resumeClaude: (wsId: string, p: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/resume-claude`, { method: 'POST' }),
    refreshGit: (wsId: string, p: string) =>
      request<{ branch: string; dirty: boolean; ahead: number; behind: number }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/refresh-git`,
        { method: 'POST' },
      ),
    createHandoff: (
      wsId: string,
      p: string,
      payload: {
        source: { mode: AgentMode; sessionId: string };
        target: { mode: AgentMode; sessionId: string };
        notes: string;
      },
    ) =>
      request<{ handoff: Handoff; prompt: string }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/handoffs`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    handoffs: (wsId: string, p: string) =>
      request<{ handoffs: Handoff[] }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/handoffs`,
      ).then((body) => body.handoffs),
    cancelHandoff: (wsId: string, p: string, id: string) =>
      request<void>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/handoffs/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    upload: (wsId: string, p: string, file: { name: string; dataBase64: string }) =>
      request<{ path: string }>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/upload`, {
        method: 'POST', body: JSON.stringify(file),
      }),
    mergeRequests: async (wsId: string, p: string) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; mergeRequests?: MergeRequest[] } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/merge-requests`,
      );
      if (!r) return { kind: 'absent' as const };              // 204 → request() returns undefined
      const provider = r.provider ?? ('gitlab' as const);
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider };
      return { kind: 'list' as const, provider, mergeRequests: r.mergeRequests ?? [] };
    },
    // One request for many worktrees. The per-worktree call above still backs
    // single-pane views; this is what the board and sidebar poll with, so a
    // repo with two dozen worktrees costs one socket instead of two dozen.
    mergeRequestsBatch: (wsId: string, paths: string[]) =>
      request<{ results: Record<string, WorktreeMergeRequests> }>(
        `${wsBase(wsId)}/merge-requests/batch`,
        { method: 'POST', body: JSON.stringify({ paths }) },
      ),
    mergeRequestChanges: async (wsId: string, p: string, iid: number) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; files?: MergeRequestChange[]; truncated?: boolean; total?: number | null } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/merge-requests/${iid}/changes`,
      );
      if (!r) return { kind: 'absent' as const };
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider: r.provider ?? ('gitlab' as const) };
      return {
        kind: 'list' as const,
        files: r.files ?? [],
        truncated: r.truncated ?? false,
        total: r.total ?? null,
      };
    },
    mergeRequestDiscussion: async (wsId: string, p: string, iid: number) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; discussion?: ReviewDiscussion } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/merge-requests/${iid}/discussion`,
      );
      if (!r) return { kind: 'absent' as const };
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider: r.provider ?? ('gitlab' as const) };
      return {
        kind: 'discussion' as const,
        discussion: r.discussion ?? { description: null, comments: [], anchor: null },
      };
    },
    commitChanges: async (wsId: string, p: string, sha: string) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; files?: MergeRequestChange[] } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/commits/${encodeURIComponent(sha)}/changes`,
      );
      if (!r) return { kind: 'absent' as const };
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider: r.provider ?? ('gitlab' as const) };
      return { kind: 'list' as const, files: r.files ?? [] };
    },
    mergeRequestCommits: async (wsId: string, p: string, iid: number) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; commits?: ReviewCommit[] } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/merge-requests/${iid}/commits`,
      );
      if (!r) return { kind: 'absent' as const };
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider: r.provider ?? ('gitlab' as const) };
      return { kind: 'list' as const, commits: r.commits ?? [] };
    },
    postMergeRequestLineComment: async (
      wsId: string,
      p: string,
      iid: number,
      input: { body: string; path: string; oldPath?: string; line: number; side: 'new' | 'old' },
    ) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; posted?: boolean } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/merge-requests/${iid}/line-comment`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!r) return { kind: 'absent' as const };
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider: r.provider ?? ('gitlab' as const) };
      return { kind: 'posted' as const };
    },
    postMergeRequestReview: async (
      wsId: string,
      p: string,
      iid: number,
      input: { body: string; event: 'comment' | 'approve' | 'request-changes' },
    ) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; posted?: boolean } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/merge-requests/${iid}/review`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!r) return { kind: 'absent' as const };
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider: r.provider ?? ('gitlab' as const) };
      return { kind: 'posted' as const };
    },
    createMergeRequest: async (wsId: string, p: string, body: { target: string; title: string; description?: string }) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; mergeRequest?: MergeRequest } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/merge-requests`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (!r) return { kind: 'absent' as const };
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider: r.provider ?? ('gitlab' as const) };
      return { kind: 'created' as const, mergeRequest: r.mergeRequest! };
    },
    mergeMergeRequest: async (wsId: string, p: string, iid: number) => {
      const r = await request<{ needsAuth?: boolean; provider?: 'gitlab' | 'github'; mergeRequest?: MergeRequest } | undefined>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/merge-requests/${iid}/merge`,
        { method: 'POST' },
      );
      if (!r) return { kind: 'absent' as const };
      if (r.needsAuth) return { kind: 'needsAuth' as const, provider: r.provider ?? ('gitlab' as const) };
      return { kind: 'merged' as const, mergeRequest: r.mergeRequest! };
    },
    git: {
      changes: (wsId: string, p: string) =>
        request<{ files: { path: string; status: 'A' | 'M' | 'D' | 'R' | 'U'; staged: 'none' | 'partial' | 'full'; untracked: boolean; renamedFrom?: string }[] }>(
          `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/changes`,
        ),
      branches: (wsId: string, p: string) =>
        request<{ branches: string[]; current: string | null }>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/branches`),
      branchChanges: (wsId: string, p: string, base?: string) =>
        request<{ base: string; baseBranch: string; files: { path: string; status: 'A' | 'M' | 'D' | 'R'; additions: number; deletions: number; renamedFrom?: string }[] }>(
          `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/branch-changes${base ? `?base=${encodeURIComponent(base)}` : ''}`,
        ),
      diff: (wsId: string, p: string, file: string, scope: 'unstaged' | 'staged' | 'branch', base?: string) =>
        request<{ diff: string }>(
          `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/diff?file=${encodeURIComponent(file)}&scope=${scope}${base ? `&base=${encodeURIComponent(base)}` : ''}`,
        ),
      stage: (wsId: string, p: string, file: string) =>
        request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/stage`, { method: 'POST', body: JSON.stringify({ file }) }),
      unstage: (wsId: string, p: string, file: string) =>
        request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/unstage`, { method: 'POST', body: JSON.stringify({ file }) }),
      discard: (wsId: string, p: string, file: string) =>
        request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/discard`, { method: 'POST', body: JSON.stringify({ file }) }),
      stageAll: (wsId: string, p: string) =>
        request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/stage-all`, { method: 'POST' }),
      unstageAll: (wsId: string, p: string) =>
        request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/unstage-all`, { method: 'POST' }),
      discardAll: (wsId: string, p: string) =>
        request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/discard-all`, { method: 'POST' }),
      applyHunk: (wsId: string, p: string, patch: string, reverse = false) =>
        request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/stage-hunk`, { method: 'POST', body: JSON.stringify({ patch, reverse }) }),
      discardHunk: (wsId: string, p: string, patch: string) =>
        request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/discard-hunk`, { method: 'POST', body: JSON.stringify({ patch }) }),
      mrUrl: (wsId: string, p: string, target: string) =>
        request<{ url: string; sourceBranch: string }>(
          `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/mr-url?target=${encodeURIComponent(target)}`,
        ),
      remotes: (wsId: string, p: string) =>
        request<{ remotes: string[] }>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/remotes`),
      push: (wsId: string, p: string, remote: string) =>
        request<{ output: string }>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/push`, { method: 'POST', body: JSON.stringify({ remote }) }),
      pull: (wsId: string, p: string, source: string) =>
        request<{ output: string }>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/pull`, { method: 'POST', body: JSON.stringify({ source }) }),
      log: (wsId: string, p: string, limit = 100, q?: string) =>
        request<{
          head: string | null;
          commits: { hash: string; parents: string[]; author: string; date: string; refs: string[]; subject: string }[];
        }>(
          `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/log?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
        ),
      commitInfo: (wsId: string, p: string, hash: string) =>
        request<{
          hash: string;
          author: string;
          date: string;
          message: string;
          files: { path: string; status: 'A' | 'M' | 'D' | 'R'; renamedFrom?: string }[];
        }>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/commit-info?hash=${encodeURIComponent(hash)}`),
      commitDiff: (wsId: string, p: string, hash: string, file: string) =>
        request<{ diff: string }>(
          `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/commit-diff?hash=${encodeURIComponent(hash)}&file=${encodeURIComponent(file)}`,
        ),
      commit: (wsId: string, p: string, message: string) =>
        request<{ head: string; summary: string }>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/git/commit`, { method: 'POST', body: JSON.stringify({ message }) }),
    },
  },
  kb: {
    files: (wsId: string, p: string) =>
      request<{ files: KbFile[]; truncated: boolean; cap: number }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/kb/files`,
      ),
    file: (wsId: string, p: string, file: string) =>
      request<{ content: string; size: number; mtimeMs: number }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/kb/file?file=${encodeURIComponent(file)}`,
      ),
  },
  vscode: {
    // Ensures the shared VS Code web server is running; returns its base URL.
    // ready:false means serve-web is still downloading a VS Code update and
    // would serve a placeholder page — callers should keep loading and re-poll.
    open: (folder: string) =>
      request<{ url: string; ready?: boolean }>('/api/vscode', {
        method: 'POST',
        body: JSON.stringify({ folder }),
      }),
    // Tears down the given worktree's VS Code web server daemon. Best-effort
    // — server-side reap on startup/shutdown is the backstop.
    close: (folder: string) =>
      request<{ ok: boolean }>('/api/vscode', {
        method: 'DELETE',
        body: JSON.stringify({ folder }),
      }),
  },
  workspaces: {
    list: () =>
      request<{ activeWorkspaceId: string | null; workspaces: Workspace[] }>('/api/workspaces'),
    create: (ws: Workspace) =>
      request<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify(ws) }),
    patch: (id: string, patch: Partial<Omit<Workspace, 'id'>>) =>
      request<Workspace>(`/api/workspaces/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      request<void>(`/api/workspaces/${encodeURIComponent(id)}?confirm=1`, { method: 'DELETE' }),
    setActive: (id: string) =>
      request<{ activeWorkspaceId: string }>(`/api/workspaces/active`, {
        method: 'POST', body: JSON.stringify({ id }),
      }),
    // The whole id list, not a move: a stale client can't half-apply an order.
    reorder: (ids: string[]) =>
      request<{ workspaces: Workspace[] }>('/api/workspaces/order', {
        method: 'POST', body: JSON.stringify({ ids }),
      }).then((b) => b.workspaces),
  },
  profile: {
    get: () => request<Profile>('/api/profile'),
    save: (patch: Partial<Profile>) =>
      request<Profile>('/api/profile', { method: 'PUT', body: JSON.stringify(patch) }),
  },
  // The model API key runs on runners. The GET only ever discloses presence and
  // the last four — the server never returns the key itself.
  modelCredential: {
    get: () => request<ModelCredentialSummary>('/api/model-credential'),
    save: (key: string | null) =>
      request<ModelCredentialSummary>('/api/model-credential', { method: 'POST', body: JSON.stringify({ key }) }),
  },
  // Self-hosted runners. Every call goes through the LOCAL server, which holds
  // the account token — the renderer never sees it.
  runners: {
    list: () => request<{ runners: RunnerRow[] }>('/api/runners'),
    pairCode: () =>
      request<{ code: string; expiresAt: string; installCommand: string; pairCommand: string }>(
        '/api/runners/pair-code',
        { method: 'POST' },
      ),
    // Attach codes are single-use, so this mints a fresh one per open.
    attach: (runnerId: string) =>
      request<{ code: string; expiresAt: string; url: string }>(
        `/api/runners/${encodeURIComponent(runnerId)}/attach`,
        { method: 'POST' },
      ),
    revoke: (runnerId: string) =>
      request<{ ok: boolean }>(`/api/runners/${encodeURIComponent(runnerId)}/revoke`, { method: 'POST' }),
    /**
     * Port forwarding: a dev server on the runner reachable at 127.0.0.1 here,
     * so the preview browser and the browser MCP work on it unchanged.
     *
     * The local port is NOT the remote port — 3000 is often already taken here.
     * Anything pointing a browser at a remote worktree must use `localPort`.
     */
    forwards: {
      list: () => request<{ forwards: Forward[] }>('/api/runners/forwards'),
      open: (runnerId: string, remotePort: number) =>
        request<Forward>(`/api/runners/${encodeURIComponent(runnerId)}/forwards`, {
          method: 'POST',
          body: JSON.stringify({ remotePort }),
        }),
      close: (runnerId: string, remotePort: number) =>
        request<void>(`/api/runners/${encodeURIComponent(runnerId)}/forwards/${remotePort}`, {
          method: 'DELETE',
        }),
    },
    // Credential for a DIRECT socket to the relay. Reusable until it expires,
    // so one ticket covers a pane's whole reconnect life. Keep it in memory
    // only — it is shell access to that machine.
    socketTicket: (runnerId: string) =>
      request<{ ticket: string; expiresAt: string; wsBase: string; httpBase: string }>(
        `/api/runners/${encodeURIComponent(runnerId)}/socket-ticket`,
        { method: 'POST' },
      ),
    /** One GET against a runner's own API, proxied through the local server. */
    rpc: <T>(runnerId: string, path: string) =>
      request<T>(`/api/runners/${encodeURIComponent(runnerId)}/rpc?path=${encodeURIComponent(path)}`),
    /** Worktrees on every linked runner, already matched to LOCAL repo ids. */
    remoteWorktrees: (wsId: string) =>
      request<{ runners: RunnerStatus[]; worktrees: RemoteWorktree[] }>(`${wsBase(wsId)}/remote-worktrees`),
    /** Provision the repo on the runner if needed, then create the worktree there. */
    createRemote: (wsId: string, payload: {
      runnerId: string;
      repoId: string;
      ticketId: string;
      ticketProvider?: TicketProviderId;
      title: string;
      sourceBranch: string;
      port?: number;
      env?: Record<string, string>;
    }) =>
      request<{ jobId: string }>(
        `${wsBase(wsId)}/remote-worktrees`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    /** Remove a worktree on a runner. Returns a job id; steps stream like a local delete. */
    deleteRemote: (wsId: string, payload: {
      runnerId: string;
      remoteWsId: string;
      path: string;
      force?: boolean;
      deleteBranch?: boolean;
    }) =>
      request<{ jobId: string }>(
        `${wsBase(wsId)}/remote-worktrees/delete`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    /** Kill a session that lives on a runner. */
    killRemoteSession: (wsId: string, payload: {
      runnerId: string; remoteWsId: string; path: string;
      mode: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi'; id?: string;
    }) =>
      request<{ ok: true }>(
        `${wsBase(wsId)}/remote-worktrees/kill-session`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
  },

  // Device-code sign-in (`gh auth login` shape). The app never sees the
  // device_code — only the user_code to show, and the URL to open — and the
  // resulting token is written to ~/.strado/license.json by the LOCAL server.
  auth: {
    start: () =>
      request<{ userCode: string; verificationUrl: string; interval: number; expiresAt: string }>(
        '/api/auth/start',
        { method: 'POST' },
      ),
    // The status union is widened past the known literals (kept for
    // documentation/autocomplete) because this crosses a network boundary to
    // a server that can add a new terminal status later — an unrecognised
    // value must fall to an honest error in the UI, never an endless retry.
    poll: (userCode: string) =>
      request<
        | { status: 'authorization_pending' | 'slow_down' | 'expired' | (string & {}) }
        | { status: 'signed_in'; email: string; name: string }
      >('/api/auth/poll', { method: 'POST', body: JSON.stringify({ userCode }) }),
    signout: () => request<void>('/api/auth/signout', { method: 'POST' }),
  },

  // Sign-in gate. `get`/`save`/`clear`/`verify` all talk to the LOCAL server
  // (which persists ~/.strado/license.json); `verify` is what makes the
  // server call the strado-api cloud on the app's behalf and stamp the
  // result, rather than the renderer heartbeating the cloud directly.
  license: {
    // `status` mirrors the enforcement hook's own licenseState() check — 'stale'
    // means the grace window (Task 6) has run out without a confirmed
    // heartbeat, which the UI must show, not silently 401 its way through.
    get: () =>
      request<{
        required: boolean;
        apiUrl: string;
        telemetry?: boolean;
        license: StoredLicense | null;
        status: 'ok' | 'none' | 'stale';
      }>('/api/license'),
    clear: () => request<void>('/api/license', { method: 'DELETE' }),
    // The heartbeat, routed through the LOCAL server (Task 7's endpoint) so it
    // can stamp lastVerifiedAt and clear a revoked license itself.
    verify: () => request<{ ok: boolean; reason?: string }>('/api/license/verify', { method: 'POST' }),
    // No longer called: LicenseGate routes the heartbeat through `verify`
    // above so the local server learns the outcome. Left in place pending a
    // decision on whether anything else still wants a direct-to-cloud check.
    heartbeat: async (apiUrl: string, token: string) => {
      const res = await fetch(`${apiUrl}/v1/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(`heartbeat failed (${res.status})`);
      return (await res.json()) as { ok: boolean; revoked?: boolean };
    },
  },

  // Settings → Organization. Every call goes through the LOCAL server, which
  // injects the account token — same arrangement as `runners` above. Actions
  // that can change which org is active or who's in it (rename, remove,
  // accept, leave) return the fresh OrgView so callers can just `setView` the
  // result rather than re-fetching.
  org: {
    get: () => request<OrgView>('/api/org'),
    switch: (orgId: string) =>
      request<OrgView>('/api/org/switch', { method: 'POST', body: JSON.stringify({ orgId }) }),
    rename: (name: string) =>
      request<OrgView>('/api/org/rename', { method: 'POST', body: JSON.stringify({ name }) }),
    invite: (email: string) =>
      request<{ ok: boolean; emailed: boolean }>('/api/org/invitations', { method: 'POST', body: JSON.stringify({ email }) }),
    cancelInvite: (email: string) =>
      request<{ ok: boolean }>('/api/org/invitations/cancel', { method: 'POST', body: JSON.stringify({ email }) }),
    accept: (id: string) =>
      request<OrgView>(`/api/org/invitations/${encodeURIComponent(id)}/accept`, { method: 'POST' }),
    decline: (id: string) =>
      request<{ ok: boolean }>(`/api/org/invitations/${encodeURIComponent(id)}/decline`, { method: 'POST' }),
    removeMember: (email: string) =>
      request<OrgView>('/api/org/members/remove', { method: 'POST', body: JSON.stringify({ email }) }),
    leave: () => request<OrgView>('/api/org/leave', { method: 'POST' }),
  },
};

// Local copy of the strado-api wire shape (the cloud service's contracts) —
// imports must never flow FROM cloud into app code (it would ship in the DMG).
// `code` and `email` are each optional and not mutually exclusive in principle,
// but in practice exactly one is set: invite-code activation stores `code`,
// email sign-in stores `email`.
export type StoredLicense = { code?: string; email?: string; token: string; name: string; deviceId: string };

// Local copy of the cloud's org view shape (the cloud service's org store) —
// same "imports never flow from cloud into app code" rule as StoredLicense.
export type OrgSummary = { id: string; name: string; kind: string; role: string };
export type OrgMember = { email: string; name: string; role: string; joinedAt: string };
export type OutgoingInvite = { email: string; invitedAt: string; expiresAt: string };
export type IncomingInvite = { id: string; orgId: string; orgName: string; invitedBy: string; expiresAt: string };
// Beta tiering (mirror of the cloud service's plans). Free = local features
// only; Pro (granted manually) unlocks the cloud features + Jira/Linear.
export type PlanName = 'free' | 'pro';
export type Feature = 'runners' | 'remote_worktrees' | 'remote_ports' | 'sandboxes' | 'jira' | 'linear';
export type Entitlements = { plan: PlanName; features: Record<Feature, boolean> };

export type OrgView = {
  active: OrgSummary;
  /** Resolved plan + cloud-feature flags for the active org. */
  entitlements: Entitlements;
  orgs: OrgSummary[];
  members: OrgMember[];
  invitations: { outgoing: OutgoingInvite[]; incoming: IncomingInvite[] };
};

export type RunnerRow = {
  runnerId: string;
  name: string;
  /** Derived by the cloud from relay heartbeats — never asserted by the runner. */
  online: boolean;
  lastOnlineAt: string | null;
  createdAt: string;
  runnerVersion: string | null;
};

/** Reachability of one runner while listing remote worktrees. */
/**
 * A live port forward: 127.0.0.1:<localPort> here → <remotePort> on the runner.
 *
 * `localPort` and `remotePort` differ whenever the remote port is already taken
 * locally, which is most of the time for 3000/5173. Every browser, preview view
 * and MCP target must use `url`/`localPort`; using `remotePort` would open
 * whatever happens to be on that port on THIS machine.
 */
export type Forward = {
  runnerId: string;
  remotePort: number;
  localPort: number;
  url: string;
  startedAt: string;
};

export type RunnerStatus = {
  runnerId: string;
  name: string;
  online: boolean;
  /** Online but its API failed — worth showing, because "no worktrees" would be a lie. */
  error: string | null;
};

export type RemoteWorktree = {
  runnerId: string;
  runnerName: string;
  /** `wss://<runnerId>.<relay domain>` — from the server, never built here. */
  wsBase: string;
  remoteWsId: string;
  /** Path on the RUNNER. Opaque here: never resolve or validate it locally. */
  path: string;
  name: string;
  branch: string | null;
  head: string;
  remoteRepoId: string | null;
  /** A repo's main working tree — cannot be removed as a worktree. */
  isRepoRoot: boolean;
  cloneUrl: string | null;
  /** Local repo this belongs to, or null when the clone URLs can't be matched. */
  localRepoId: string | null;
  /** The repo's name on the runner — the folder label when localRepoId is null. */
  remoteRepoName?: string | null;
  // Session state, forwarded by the remote-worktrees proxy so the rail can show
  // what's alive on a runner without opening the worktree.
  hasClaudeSession?: boolean; claudeStatus?: 'idle' | 'working' | 'waiting';
  claudeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; claudeSessions?: string[];
  hasCodexSession?: boolean; codexStatus?: 'idle' | 'working' | 'waiting';
  codexStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; codexSessions?: string[];
  hasOpencodeSession?: boolean; opencodeStatus?: 'idle' | 'working' | 'waiting';
  opencodeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; opencodeSessions?: string[];
  hasPiSession?: boolean; piStatus?: 'idle' | 'working' | 'waiting';
  piStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; piSessions?: string[];
  hasShellSession?: boolean; shellSessions?: string[];
};
