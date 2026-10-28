import type { RepoConfig, Worktree, ProcInfo, Workspace, WorkflowStatus, MergeRequest, MergeRequestChange, ReviewDiscussion, ReviewCommit, CodeReview, CodeReviewCounts, CodeReviewRepository, MachineSample, UsageAccount, UsageSummary } from './types';
import type { RunCommand, SessionMetrics, AgentConnection, ConnectionAgent, HostInfo, SandboxList, SandboxAction, LogPage, LogQuery, FileTreePage, FileList, FileContent, FileMarks, FileWriteBody, FileWriteResult, NavAnswer, HoverAnswer, OutlineAnswer, SearchQuery, SearchAnswer, LspServerId, LspServerStatus, EditorId, EditorsAnswer, OpenInEditorBody, ChatEntry, JarvisMeta, JarvisAgent, JarvisSettings } from './types';

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
    // The Files write's 409 is a bare { error: 'conflict', path, version }.
    if (res.status === 409 && body?.error === 'conflict') throw new ApiClientError('CONFLICT', 'The file changed on disk', body);
    throw new ApiClientError(body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return body as T;
}

function jarvisBase(wsId: string, focusId: string): string {
  return `${wsBase(wsId)}/focuses/${encodeURIComponent(focusId)}/jarvis`;
}

function wsBase(wsId: string): string {
  return `/api/w/${encodeURIComponent(wsId)}`;
}

/** A worktree on a runner: its files are read through the runner's own API. */
export type RemoteFilesTarget = { runnerId: string; remoteWsId: string };

/** One Files-tab GET: on this machine, or on the runner through its rpc proxy. */
function filesGet<T>(wsId: string, worktreePath: string, route: string, query: Record<string, string | undefined>, remote?: RemoteFilesTarget, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
  const tail = `/worktrees/${encodeURIComponent(worktreePath)}/${route}${qs.toString() ? `?${qs}` : ''}`;
  const init = signal ? { signal } : undefined;
  const opts = timeoutMs ? { timeoutMs } : undefined;
  if (remote) {
    return request<T>(`/api/runners/${encodeURIComponent(remote.runnerId)}/rpc?path=${encodeURIComponent(`/api/w/${encodeURIComponent(remote.remoteWsId)}${tail}`)}`, init, opts);
  }
  return request<T>(`${wsBase(wsId)}${tail}`, init, opts);
}

/** A navigation request: where the cursor is, and a way to cancel it when a newer one supersedes it. */
export type NavAt = { path: string; line: number; col: number };
/** A language server may take up to a minute to start before its first answer. */
const LSP_TIMEOUT_MS = 75_000;
const at = (p: NavAt) => ({ path: p.path, line: String(p.line), col: String(p.col) });

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

/** How app control names a PTY tab: structured, never a server session key.
 * An agent running inside a Shell tab is that shell (mode 'shell'). */
export type UiTabRef = { worktreePath: string; mode: 'claude' | 'codex' | 'opencode' | 'pi' | 'shell'; sessionId: string };
/** `visible`: the PTY panes on screen (≤ 200, runner tabs excluded). */
export type UiClientState = { focused: boolean; worktreePath: string | null; visible: UiTabRef[]; layout?: unknown };
export type JarvisScripts = { packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'; scripts: string[]; /** The repo's run commands; absent from an older server. */ runCommands?: { id: string; name: string }[] };
export type JarvisRunResult = { settled: boolean; output: string; durationMs: number } | { error: string };
export type JarvisSpawnResult = {
  agent: { agentId: string; alias: string | null; mode: UiTabRef['mode']; worktreePath: string; sessionId: string; executionId?: string };
  command?: JarvisRunResult;
  prompt?: { status: 'queued' };
};
export type UiCommandAck = { applied: boolean; reason?: string; result?: Record<string, unknown> };
export type EscalationDto = {
  id: string;
  scopeId: string;
  from: { agentId: string; executionId: string };
  to: string;
  title: string;
  body: string;
  context: Array<{ kind: string; value: string; label?: string }>;
  taskId: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
  resolvedBy: string | null;
  /** The `request` delivered to a peer target; set on a peer ask (also after it is retargeted to the human). */
  askMessageId?: string | null;
  createdAt: number;
  resolvedAt: number | null;
  expiresAt: number | null;
};
/** One intercom station: an agent or shell tab (the Dock's lights). `calls`
 * are its open escalations addressed to the human; `needsYou` is a call or a
 * permission prompt (lifecycle 'needs_input'). */
