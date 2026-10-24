// The wire contract for syncing a laptop's agent logins to a runner. Shared by
// the laptop side (collect, seal, send) and the runner side (open, store,
// write into the sandbox home volume), so both ends agree on one shape.

/** What the laptop sends, before sealing. Only non-rotating credentials: a
 *  Claude setup-token, a Codex API key, OpenCode api-type providers. */
/** A provider login that never rotates, so two machines can hold it at once:
 *  an api key, or an oauth entry whose refresh token is empty (OpenRouter
 *  issues a static key that way). Only these fields travel; an entry with a
 *  refresh token is never copied. */
export type StaticEntry =
  | { type: 'api'; key: string }
  | { type: 'oauth'; access: string; refresh: ''; expires: number };

export type AgentLoginBundle = {
  /** ms epoch, strictly increasing per runner: the runner refuses a bundle not
   *  newer than the last one it accepted, so an old bundle can't be replayed
   *  to roll it back. */
  issuedAt: number;
  /** Set by an explicit Connect of one agent: the runner clears that agent
   *  from its disconnected list. Every other sync (auto-sync on worktree
   *  create, Connect of another agent) leaves disconnected agents alone, so a
   *  Disconnect sticks. Inside the sealed, signed body, so the relay can't set it. */
  connect?: AgentName;
  claude?: { token: string; oauthAccount?: Record<string, unknown>; lastOnboardingVersion?: string };
  codex?: { apiKey: string };
  opencode?: { providers: Record<string, StaticEntry> };
  /** ~/.pi/agent/auth.json entries. */
  pi?: { providers: Record<string, StaticEntry> };
};

/** The bundle sealed to the runner's X25519 key and signed by the laptop's
 *  Ed25519 key. base64 fields; epk is the raw 32-byte ephemeral public key, spk
 *  the raw 32-byte sender public key. sig is Ed25519 over
 *  `strado-agent-logins:v1|${epk}|${iv}|${ct}|${tag}` (the base64 strings).
 *  Sealing alone is anonymous: the signature is what lets the runner refuse a
 *  bundle from anyone but the laptop it pinned on first use. The relay only
 *  ever sees this. */
export type SealedBundle = { v: 1; epk: string; iv: string; ct: string; tag: string; spk: string; sig: string };

export type AgentName = 'claude' | 'codex' | 'opencode' | 'pi';
/** pending: stored on the runner, written into the home volume when its first sandbox starts. */
export type AgentOutcome = 'written' | 'unchanged' | 'skipped' | 'pending' | 'failed';

/** pi is optional: a runner older than Pi sync doesn't report it. */
export type RunnerSyncResult = {
  fingerprint: string;
  agents: Record<Exclude<AgentName, 'pi'>, AgentOutcome> & { pi?: AgentOutcome };
};
export type LaptopSyncResult = RunnerSyncResult & { pin: 'new' | 'match' };

/** publicKey is base64 of the raw 32-byte X25519 public key. */
export type BoxKeyInfo = { publicKey: string; fingerprint: string };

export const AGENT_LOGIN_PATHS = {
  boxKey: '/api/sandbox/box-key',
  sync: '/api/sandbox/agent-logins',
} as const;
