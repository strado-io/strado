import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { RunnerFetch } from '../runnerFetch.js';
import { collectBundle, type CollectedBundle } from './collect.js';
import { checkPin, peekPin, replacePin } from './pins.js';
import { fingerprintOf, sealBundle } from './seal.js';
import { loadSenderKey, nextIssuedAt, type SenderKey } from './senderKey.js';
import { AGENT_LOGIN_PATHS, type AgentName, type LaptopSyncResult } from './types.js';

// One laptop → runner sync: fetch the runner's sealing key, check it against
// the pin, seal and sign what this laptop has, send it. Every error is a fixed
// string: runner.fetch errors quote the far side's body, which must never ride
// along on a path that carries secrets.

export type SyncDeps = {
  fetch: RunnerFetch['fetch'];
  checkPin: (runnerId: string, fingerprint: string) => Promise<'new' | 'match' | 'changed'>;
  peekPin: (runnerId: string) => Promise<string | null>;
  collect: () => Promise<CollectedBundle>;
  senderKey: () => Promise<SenderKey>;
  issuedAt: () => number;
  /** Explicit mode, a runner key not pinned yet or changed: ask the person,
   *  showing the runner's key, this laptop's, and the pinned one it replaces
   *  (null on first contact), before trusting it. Without it the first explicit
   *  sync pins on use and a changed key is refused. */
  confirmPin?: (runnerFingerprint: string, laptopFingerprint: string, previousFingerprint: string | null) => Promise<boolean>;
  replacePin?: (runnerId: string, from: string, to: string) => Promise<boolean>;
  /** Explicit mode only: the agent a Connect is for, so the runner takes it off
   *  its disconnected list. Auto-sync never sends it, so a Disconnect sticks. */
  connect?: AgentName;
};

export const KEY_CHANGED = 'runner key changed — re-trust it with Connect on its host page';
/** The runner pinned a different laptop's sender key. */
export const SENDER_UNTRUSTED = 'sender not trusted by this runner — it trusts a different laptop';
export const STALE_BUNDLE = 'runner already has newer logins than this sync — try again';
const NOT_PINNED = 'runner not trusted yet — sync it once from Runners';
export const PIN_DECLINED = 'runner not trusted yet';
const SYNC_FAILED = 'agent login sync failed on the runner';

const BoxKey = z.object({ publicKey: z.string(), fingerprint: z.string() });
const Outcome = z.enum(['written', 'unchanged', 'skipped', 'pending', 'failed']);
const RunnerResult = z.object({
  fingerprint: z.string(),
  agents: z.object({ claude: Outcome, codex: Outcome, opencode: Outcome, pi: Outcome.optional() }),
});

/** The runner's own fixed refusals, told apart by their fixed text; nothing of
 *  its body is passed on. */
function mapRunnerError(err: unknown): AppError {
  const msg = err instanceof Error ? err.message : '';
  if (msg.endsWith(': sender not trusted by this runner')) return new AppError('FORBIDDEN', SENDER_UNTRUSTED);
  if (msg.endsWith(': stale bundle')) return new AppError('CONFLICT', STALE_BUNDLE);
  return new AppError('CLOUD_UNREACHABLE', SYNC_FAILED);
}

/**
 * 'explicit' (the Sync button) pins a runner's key on first use. 'auto' (worktree
 * create) never pins: it sends only to a runner whose key already matches.
 */
export async function syncAgentLogins(
  runnerId: string,
  deps: Pick<SyncDeps, 'fetch'> & Partial<SyncDeps>,
  mode: 'explicit' | 'auto' = 'explicit',
): Promise<LaptopSyncResult> {
  const {
    fetch, checkPin: check = checkPin, peekPin: peek = peekPin, collect = collectBundle,
    senderKey = loadSenderKey, issuedAt = nextIssuedAt, confirmPin, replacePin: replace = replacePin, connect,
  } = deps;

  let key: z.infer<typeof BoxKey>;
  try {
    key = BoxKey.parse(await fetch<unknown>(runnerId, AGENT_LOGIN_PATHS.boxKey));
  } catch (err) {
    throw err instanceof z.ZodError
      ? new AppError('CLOUD_UNREACHABLE', 'runner sent no usable key')
      : new AppError('CLOUD_UNREACHABLE', 'runner unreachable');
  }
  if (Buffer.from(key.publicKey, 'base64').length !== 32) throw new AppError('CLOUD_UNREACHABLE', 'runner sent no usable key');
  // Pin what the key hashes to, never the runner's own claim about it: a relay
  // swapping the key could just as well send the old fingerprint.
  const fingerprint = fingerprintOf(key.publicKey);
  if (key.fingerprint !== fingerprint) throw new AppError('FORBIDDEN', 'runner sent an inconsistent key');

  let pin: 'new' | 'match';
  if (mode === 'auto') {
    const pinned = await peek(runnerId);
    if (pinned === null) throw new AppError('FORBIDDEN', NOT_PINNED);
    if (pinned !== fingerprint) throw new AppError('FORBIDDEN', KEY_CHANGED, { expected: pinned, actual: fingerprint });
    pin = 'match';
  } else {
    const pinned = confirmPin ? await peek(runnerId) : undefined;
    if (confirmPin && pinned !== fingerprint) {
      const laptop = fingerprintOf((await senderKey()).publicKey);
      const yes = await confirmPin(fingerprint, laptop, pinned ?? null);
      // A no reads the same for a first and a changed key.
      if (!yes) throw new AppError('FORBIDDEN', PIN_DECLINED);
    }
    if (confirmPin && pinned && pinned !== fingerprint) {
      // Only from the key the person was shown: a pin that moved meanwhile is
      // not silently overwritten.
      if (!(await replace(runnerId, pinned, fingerprint))) throw new AppError('CONFLICT', 'runner trust changed meanwhile — try again');
      pin = 'new';
    } else {
      const state = await check(runnerId, fingerprint);
      if (state === 'changed') {
        throw new AppError('FORBIDDEN', KEY_CHANGED, { expected: await peek(runnerId), actual: fingerprint });
      }
      pin = state;
    }
  }

  const sender = await senderKey();
  const marker = mode === 'explicit' && connect ? { connect } : {};
  const sealed = sealBundle({ ...(await collect()), ...marker, issuedAt: issuedAt() }, key.publicKey, sender.privateKey);
  let answer: unknown;
  try {
    answer = await fetch<unknown>(runnerId, AGENT_LOGIN_PATHS.sync, { method: 'POST', body: sealed, timeoutMs: 60_000 });
  } catch (err) {
    throw mapRunnerError(err);
  }
  const res = RunnerResult.safeParse(answer);
  if (!res.success) throw new AppError('CLOUD_UNREACHABLE', SYNC_FAILED);
  return { ...res.data, pin };
}

/** Waits for `p` but no longer than `ms`; `p` keeps running either way. Lets
 *  worktree create give the sync a head start without stalling on a runner
 *  that is slow to answer. */
export function waitAtMost(p: Promise<unknown>, ms: number): Promise<'settled' | 'timed-out'> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => resolve('timed-out'), ms); });
  return Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), cap]).finally(() => clearTimeout(timer));
}