export type StationDto = {
  agentId: string;
  alias: string | null;
  name: string;
  mode: string;
  worktreePath: string;
  worktreeName: string;
  sessionId: string;
  lifecycle: string;
  live: boolean;
  needsYou?: boolean;
  calls: { id: string; title: string; body: string; createdAt: number }[];
  lastActivityAt: number | null;
  /** Mission Control; absent from an older server. The live tool line ("Bash: npm test"). */
  activity?: { text: string; at: number } | null;
  /** Up to 300 characters of the last assistant message (Stop hook). */
  lastResult?: { text: string; at: number } | null;
  /** Permission prompts the box can answer too; the tab's own dialog stays, and the first answer wins. */
  approvals?: StationApprovalDto[];
};
/** An open call to the human whose asker has no station (its tab closed): answer or dismiss by id. */
export type OrphanCallDto = { id: string; from: string; name: string; title: string; body: string; createdAt: number };
export type StationApprovalDto = { id: string; kind: 'command' | 'file-change' | 'file-read' | 'web' | 'tool'; title: string; detail: string; createdAt: number };
/** One intercom message on the line (agent↔agent or with the human, "human"). */
export type FeedMessageDto = {
  id: string;
  from: { agentId: string; alias?: string | null; executionId?: string | null };
  to: string;
  kind: string;
  body: string;
  createdAt: number;
};
export type PeerDto = {
  agentId: string;
  alias: string | null;
  mode: 'claude' | 'codex' | 'opencode' | 'pi' | 'shell';
  worktreePath: string;
  sessionId: string;
  /** The live execution behind the tab; null when it isn't running. */
  executionId?: string | null;
  lifecycle: string;
  live: boolean;
  /** Waiting on the person before it can start: 'trust' = Claude's folder-trust question. */
  attention?: 'trust';
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

/** `jarvisLocalOnly`: the ⌘K box never sends text to a model (the server refuses /jarvis/plan). */
/** `jarvisWakes`: Focus Jarvis speaks up when an agent it started finishes (default on). */
export type Profile = { fullName: string; callMe: string; telemetryOptOut: boolean; jarvisLocalOnly?: boolean; jarvisWakes?: boolean };
export type ModelCredentialSummary = { present: boolean; last4: string | null };

export type KbFile = { path: string; size: number; mtimeMs: number };

// Local copy of the server's agentConfig wire shape (packages/server/src/services/agentConfig/types.ts) —
// this package must never import from packages/server.
export type SurfaceKind =
  | 'mcp-list' | 'skill-list' | 'plugin-list' | 'hook-list'
  | 'permissions' | 'kv' | 'enum' | 'toggle' | 'markdown' | 'raw';

export type SurfaceValue = {
  id: string;
  label: string;
  group: string;
  kind: SurfaceKind;
  readOnly: boolean;
  options?: string[];
  value: unknown;
  inheritedValue?: unknown;
  // Set when THIS scope's own file failed to parse.
  error?: string;
  // Set when the *global* file failed while computing inheritance (project
  // scope only) — distinct from `error`. A project surface can be
  // legitimately unset with no error of its own while the user's global
  // config is corrupt; the UI must be able to say so separately.
  inheritedError?: string;
  source: 'set' | 'inherited' | 'unset';
  file: string;
  exists: boolean;
};

// `installed` (the agent's CLI exists) and `supported` (Strado has a
// descriptor for it, so the panel can actually manage its config) are
// independent — see routes/agentConfig.ts on the server, whose shape this
// mirrors. An agent can be installed but unsupported (Codex, today).
export type AgentSummary = { id: string; label: string; installed: boolean; supported: boolean; files: string[] };
export type AgentScope = 'global' | 'project';
export type AgentReadOpts = { scope: AgentScope; worktree?: string; host?: string };

// Built manually (not via URLSearchParams) so a worktree path with a space
// encodes to %20 — the same as the encodeURIComponent path segments and
// query params used elsewhere in this file — rather than URLSearchParams'
// '+', which would round-trip differently from its sibling functions below.
function agentQuery(opts: AgentReadOpts): string {
  const parts = [`scope=${encodeURIComponent(opts.scope)}`];
  if (opts.worktree) parts.push(`worktree=${encodeURIComponent(opts.worktree)}`);
  if (opts.host && opts.host !== 'local') parts.push(`host=${encodeURIComponent(opts.host)}`);
  return parts.join('&');
}

export type AgentMode = 'claude' | 'codex' | 'opencode' | 'pi';

/** A named, cross-repo set of worktrees for one task. Members are sidebar pin ids. The sidebar shows the active one. */
export type FocusTicket = { provider: TicketProviderId; key: string };
export type Focus = { id: string; name: string; members: string[]; createdAt: string; lastActiveAt: string; ticket?: FocusTicket };
export type FocusPatch = { name?: string; addMembers?: string[]; removeMembers?: string[]; touch?: boolean; ticket?: FocusTicket | null };

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
  // Server→window layout commands (agents driving the app). The window reports
  // what it shows; the server picks one window per command and waits for its ack.
  ui: {
    reportState: (wsId: string, clientId: string, state: UiClientState) =>
      request<void>(`${wsBase(wsId)}/ui/clients/${encodeURIComponent(clientId)}/state`, { method: 'POST', body: JSON.stringify(state) }),
    ack: (wsId: string, clientId: string, commandId: string, ack: UiCommandAck) =>
      request<void>(`${wsBase(wsId)}/ui/commands/${encodeURIComponent(commandId)}/ack`, { method: 'POST', headers: { 'x-strado-ui-client': clientId }, body: JSON.stringify(ack) }),
  },
  intercom: {
    peers: (wsId: string) => request<{ peers: PeerDto[] }>(`${wsBase(wsId)}/intercom/peers`).then((b) => b.peers),
    /** orphanCalls: absent from an older server. */
    stations: (wsId: string) => request<{ stations: StationDto[]; orphanCalls?: OrphanCallDto[] }>(`${wsBase(wsId)}/intercom/stations`),
    /** Answer a permission prompt from the box. No longer waiting (answered in the tab, or expired): 409, rejects with details.reason 'gone'. */
    answerApproval: (wsId: string, id: string, decision: 'allow' | 'deny') =>
      request<{ ok: true }>(`${wsBase(wsId)}/intercom/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision }) }),
    /** Esc to the agent's tab: it stops its turn. */
    interrupt: (wsId: string, agentId: string) =>
      request<{ ok: true }>(`${wsBase(wsId)}/intercom/agents/${encodeURIComponent(agentId)}/interrupt`, { method: 'POST', body: '{}' }),
    /** The line's messages, newest first; `agent` = one station's (sent or received). */
    feed: (wsId: string, opts: { agent?: string | null; limit?: number } = {}) => {
      const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
      if (opts.agent) q.set('agent', opts.agent);
      return request<{ messages: FeedMessageDto[] }>(`${wsBase(wsId)}/intercom/messages?${q}`).then((b) => b.messages);
    },
    escalations: {
      resolve: (wsId: string, id: string, resolution: string) =>
        request<{ escalation: EscalationDto }>(`${wsBase(wsId)}/intercom/escalations/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ resolution }) }).then((b) => b.escalation),
      dismiss: (wsId: string, id: string) =>
        request<{ escalation: EscalationDto }>(`${wsBase(wsId)}/intercom/escalations/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: '{}' }).then((b) => b.escalation),
    },
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
  focuses: {
    list: (wsId: string) =>
      request<{ focuses: Focus[] }>(`${wsBase(wsId)}/focuses`).then((b) => b.focuses),
    create: (wsId: string, body: { name: string; members?: string[]; ticket?: FocusTicket }) =>
      request<{ focus: Focus }>(`${wsBase(wsId)}/focuses`, { method: 'POST', body: JSON.stringify(body) }).then((b) => b.focus),
    update: (wsId: string, id: string, body: FocusPatch) =>
      request<{ focus: Focus }>(`${wsBase(wsId)}/focuses/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }).then((b) => b.focus),
    remove: (wsId: string, id: string) =>
      request<void>(`${wsBase(wsId)}/focuses/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined),
  },
  // Focus Jarvis: the Focus's chat. Replies stream over `streamUrl` (SSE
  // `entry` and `meta`); posts return as soon as the server has the turn.
  focusJarvis: {
    log: (wsId: string, focusId: string, page: { before?: string; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (page.before) q.set('before', page.before);
      if (page.limit) q.set('limit', String(page.limit));
      const qs = q.toString();
      return request<{ entries: ChatEntry[]; meta: JarvisMeta }>(`${jarvisBase(wsId, focusId)}${qs ? `?${qs}` : ''}`);
    },
    send: (wsId: string, focusId: string, body: { text: string; windowId: string; context: unknown }) =>
      request<{ entry: ChatEntry }>(`${jarvisBase(wsId, focusId)}/messages`, { method: 'POST', body: JSON.stringify(body) }).then((b) => b.entry),
    stop: (wsId: string, focusId: string) =>
      request<void>(`${jarvisBase(wsId, focusId)}/stop`, { method: 'POST' }).then(() => undefined),
    approve: (wsId: string, focusId: string, entryId: string, body: { approve: boolean; windowId: string; context: unknown }) =>
      request<unknown>(`${jarvisBase(wsId, focusId)}/approvals/${encodeURIComponent(entryId)}`, { method: 'POST', body: JSON.stringify(body) }).then(() => undefined),
    setAgent: (wsId: string, focusId: string, agent: JarvisAgent) =>
      request<JarvisMeta>(`${jarvisBase(wsId, focusId)}/agent`, { method: 'PUT', body: JSON.stringify({ agent }) }),
    setSettings: (wsId: string, focusId: string, settings: JarvisSettings) =>
      request<JarvisMeta>(`${jarvisBase(wsId, focusId)}/settings`, { method: 'PUT', body: JSON.stringify(settings) }),
    streamUrl: (wsId: string, focusId: string) => `${jarvisBase(wsId, focusId)}/events`,
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
    /** Replaces the repo's run commands (order = tab order, first = default); a missing id is minted from the name. */
    setRunCommands: (wsId: string, id: string, runCommands: { id?: string; name: string; command: string; envFile?: string | null }[]) =>
      request<{ runCommands: RunCommand[] }>(`${wsBase(wsId)}/repos/${encodeURIComponent(id)}/run-commands`, { method: 'PUT', body: JSON.stringify({ runCommands }) })
        .then((b) => b.runCommands),
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
      sourceBranch?: string;
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
    /** A run command (`runId`); without one, the repo's default (its first). `force`: start even though its
     * run tab's shell is busy (the server refused with 409 reason 'run_tab_busy' and the user said yes). */
    start: (wsId: string, p: string, runId?: string, opts?: { force?: boolean }) => {
      const body = { ...(runId ? { runId } : {}), ...(opts?.force ? { force: true } : {}) };
      return request<ProcInfo>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/start`, { method: 'POST', ...(Object.keys(body).length > 0 ? { body: JSON.stringify(body) } : {}) });
    },
    /** Closes a run tab: ends its idle post-run shell. While the run is live: 409 reason 'running' (just detach). */
    closeRunTab: (wsId: string, p: string, runId?: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/run-tab${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`, { method: 'DELETE' }),
    stop: (wsId: string, p: string, runId?: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/stop`, { method: 'POST', ...(runId ? { body: JSON.stringify({ runId }) } : {}) }),
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
    openTerminal: (wsId: string, p: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/open-terminal`, { method: 'POST' }),
    resumeClaude: (wsId: string, p: string) =>
      request<void>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/resume-claude`, { method: 'POST' }),
    refreshGit: (wsId: string, p: string) =>
      request<{ branch: string; dirty: boolean; ahead: number; behind: number }>(
        `${wsBase(wsId)}/worktrees/${encodeURIComponent(p)}/refresh-git`,
        { method: 'POST' },
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
  /** The Files tab: a worktree's folders and files. Pass `remote` for a
   * runner's worktree (wsId is then unused; it is read-only). */
  files: {
    tree: (wsId: string, worktreePath: string, dir: string, opts: { ignored?: boolean } = {}, remote?: RemoteFilesTarget) =>
      filesGet<FileTreePage>(wsId, worktreePath, 'files/tree', { dir, ignored: opts.ignored ? '1' : undefined }, remote),
    list: (wsId: string, worktreePath: string, remote?: RemoteFilesTarget) =>
      filesGet<FileList>(wsId, worktreePath, 'files/list', {}, remote),
    read: (wsId: string, worktreePath: string, path: string, remote?: RemoteFilesTarget) =>
      filesGet<FileContent>(wsId, worktreePath, 'files/read', { path }, remote),
    marks: (wsId: string, worktreePath: string, path: string, remote?: RemoteFilesTarget) =>
      filesGet<FileMarks>(wsId, worktreePath, 'files/marks', { path }, remote),
    /** Replace an existing text file (this machine only). A file that changed
     * since `baseVersion` throws ApiClientError 'CONFLICT' with details { version }. */
    write: (wsId: string, worktreePath: string, body: FileWriteBody) =>
      request<FileWriteResult>(`${wsBase(wsId)}/worktrees/${encodeURIComponent(worktreePath)}/files/write`, { method: 'POST', body: JSON.stringify(body) }),
    /** ⌘⇧F, and the guess behind a navigation with no language server. */
    search: (wsId: string, worktreePath: string, q: SearchQuery, remote?: RemoteFilesTarget, signal?: AbortSignal) =>
      filesGet<SearchAnswer>(wsId, worktreePath, 'files/search', {
        q: q.q, word: q.word ? '1' : undefined, case: q.case ? '1' : undefined, regex: q.regex ? '1' : undefined, glob: q.glob || undefined,
      }, remote, signal),
  },
  /** Code navigation through a language server (search when there is none). Pass
   * a signal so a newer request cancels the one it supersedes. */
  lsp: {
    definition: (wsId: string, worktreePath: string, p: NavAt, remote?: RemoteFilesTarget, signal?: AbortSignal) =>
      filesGet<NavAnswer>(wsId, worktreePath, 'lsp/definition', at(p), remote, signal, LSP_TIMEOUT_MS),
    references: (wsId: string, worktreePath: string, p: NavAt, remote?: RemoteFilesTarget, signal?: AbortSignal) =>
      filesGet<NavAnswer>(wsId, worktreePath, 'lsp/references', at(p), remote, signal, LSP_TIMEOUT_MS),
    hover: (wsId: string, worktreePath: string, p: NavAt, remote?: RemoteFilesTarget, signal?: AbortSignal) =>
      filesGet<HoverAnswer>(wsId, worktreePath, 'lsp/hover', at(p), remote, signal, LSP_TIMEOUT_MS),
    outline: (wsId: string, worktreePath: string, path: string, remote?: RemoteFilesTarget, signal?: AbortSignal) =>
      filesGet<OutlineAnswer>(wsId, worktreePath, 'lsp/outline', { path }, remote, signal, LSP_TIMEOUT_MS),
  },
  /** This machine's language servers (Settings › Files › Language servers). */
  lspServers: {
    list: (signal?: AbortSignal) =>
      request<{ servers: LspServerStatus[] }>('/api/lsp/servers', signal ? { signal } : undefined).then((b) => b.servers),
    setEnabled: (id: LspServerId, enabled: boolean) =>
      request<void>(`/api/lsp/servers/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    /** With `worktreePath`, only that worktree's instance; without, every one. */
    stop: (id: LspServerId, worktreePath?: string) =>
      request<void>(`/api/lsp/servers/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify(worktreePath ? { worktreePath } : {}) }),
  },
  /** "Open in editor": this machine's desktop editors, and handing a worktree or file to one. */
  editors: {
    list: () => request<EditorsAnswer>('/api/editors'),
    setPreferred: (editor: EditorId | null) =>
      request<void>('/api/editors/preferred', { method: 'POST', body: JSON.stringify({ editor }) }),
    open: (wsId: string, body: OpenInEditorBody) =>
      request<void>(`${wsBase(wsId)}/open-in-editor`, { method: 'POST', body: JSON.stringify(body) }),
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
  // Machine-wide pty sessions (not workspace-scoped: the daemon outlives
  // worktrees, and orphans are the point of the page).
  sessions: {
    metrics: (pids: number[] = []) =>
      request<SessionMetrics>(`/api/sessions/metrics${pids.length ? `?pids=${pids.join(',')}` : ''}`),
    kill: (key: string) =>
      request<void>(`/api/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' }),
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
  // Settings → Coding agents. Unlike `runners` below — every one of whose
  // calls takes an explicit `runnerId` path segment and has no notion of
  // "this machine" at all — `host` here is optional: 'local' and undefined
  // both mean THIS machine and must never be sent as a query param; only a
  // real runner id is.
  agentConfig: {
    agents: (host?: string) =>
      request<{ agents: AgentSummary[] }>(
        `/api/agent-config/agents${host && host !== 'local' ? `?host=${encodeURIComponent(host)}` : ''}`,
      ),
    read: (agent: string, opts: AgentReadOpts) =>
      request<{ agent: string; scope: AgentScope; surfaces: SurfaceValue[] }>(
        `/api/agent-config/${encodeURIComponent(agent)}?${agentQuery(opts)}`,
      ),
    patch: (agent: string, body: { surfaceId: string; scope: AgentScope; worktree?: string; value: unknown }, host?: string) =>
      request<{ agent: string; scope: AgentScope; surfaces: SurfaceValue[] }>(
        `/api/agent-config/${encodeURIComponent(agent)}${host && host !== 'local' ? `?host=${encodeURIComponent(host)}` : ''}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
    raw: (agent: string, file: string, opts: { worktree?: string; host?: string } = {}) =>
      request<{ file: string; text: string }>(
        `/api/agent-config/${encodeURIComponent(agent)}/raw?file=${encodeURIComponent(file)}` +
          (opts.worktree ? `&worktree=${encodeURIComponent(opts.worktree)}` : '') +
          (opts.host && opts.host !== 'local' ? `&host=${encodeURIComponent(opts.host)}` : ''),
      ),
    saveRaw: (agent: string, file: string, text: string, opts: { worktree?: string; host?: string } = {}) =>
      request<{ file: string; saved: boolean }>(
        `/api/agent-config/${encodeURIComponent(agent)}/raw` +
          (opts.host && opts.host !== 'local' ? `?host=${encodeURIComponent(opts.host)}` : ''),
        { method: 'PUT', body: JSON.stringify({ file, text }) },
      ),
    // Removes one skill directory at the given scope (moved into
    // `.backups` server-side, never destroyed — see dirDriver.remove).
    // Directory surfaces have no JSON key to PATCH, so this is a dedicated
    // route rather than `patch` with `surfaceId: 'skills'`.
    removeSkill: (agent: string, name: string, opts: AgentReadOpts) =>
      request<{ agent: string; scope: AgentScope; surfaces: SurfaceValue[] }>(
        `/api/agent-config/${encodeURIComponent(agent)}/skills/${encodeURIComponent(name)}?${agentQuery(opts)}`,
        { method: 'DELETE' },
      ),
  },
  // The model API key runs on runners. The GET only ever discloses presence and
  // the last four — the server never returns the key itself.
  modelCredential: {
    get: () => request<ModelCredentialSummary>('/api/model-credential'),
    save: (key: string | null) =>
      request<ModelCredentialSummary>('/api/model-credential', { method: 'POST', body: JSON.stringify({ key }) }),
  },
  // The optional OpenRouter key for Jev, the fast path for navigation commands.
  // Same contract: the GET discloses presence and the last four only.
  routerCredential: {
    get: () => request<ModelCredentialSummary>('/api/router-credential'),
    save: (key: string | null) =>
      request<ModelCredentialSummary>('/api/router-credential', { method: 'POST', body: JSON.stringify({ key }) }),
  },
  // The optional ElevenLabs key for voice (Scribe v2 Realtime). Same contract:
  // presence and the last four only.
  voiceCredential: {
    get: () => request<ModelCredentialSummary>('/api/voice-credential'),
    save: (key: string | null) =>
      request<ModelCredentialSummary>('/api/voice-credential', { method: 'POST', body: JSON.stringify({ key }) }),
  },
  // The Claude token (`claude setup-token`) that remote sandboxes use instead of
  // logging in. Same contract as the keys above: presence and the last four only.
  agentLogins: {
    claudeToken: {
      get: () => request<ModelCredentialSummary>('/api/agent-logins/claude-token'),
      save: (key: string | null) =>
        request<ModelCredentialSummary>('/api/agent-logins/claude-token', { method: 'POST', body: JSON.stringify({ key }) }),
    },
    /** This laptop's signing-key fingerprint, to compare with the runner's "trusted laptop" log line. */
    senderFingerprint: () => request<{ fingerprint: string }>('/api/agent-logins/sender-fingerprint'),
  },
  voice: {
    /** A short-lived ElevenLabs token for one realtime session (the key stays on the server).
     * Fails with code no_key (404), local_only (403), bad_key (401) or upstream (502). */
    elevenlabsToken: () => request<{ token: string }>('/api/voice/elevenlabs-token', { method: 'POST' }),
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
    /** Add a host over SSH: the server job does every step; the dialog only
     * sends the destination, an optional name, and yes/no answers. */
    sshSetup: {
      start: (body: { destination: string; name?: string }) =>
        request<{ jobId: string }>('/api/runners/ssh-setup', { method: 'POST', body: JSON.stringify(body) }),
      answer: (jobId: string, body: { questionId: string; yes: boolean }) =>
        request<void>(`/api/runners/ssh-setup/${encodeURIComponent(jobId)}/answer`, { method: 'POST', body: JSON.stringify(body) }),
      cancel: (jobId: string) =>
        request<void>(`/api/runners/ssh-setup/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
      /** The run's transcript so far (last 2000 lines), for a late attach. */
      transcript: (jobId: string) =>
        request<{ lines: string[] }>(`/api/runners/ssh-setup/${encodeURIComponent(jobId)}/transcript`),
    },
    /** A host's Connections tab. Each agent's state comes from a real check
     * on the runner; connect is a job (progress: phase / device code / pin question). */
    connections: {
      list: (runnerId: string) =>
        // stale: the runner is offline or unknown, so these are the last checks.
        request<{ connections: AgentConnection[]; stale: boolean }>(`/api/runners/${encodeURIComponent(runnerId)}/connections`),
      connect: (runnerId: string, agent: ConnectionAgent) =>
        request<{ jobId: string }>(`/api/runners/${encodeURIComponent(runnerId)}/connections/${agent}/connect`, { method: 'POST' }),
      check: (runnerId: string, agent: ConnectionAgent) =>
        request<{ connection: AgentConnection }>(`/api/runners/${encodeURIComponent(runnerId)}/connections/${agent}/check`, { method: 'POST' }),
      disconnect: (runnerId: string, agent: ConnectionAgent) =>
        request<{ connection: AgentConnection }>(`/api/runners/${encodeURIComponent(runnerId)}/connections/${agent}/disconnect`, { method: 'POST' }),
      answer: (jobId: string, body: { questionId: string; yes: boolean }) =>
        request<void>(`/api/connections/jobs/${encodeURIComponent(jobId)}/answer`, { method: 'POST', body: JSON.stringify(body) }),
      cancel: (jobId: string) =>
        request<void>(`/api/connections/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
    },
    /** A host's Sandboxes tab: its containers, and one action on one. Rebuild
     * is a job ({ jobId }); the rest answer { ok: true }. */
    sandboxes: {
      list: (runnerId: string) => request<SandboxList>(`/api/runners/${encodeURIComponent(runnerId)}/sandboxes`),
      action: (runnerId: string, slug: string, action: SandboxAction) =>
        request<{ ok: true } | { jobId: string }>(
          `/api/runners/${encodeURIComponent(runnerId)}/sandboxes/${encodeURIComponent(slug)}/${action}`,
          { method: 'POST' },
        ),
    },
    /** A host's Logs tab: the runner's own log, redacted on the runner. */
    logs: (runnerId: string, q: LogQuery = {}) => {
      const qs = new URLSearchParams();
      if (q.lines != null) qs.set('lines', String(q.lines));
      if (q.grep) qs.set('grep', q.grep);
      if (q.since != null) qs.set('since', String(q.since));
      const tail = qs.toString();
      return request<LogPage>(`/api/runners/${encodeURIComponent(runnerId)}/logs${tail ? `?${tail}` : ''}`);
    },
    /** The host page's Overview: where it was set up over ssh, and both keys. */
    host: (runnerId: string) => request<HostInfo>(`/api/runners/${encodeURIComponent(runnerId)}/host`),
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
    /** Rebuild the sandbox of a runner worktree whose build failed. Returns a job id. */
    rebuildSandbox: (wsId: string, payload: { runnerId: string; remoteWsId: string; path: string; repoId?: string }) =>
      request<{ jobId: string }>(
        `${wsBase(wsId)}/remote-worktrees/rebuild-sandbox`,
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
  /**
   * 'on': runs in its container. 'fallback': the runner sandboxes but this
   * worktree has no container (a failed build) — agents run on the host, and
   * the row must say so. 'off': the runner does not sandbox at all.
   */
  sandbox?: 'on' | 'fallback' | 'off';
  // Session state, forwarded by the remote-worktrees proxy so the rail can show
  // what's alive on a runner without opening the worktree.
  hasClaudeSession?: boolean; claudeStatus?: 'idle' | 'working' | 'waiting';
  claudeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; claudeSessions?: string[]; parkedClaudeSessions?: string[];
  hasCodexSession?: boolean; codexStatus?: 'idle' | 'working' | 'waiting';
  codexStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; codexSessions?: string[];
  hasOpencodeSession?: boolean; opencodeStatus?: 'idle' | 'working' | 'waiting';
  opencodeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; opencodeSessions?: string[];
  hasPiSession?: boolean; piStatus?: 'idle' | 'working' | 'waiting';
  piStatusById?: Record<string, 'idle' | 'working' | 'waiting'>; piSessions?: string[];
  hasShellSession?: boolean; shellSessions?: string[];
};
