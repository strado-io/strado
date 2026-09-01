export type Editor = 'code' | 'cursor' | 'subl' | 'webstorm';

export type EnvProfile = { name: string; envFile: string };

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
  envProfiles?: EnvProfile[];
  defaultEnvProfile?: string;
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
  activeEnvProfile?: string | null;
  workflowStatus?: WorkflowStatus | null;
  note?: string | null;
  order?: number | null;
  // per-worktree overrides; null/absent falls back to the repo config
  startCommand?: string | null;
  previewUrl?: string | null;
};

export type ProcInfo = {
  status: 'idle' | 'starting' | 'running' | 'stopped' | 'crashed';
  pid: number | null;
  startedAt: string | null;
  port: number | null;
  detectedUrl: string | null;
  exitCode: number | null;
  external?: boolean;
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
