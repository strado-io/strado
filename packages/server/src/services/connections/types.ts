// The contract for a host's Connections tab: which agents are logged in on a
// runner, and the one action that connects each. Shared by the runner (checks,
// device logins, disconnect), the laptop (Claude token capture, routes, the
// connect job) and the page.

export type ConnectionAgent = 'claude' | 'codex' | 'opencode' | 'pi';
export const CONNECTION_AGENTS: ConnectionAgent[] = ['claude', 'codex', 'opencode', 'pi'];

/** connected is only ever set by a real check on the runner. */
export type ConnectionState = 'connected' | 'not-connected' | 'failed' | 'unknown';

export type AgentConnection = {
  agent: ConnectionAgent;
  state: ConnectionState;
  /** One fixed-string line for the row, e.g. "Logged in with ChatGPT",
   *  "3 providers: Anthropic, Bedrock, OpenRouter". Never a secret. */
  detail: string | null;
  /** ms epoch of the check that produced state; null if never checked. */
  checkedAt: number | null;
  /** Pi/OpenCode: a provider login only an interactive terminal can do here. */
  needsTerminal?: boolean;
};

/** What the runner reports for one agent check. */
export type RunnerCheckResult = Omit<AgentConnection, 'agent' | 'checkedAt'>;

/** A device-code login started on the runner (Codex; OpenCode ChatGPT). */
export type DeviceLoginPrompt = { url: string; code: string; expiresAt: number };

/** Carried in a connect job's progress frame data. */
export type ConnectProgress =
  | { phase: 'opening-browser' | 'waiting-approval' | 'saving' | 'syncing' | 'checking' }
  | { device: DeviceLoginPrompt }
  /** First contact with this runner: both fingerprints, answered via the answer route. */
  /** previousFingerprint: set when the runner's key changed — the pinned
   *  one a yes replaces. Absent on first contact. */
  | { question: { id: string; kind: 'pin'; runnerFingerprint: string; laptopFingerprint: string; previousFingerprint?: string } };

export type ConnectResult = { connection: AgentConnection };

/** Laptop routes (all assertLocalHub). */
export const CONNECTION_ROUTES = {
  list: '/api/runners/:id/connections', // GET → { connections: AgentConnection[]; stale: boolean } (cached; stale when the runner is offline)
  connect: '/api/runners/:id/connections/:agent/connect', // POST → { jobId }
  check: '/api/runners/:id/connections/:agent/check', // POST → { connection }
  disconnect: '/api/runners/:id/connections/:agent/disconnect', // POST → { connection }
  answer: '/api/connections/jobs/:jobId/answer', // POST { questionId, yes } → 204
  cancel: '/api/connections/jobs/:jobId/cancel', // POST → 204
  host: '/api/runners/:id/host', // GET → HostInfo
} as const;

/** Runner routes (root-level, 404 unless runner + sandbox runtime). Not reachable
 *  through /api/runners/:id/rpc (the /api/sandbox/ denylist covers them). */
export const RUNNER_CONNECTION_PATHS = {
  check: '/api/sandbox/connections/:agent/check', // POST → RunnerCheckResult
  deviceStart: '/api/sandbox/connections/:agent/device', // POST → DeviceLoginPrompt & { loginId }
  deviceWait: '/api/sandbox/connections/device/:loginId', // GET → { done: boolean; ok?: boolean }
  deviceCancel: '/api/sandbox/connections/device/:loginId', // DELETE → 204; kills the login container
  disconnect: '/api/sandbox/connections/:agent/disconnect', // POST → RunnerCheckResult
} as const;

export type HostInfo = {
  runnerId: string;
  ssh: { target: string; port: number | null; addedAt: number; lastInstallVersion: string | null } | null;
  /** The runner's box-key fingerprint as pinned on this laptop, null if never synced. */
  pinnedRunnerFingerprint: string | null;
  laptopFingerprint: string;
};
