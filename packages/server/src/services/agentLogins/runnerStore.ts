// What a laptop synced to this runner, kept 0600 beside the runner's state.
//
// Stored before any container work, because a sync must be fast and a fresh
// runner has no image yet: every sandbox provision re-applies `volume` to the
// HOME volume, so the first sandbox on a new host still comes up logged in.
// The Claude token never enters the volume — it reaches sandboxes only as
// CLAUDE_CODE_OAUTH_TOKEN in their 0600 env-file, at create.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AgentName } from './types.js';
import type { VolumePayload } from './volumeWriter.js';

const StaticProviders = z.record(
  z.union([
    z.object({ type: z.literal('api'), key: z.string().min(1) }),
    z.object({ type: z.literal('oauth'), access: z.string().min(1), refresh: z.literal(''), expires: z.number() }),
  ]),
);
const StoreSchema = z.object({
  /** issuedAt of the last bundle accepted; anything not newer is a replay. */
  lastIssuedAt: z.number().optional(),
  claudeToken: z.string().min(1).optional(),
  volume: z
    .object({
      claude: z
        .object({ oauthAccount: z.record(z.unknown()).optional(), lastOnboardingVersion: z.string().optional() })
        .optional(),
      codex: z.object({ apiKey: z.string().min(1) }).optional(),
      opencode: z.object({ providers: StaticProviders }).optional(),
      pi: z.object({ providers: StaticProviders }).optional(),
    })
    .optional(),
  disconnected: z.array(z.enum(['claude', 'codex', 'opencode', 'pi'])).optional(),
  changedAt: z.object({ claude: z.number(), codex: z.number(), opencode: z.number(), pi: z.number() }).partial().optional(),
  managed: z
    .object({ codex: z.boolean().optional(), opencode: z.array(z.string().max(64)).max(64).optional() })
    .optional(),
});

/** trustPaths are per worktree and never stored. */
export type StoredVolume = { [K in keyof VolumePayload]?: K extends 'claude' ? Omit<NonNullable<VolumePayload['claude']>, 'trustPaths'> : VolumePayload[K] };
/** Logins a Connect made on this runner (device logins), which Disconnect
 *  removes along with the synced entries: codex's auth file, opencode ids. */
export type ManagedLogins = { codex?: boolean; opencode?: string[] };
export type RunnerAgentLogins = {
  lastIssuedAt?: number;
  claudeToken?: string;
  volume?: StoredVolume;
  managed?: ManagedLogins;
  /** Agents the user disconnected here: a sync skips them until an explicit
   *  Connect of that agent (or a device login) brings them back. */
  disconnected?: AgentName[];
  /** ms epoch an agent's login last changed here (sync with a different
   *  value, disconnect, device login): a container made before it is stale. */
  changedAt?: Partial<Record<AgentName, number>>;
};

/** The store with `agents` marked as changed now. */
export const markChanged = (s: RunnerAgentLogins, agents: AgentName[], now = Date.now()): RunnerAgentLogins =>
  agents.length ? { ...s, changedAt: { ...s.changedAt, ...Object.fromEntries(agents.map((a) => [a, now])) } } : s;

// Every read-modify-write of the store goes through here: a sync, a
// disconnect and a device login finishing must not overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
export function withRunnerStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function runnerAgentLoginsPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'agent-logins-runner.json');
}

export async function readRunnerAgentLogins(): Promise<RunnerAgentLogins> {
  try {
    return StoreSchema.parse(JSON.parse(await fsp.readFile(runnerAgentLoginsPath(), 'utf8')));
  } catch {
    return {};
  }
}

export async function writeRunnerAgentLogins(next: RunnerAgentLogins): Promise<void> {
  const p = runnerAgentLoginsPath();
  const clean: RunnerAgentLogins = {
    ...(next.lastIssuedAt !== undefined ? { lastIssuedAt: next.lastIssuedAt } : {}),
    ...(next.claudeToken?.trim() ? { claudeToken: next.claudeToken.trim() } : {}),
    ...(next.volume && Object.keys(next.volume).length ? { volume: next.volume } : {}),
    ...(next.managed && (next.managed.codex || next.managed.opencode?.length) ? { managed: next.managed } : {}),
    ...(next.disconnected?.length ? { disconnected: [...new Set(next.disconnected)] } : {}),
    ...(next.changedAt && Object.keys(next.changedAt).length ? { changedAt: next.changedAt } : {}),
  };
  if (!Object.keys(clean).length) {
    await fsp.rm(p, { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // tmp+rename: a crash mid-write must not leave a half file that reads as
  // empty and resets lastIssuedAt.
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(clean) + '\n', { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, p);
}

export async function readRunnerClaudeToken(): Promise<string | null> {
  return (await readRunnerAgentLogins()).claudeToken ?? null;
}

/** Passing null (or a blank string) clears the token; the rest is kept. */
export async function writeRunnerClaudeToken(token: string | null): Promise<void> {
  const cur = await readRunnerAgentLogins();
  await writeRunnerAgentLogins({ ...cur, claudeToken: token ?? undefined });
}
