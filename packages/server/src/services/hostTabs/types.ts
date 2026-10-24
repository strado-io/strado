// The contract for a host's Sandboxes and Logs tabs: the containers a runner
// runs for its worktrees, the actions on them, and the runner's own log.
// Shared by the runner routes, the laptop proxy routes and the page.

export type SandboxAction = 'restart' | 'stop' | 'start' | 'rebuild' | 'remove';

export type SandboxRow = {
  /** Container identity (strado-sbx-<slug>), the key for actions. */
  slug: string;
  /** The worktree it belongs to, from its io.strado.worktree label; null for
   *  a container with no label of ours (shown, never actionable). */
  worktreePath: string | null;
  /** Repo/worktree names for display, when the runner knows them. */
  repoName: string | null;
  worktreeName: string | null;
  status: 'running' | 'stopped' | 'creating' | 'unknown';
  image: string;
  /** ms epoch. */
  createdAt: number;
  startedAt: number | null;
  /** From one `stats --no-stream` sample; null when stopped or unavailable. */
  cpuPercent: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
  /** Agents whose login changed on the runner after this container was made:
   *  it still has the old state until rebuilt. Empty when up to date. */
  staleLogins: ('claude' | 'codex' | 'opencode' | 'pi')[];
};

export type SandboxList = { sandboxes: SandboxRow[]; runtime: 'podman' | 'docker' | null };

export type LogLine = {
  /** ms epoch. */
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  /** Already redacted on the runner: anything shaped like a credential is
   *  replaced with [redacted]. */
  text: string;
};

export type LogQuery = {
  /** 1..1000, default 300. */
  lines?: number;
  /** Case-insensitive substring filter applied on the runner. */
  grep?: string;
  /** Only lines after this ms epoch (for follow polling). */
  since?: number;
};

export type LogPage = { lines: LogLine[]; source: 'journal' | 'file' | 'none'; nextSince: number | null };

/** Runner routes (root-level, 404 unless runner; under /api/sandbox/ so the
 *  laptop rpc proxy can't reach them). */
export const RUNNER_HOST_TAB_PATHS = {
  sandboxes: '/api/sandbox/containers', // GET → SandboxList
  action: '/api/sandbox/containers/:slug/:action', // POST → { ok: true } | job for rebuild: { jobId }
  logs: '/api/sandbox/runner-logs', // GET ?lines&grep&since → LogPage
} as const;

/** Laptop routes. */
export const HOST_TAB_ROUTES = {
  sandboxes: '/api/runners/:id/sandboxes', // GET → SandboxList
  action: '/api/runners/:id/sandboxes/:slug/:action', // POST → { ok: true } | { jobId }
  logs: '/api/runners/:id/logs', // GET ?lines&grep&since → LogPage
} as const;
