export type Editor = 'code' | 'cursor' | 'subl' | 'webstorm';


/** A named way to run a worktree of a repo (the header's Run menu): several can run at once, each in its own tab.
 * A repo's list order is its tab order; the first is the default (the header's main Run). */
export type RunCommand = { id: string; name: string; command: string; envFile?: string | null };

export type RepoConfig = {
  id: string;
  name: string;
  path: string;
  /** origin's URL — lets this repo be cloned onto another machine (a runner). */
  cloneUrl?: string | null;
  projectSubdir: string | null;
  startCommand: string;
  defaultPort: number;
  fixedPort?: boolean;
  editor: Editor;
  openUrl?: string | null;
  /** Named run commands (startCommand mirrors the first). The first is the default. */
  runCommands?: RunCommand[];
  // Serves every worktree behind one origin: `host` for the main checkout,
  // `<worktree>.<host>` for the rest, all on `port`.
  devProxy?: { host: string; port: number; certFile?: string | null; keyFile?: string | null; upstreamTls?: boolean; allowLan?: boolean } | null;
};

export type WorktreeMeta = {
  repoId: string;
  ticketId: string;
  ticketProvider?: 'jira' | 'linear' | null;
  title: string;
  linkedFrom: string | null;
  linkedAt: string | null;
  port: number | null;
  env: Record<string, string>;
  lastStartedAt: string | null;
  workflowStatus?: WorkflowStatus | null;
  note?: string | null;
  order?: number | null;
  // per-worktree overrides; null/absent falls back to the repo config
  startCommand?: string | null;
  previewUrl?: string | null;
};

export type ProcInfo = {
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
  pid: number | null;
  startedAt: string | null;
  port: number | null;
  detectedUrl: string | null;
  exitCode: number | null;
  external?: boolean;
  // The dev-proxy URL for this worktree; preferred over detectedUrl, which
  // names the private port behind the proxy.
  proxyUrl?: string | null;
  // 'run': a run terminal exists for this worktree (the header Run's tab, /ws/run), even after it exited.
  tab?: 'run' | null;
  /** Which run command this is (and its name); absent from older servers = the default. */
  runId?: string;
  name?: string;
};

export type NodeModulesStatus =
  | { status: 'symlink'; source: string }
  | { status: 'directory' }
  | { status: 'missing' };

export type Worktree = {
  path: string;
  /**
   * Set when this worktree lives on a runner rather than this machine.
   *
   * Everything downstream must read it before calling a local API: the LOCAL
   * server has never heard of this path, so session lists, git status and
   * process control all have to come from (or be hidden for) the runner.
   */
  remote?: {
    runnerId: string;
    runnerName: string;
    /** wss://<runnerId>.<relay domain> — supplied by the server. */
    wsBase: string;
    /** The RUNNER's workspace id. */
    wsId: string;
  } | null;
  repoId: string | null;
  branch: string | null;
  head: string;
  prunable: boolean;
  tracked: boolean;
  meta: WorktreeMeta | null;
  process: ProcInfo;
  /** Every run started this server session (the default included), one per run command. */
  runs?: ProcInfo[];
  nodeModules?: NodeModulesStatus;
  claudeStatus?: 'idle' | 'working' | 'waiting';
  /** per-session status, keyed by session id (multi-session worktrees) */
  claudeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  codexStatus?: 'idle' | 'working' | 'waiting';
  codexStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  opencodeStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  piStatusById?: Record<string, 'idle' | 'working' | 'waiting'>;
  hasClaudeSession?: boolean;
  hasCodexSession?: boolean;
  hasShellSession?: boolean;
  shellSessions?: string[];
  claudeSessions?: string[];
  /** Claude tab ids parked by the server (listed in claudeSessions too). */
  parkedClaudeSessions?: string[];
  codexSessions?: string[];
  opencodeSessions?: string[];
  opencodeStatus?: 'idle' | 'working' | 'waiting';
  hasOpencodeSession?: boolean;
  piSessions?: string[];
  piStatus?: 'idle' | 'working' | 'waiting';
  hasPiSession?: boolean;
  diffStats?: { additions: number; deletions: number; files: number } | null;
  activitySeconds?: number;
};

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};

export type Workspace = {
  id: string;
  name: string;
  color: string;
  icon: string;
  defaultEditor: Editor;
  defaultPortBase: number;
  logDir: string | null;
  /**
   * Where new worktrees go. Null = beside each repo (`<repo>.worktrees`); a path
   * = everything under one root, `<root>/<repoId>`.
   *
   * Only affects worktrees created after it changes — git records a worktree by
   * absolute path, so existing ones stay where they are.
   */
};

export type WorkflowStatus =
  | 'todo'
  | 'in_progress'
  | 'ready_for_qa'
  | 'retest_failed'
  | 'verified'
  | 'done';

export type MergeRequest = {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  webUrl: string;
  pipeline: 'success' | 'failed' | 'running' | 'pending' | 'canceled' | null;
  approvals: { given: number; required: number } | null;
  sourceBranch: string;
  targetBranch?: string | null;
  updatedAt: string;
  author?: string | null;
  createdAt?: string | null;
  mergedAt?: string | null;
  provider?: 'gitlab' | 'github';
};

/** A provider review enriched with the workspace repository it belongs to. */
export type CodeReview = MergeRequest & {
  repoId: string;
  repoName: string;
};

export type CodeReviewCounts = { open: number; merged: number; closed: number };

export type CodeReviewRepository = {
  repoId: string;
  repoName: string;
  provider?: 'gitlab' | 'github';
  status: 'ok' | 'needsAuth' | 'unsupported' | 'error';
  error?: string;
  counts?: CodeReviewCounts;
};

/** A review conversation: the description plus every human comment on it. */
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

export type ReviewDiscussion = {
  description: string | null;
  comments: ReviewComment[];
  /** Present when the review still has a diff to pin new comments to. */
  anchor: { headSha: string; baseSha: string | null; startSha: string | null } | null;
};

/** One commit on a review, subject only. */
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

export type ReviewChanges = {
  files: MergeRequestChange[];
  truncated: boolean;
  total: number | null;
};

/** Which agent a usage figure came from. */
export type UsageAgent = 'claude' | 'codex';

export type UsageAgentTotals = { cost: number; tokens: number };

export type UsageDayPoint = { date: string; claude: UsageAgentTotals; codex: UsageAgentTotals };

export type UsageModelRow = {
  id: string;
  agent: UsageAgent;
  cost: number;
  tokens: number;
  /** Percent of total cost, or of total tokens when nothing has a price. */
  share: number;
  /** False when the price table has no row for the model: cost reads 0. */
  priced: boolean;
};

/** Cost rolled up per worktree; `path` is null on the Unattributed row. */
export type UsageWorktreeRow = { label: string; path: string | null; cost: number; tokens: number };

export type UsageTotals = {
  cost: number;
  tokens: number;
  cachedInput: number;
  uncachedInput: number;
  cacheWrite: number;
  output: number;
  cacheSavings: number;
  cacheSavingsMultiple: number;
};

/** Which rate table priced a summary, shown beside the cost figures. */
export type UsagePricing = {
  source: 'litellm' | 'builtin';
  /** ISO timestamp of the catalog fetch; null for the built-in table. */
  fetchedAt: string | null;
};

export type UsageSummary = {
  range: { from: string; to: string };
  pricing: UsagePricing;
  totals: UsageTotals;
  byAgent: Record<UsageAgent, UsageAgentTotals>;
  series: UsageDayPoint[];
  models: UsageModelRow[];
  worktrees: UsageWorktreeRow[];
  skipped: number;
  bytesRead: number;
};

export type UsageQuotaWindow = { label: string; usedPercent: number; resetsAt: number | null };

export type UsageAccount = {
  agent: UsageAgent;
  /** When the figures were measured; Codex reports only while a session runs. */
  measuredAt: number | null;
  accountLabel: string;
  plan: string | null;
  credentialSource: string;
  windows: UsageQuotaWindow[];
  /** 'unavailable' means no vendor numbers — never show an estimate as a limit. */
  quotaStatus: 'official' | 'unavailable';
};

export type MachineSample = {
  cpuPercent: number;
  cpuCount: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  loadAvg: number[];
  uptimeSec: number;
};

// Settings → Sessions: every pty the daemon holds, machine-wide, with the
// CPU/memory of the process tree under it (GET /api/sessions/metrics).
export type SessionMetric = {
  /** TerminalManager key; what DELETE /api/sessions/:key takes. */
  key: string;
  path: string;
  mode: 'claude' | 'shell' | 'codex' | 'opencode' | 'pi';
  id: string;
  pid: number | null;
  cpu: number;
  rssBytes: number;
  processes: number;
};
export type AppProcMetric = { pid: number; cpu: number; rssBytes: number };
export type SessionMetrics = {
  sampledAt: number;
  app: {
    server: AppProcMetric;
    daemon: AppProcMetric | null;
    /** the shared `code serve-web` workbench and everything under it */
    vscode: (AppProcMetric & { processes: number }) | null;
  };
  sessions: SessionMetric[];
  /** one per VS Code window whose extension host reported its folder */
  vscodeWindows: Array<{ path: string; pid: number; cpu: number; rssBytes: number; processes: number }>;
  /** process tree of each pid asked for with ?pids= (worktree dev servers) */
  processes?: Array<{ pid: number; cpu: number; rssBytes: number; processes: number }>;
};

// "Add a host over SSH" — mirrors packages/server/src/services/sshSetup/types.ts.
// The dialog sends only a destination, a name and yes/no answers; the server
// job builds every command.
export type SshSetupStepId = 'connect' | 'check' | 'install' | 'pair' | 'service' | 'podman' | 'online';
export const SSH_SETUP_STEPS: { id: SshSetupStepId; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'check', label: 'Check machine' },
  { id: 'install', label: 'Install' },
  { id: 'pair', label: 'Pair' },
  { id: 'service', label: 'Service' },
  { id: 'podman', label: 'Podman' },
  { id: 'online', label: 'Online' },
];
export type SshSetupQuestion = {
  id: string;
  kind: 'repair-other-account' | 'overwrite-install' | 'linger' | 'podman';
  message: string;
  /** The exact command a yes runs in the terminal. */
  command?: string;
};
export type SshSetupProgress =
  | { step: SshSetupStepId; detail?: string }
  | { question: SshSetupQuestion }
  | { terminal: { key: string } }
  /** Replay for a late subscriber: the transcript so far, sent before anything live. */
  | { transcript: string };
export type SshSetupResult = { runnerId: string; name: string; sandboxes: boolean; warnings: string[] };
export const SSH_SETUP_TERMINAL_PATH = '/ws/ssh-setup-terminal';

// Host connections — mirrors packages/server/src/services/connections/types.ts.
// connected only ever comes from a real check on the runner; never a token.
export type ConnectionAgent = 'claude' | 'codex' | 'opencode' | 'pi';
export const CONNECTION_AGENTS: ConnectionAgent[] = ['claude', 'codex', 'opencode', 'pi'];
export type ConnectionState = 'connected' | 'not-connected' | 'failed' | 'unknown';
export type AgentConnection = {
  agent: ConnectionAgent;
  state: ConnectionState;
  /** One fixed-string line for the row. Never a secret. */
  detail: string | null;
  /** ms epoch of the check that produced state; null if never checked. */
  checkedAt: number | null;
  /** Pi/OpenCode: a provider login only an interactive terminal can do here. */
  needsTerminal?: boolean;
};
export type DeviceLoginPrompt = { url: string; code: string; expiresAt: number };
export type ConnectPhase = 'opening-browser' | 'waiting-approval' | 'saving' | 'syncing' | 'checking';
export type ConnectQuestion = {
  id: string;
  kind: 'pin';
  runnerFingerprint: string;
  laptopFingerprint: string;
  /** Set when the runner's key changed: the one this laptop trusted before. */
  previousFingerprint?: string;
};
export type ConnectProgress = { phase: ConnectPhase } | { device: DeviceLoginPrompt } | { question: ConnectQuestion };
export type ConnectResult = { connection: AgentConnection };
export type HostInfo = {
  runnerId: string;
  ssh: { target: string; port: number | null; addedAt: number; lastInstallVersion: string | null } | null;
  /** The runner's box-key fingerprint as pinned on this laptop, null if never synced. */
  pinnedRunnerFingerprint: string | null;
  laptopFingerprint: string;
};

// Host Sandboxes and Logs tabs — mirrors packages/server/src/services/hostTabs/types.ts.
// Never an env value: only these fields leave the runner; log text is redacted there.
export type SandboxAction = 'restart' | 'stop' | 'start' | 'rebuild' | 'remove';
export type SandboxRow = {
  /** Container identity (strado-sbx-<slug>), the key for actions. */
  slug: string;
  /** null for a container with no label of ours (shown, never actionable). */
  worktreePath: string | null;
  repoName: string | null;
  worktreeName: string | null;
  status: 'running' | 'stopped' | 'creating' | 'unknown';
  image: string;
  /** ms epoch. */
  createdAt: number;
  startedAt: number | null;
  cpuPercent: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
  /** Agents whose login changed on the runner after this container was made. */
  staleLogins: ('claude' | 'codex' | 'opencode' | 'pi')[];
};
export type SandboxList = { sandboxes: SandboxRow[]; runtime: 'podman' | 'docker' | null };
export type LogLine = { ts: number; level: 'info' | 'warn' | 'error' | 'debug'; text: string };
export type LogQuery = { lines?: number; grep?: string; since?: number };
export type LogPage = { lines: LogLine[]; source: 'journal' | 'file' | 'none'; nextSince: number | null };
