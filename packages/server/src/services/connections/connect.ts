import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { JobContext } from '../jobs.js';
import type { RunnerFetch } from '../runnerFetch.js';
import type { LaptopSyncResult } from '../agentLogins/types.js';
import { untilCancelled, type SetupRun } from '../sshSetup/job.js';
import { SETUP_TOKEN_ERRORS, type SetupTokenPhase } from './claudeSetupToken.js';
import {
  CONNECTION_AGENTS, RUNNER_CONNECTION_PATHS,
  type AgentConnection, type ConnectionAgent, type ConnectProgress, type ConnectResult, type RunnerCheckResult,
} from './types.js';

// One agent's Connect on one runner, and its Check and Disconnect. Claude:
// capture a setup-token here (unless stored), then the sealed sync. Codex and
// OpenCode: a device login the runner runs; this side shows its code and waits.
// Pi: the sealed sync of its static entries. Every path ends in a real check on
// the runner, and every error is a fixed string: the runner's own error text
// never rides along.

/** previousFingerprint: the pinned key a changed one would replace. */
export type PinQuestion = { kind: 'pin'; runnerFingerprint: string; laptopFingerprint: string; previousFingerprint?: string };

export type ConnectDeps = {
  fetch: RunnerFetch['fetch'];
  isOnline(runnerId: string): Promise<boolean>;
  hasClaudeToken(): Promise<boolean>;
  captureSetupToken(opts: { onPhase(p: SetupTokenPhase): void; signal: AbortSignal }): Promise<void>;
  /** The explicit sealed sync for `connect`'s Connect, asking `confirmPin`
   *  before a first pin or a re-pin. */
  sync(
    runnerId: string,
    confirmPin: (runnerFp: string, laptopFp: string, previousFp: string | null) => Promise<boolean>,
    connect: 'claude' | 'pi',
  ): Promise<LaptopSyncResult>;
  /** An unanswered pin question counts as no after this (default 10 min). */
  pinTimeoutMs?: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  devicePollMs: number;
};

export const CONNECT_CANCELLED = 'connect cancelled';
const OFFLINE = 'runner is offline';
const UNREACHABLE = 'runner unreachable';
const BAD_CHECK = 'the runner sent no usable check';
const NO_DEVICE = 'the runner could not start a login';
const NOT_APPROVED = 'the login was not approved';
const TIMED_OUT = 'approval timed out';
/** Codex device codes last 15 minutes; the runner kills its login at 16. */
const DEVICE_MAX_MS = 16 * 60_000;
const PIN_TIMEOUT_MS = 10 * 60_000;

const PHASE_TEXT: Record<Extract<ConnectProgress, { phase: string }>['phase'], string> = {
  'opening-browser': 'Opening the browser…',
  'waiting-approval': 'Waiting for you to approve in the browser…',
  saving: 'Saving the login…',
  syncing: 'Sending the login to the runner…',
  checking: 'Checking the login on the runner…',
};

const CheckResult = z.object({
  state: z.enum(['connected', 'not-connected', 'failed', 'unknown']),
  // Cut, not refused: a runner listing many providers can run long.
  detail: z.string().max(2000).nullable().transform((d) => (d === null ? null : d.slice(0, 200))),
  needsTerminal: z.boolean().optional(),
}).strip();
const DeviceStart = z.object({
  loginId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  // The page opens this: only OpenAI's device page, whatever the runner says.
  url: z.string().max(300).regex(/^https:\/\/auth\.openai\.com\/[A-Za-z0-9/_-]*$/),
  code: z.string().regex(/^[A-Z0-9-]{4,16}$/),
  expiresAt: z.number(),
});
const DeviceWait = z.object({ done: z.boolean(), ok: z.boolean().optional() });

export type ConnectionCache = {
  list(runnerId: string): AgentConnection[];
  set(runnerId: string, c: AgentConnection): void;
};

/** The last verified state per runner, in memory: what the list route serves. */
export function createConnectionCache(): ConnectionCache {
  const byRunner = new Map<string, Map<ConnectionAgent, AgentConnection>>();
  return {
    list: (runnerId) => CONNECTION_AGENTS.map((agent) =>
      byRunner.get(runnerId)?.get(agent) ?? { agent, state: 'unknown', detail: null, checkedAt: null }),
    set(runnerId, c) {
      let m = byRunner.get(runnerId);
      if (!m) byRunner.set(runnerId, (m = new Map()));
      m.set(c.agent, c);
    },
  };
}

const fail = (message: string) => new AppError('VALIDATION', message);
const agentPath = (tpl: string, agent: ConnectionAgent) => tpl.replace(':agent', agent);

async function assertOnline(runnerId: string, deps: ConnectDeps): Promise<void> {
  let online: boolean;
  try {
    online = await deps.isOnline(runnerId);
  } catch {
    throw fail(UNREACHABLE);
  }
  if (!online) throw new AppError('CONFLICT', OFFLINE);
}

/** One runner call whose failure text is never passed on. */
async function call<T>(deps: ConnectDeps, runnerId: string, path: string, schema: z.ZodType<T>, bad: string, method = 'POST', timeoutMs?: number): Promise<T> {
  let body: unknown;
  try {
    body = await deps.fetch<unknown>(runnerId, path, { method, ...(timeoutMs ? { timeoutMs } : {}) });
  } catch {
    throw fail(UNREACHABLE);
  }
  const res = schema.safeParse(body);
  if (!res.success) throw fail(bad);
  return res.data;
}

function toConnection(agent: ConnectionAgent, r: RunnerCheckResult, checkedAt: number): AgentConnection {
  return { agent, state: r.state, detail: r.detail, checkedAt, ...(r.needsTerminal !== undefined ? { needsTerminal: r.needsTerminal } : {}) };
}

async function runCheck(runnerId: string, agent: ConnectionAgent, deps: ConnectDeps, cache: ConnectionCache): Promise<AgentConnection> {
  // A real call in a container (Claude spends a tiny prompt): give it time.
  const r = await call(deps, runnerId, agentPath(RUNNER_CONNECTION_PATHS.check, agent), CheckResult, BAD_CHECK, 'POST', 120_000);
  const c = toConnection(agent, r, deps.now());
  cache.set(runnerId, c);
  return c;
}

export async function checkConnection(runnerId: string, agent: ConnectionAgent, deps: ConnectDeps, cache: ConnectionCache): Promise<AgentConnection> {
  await assertOnline(runnerId, deps);
  return runCheck(runnerId, agent, deps, cache);
}

export async function disconnectConnection(runnerId: string, agent: ConnectionAgent, deps: ConnectDeps, cache: ConnectionCache): Promise<AgentConnection> {
  await assertOnline(runnerId, deps);
  const r = await call(deps, runnerId, agentPath(RUNNER_CONNECTION_PATHS.disconnect, agent), CheckResult, BAD_CHECK, 'POST', 60_000);
  const c = toConnection(agent, r, deps.now());
  cache.set(runnerId, c);
  return c;
}

export async function runConnect(
  ctx: JobContext,
  input: { runnerId: string; agent: ConnectionAgent },
  deps: ConnectDeps,
  run: SetupRun<PinQuestion>,
  cache: ConnectionCache,
): Promise<ConnectResult> {
  const { runnerId, agent } = input;
  const guard = <T>(p: Promise<T>) => untilCancelled(run.signal, p, CONNECT_CANCELLED);
  const phase = (p: keyof typeof PHASE_TEXT) => ctx.progress(PHASE_TEXT[p], { phase: p } satisfies ConnectProgress);
  const confirmPin = async (runnerFingerprint: string, laptopFingerprint: string, previous: string | null) => {
    const q: PinQuestion = { kind: 'pin', runnerFingerprint, laptopFingerprint, ...(previous ? { previousFingerprint: previous } : {}) };
    const message = previous ? "This runner's key changed. Trust the new key?" : 'Trust this runner? Compare the fingerprints first.';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), deps.pinTimeoutMs ?? PIN_TIMEOUT_MS); });
    try {
      return await Promise.race([run.ask(ctx, q, message), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  await assertOnline(runnerId, deps);
  try {
    if (agent === 'claude' || agent === 'pi') {
      if (agent === 'claude' && !(await deps.hasClaudeToken())) {
        // Only its own known fixed strings pass through; anything else is generic.
        await guard(deps.captureSetupToken({ onPhase: phase, signal: run.signal }).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : '';
          throw fail(SETUP_TOKEN_ERRORS.has(msg) ? msg : 'connect failed');
        }));
      }
      phase('syncing');
      const res = await guard(deps.sync(runnerId, confirmPin, agent));
      if (res.agents[agent] === 'failed') throw fail(`the runner could not store the ${agent === 'claude' ? 'Claude' : 'Pi'} login`);
    } else {
      await guard(deviceLogin(ctx, runnerId, agent, deps, guard));
    }
    phase('checking');
    return { connection: await guard(runCheck(runnerId, agent, deps, cache)) };
  } catch (err) {
    // A cancel or a trust refusal leaves the row as it was; a login that was
    // tried and failed reads failed, with our own fixed text only.
    const mine = err instanceof AppError;
    if (!(mine && (err.message === CONNECT_CANCELLED || err.code === 'FORBIDDEN'))) {
      cache.set(runnerId, { agent, state: 'failed', detail: mine ? err.message : 'connect failed', checkedAt: deps.now() });
    }
    throw mine ? err : fail('connect failed');
  }
}

async function deviceLogin(
  ctx: JobContext,
  runnerId: string,
  agent: 'codex' | 'opencode',
  deps: ConnectDeps,
  guard: <T>(p: Promise<T>) => Promise<T>,
): Promise<void> {
  const start = await guard(call(deps, runnerId, agentPath(RUNNER_CONNECTION_PATHS.deviceStart, agent), DeviceStart, NO_DEVICE, 'POST', 60_000));
  const { loginId, ...device } = start;
  // One frame, kept as the job's latest until approval: a page that attaches
  // late still gets the code.
  ctx.progress('Enter the code on the page that opened, then approve', { device } satisfies ConnectProgress);
  const deadline = Math.min(device.expiresAt, deps.now() + DEVICE_MAX_MS);
  const id = encodeURIComponent(loginId);
  const waitPath = RUNNER_CONNECTION_PATHS.deviceWait.replace(':loginId', id);
  try {
    while (deps.now() < deadline) {
      const w = await guard(call(deps, runnerId, waitPath, DeviceWait, UNREACHABLE, 'GET'));
      if (w.done) {
        if (!w.ok) throw fail(NOT_APPROVED);
        return;
      }
      await guard(deps.sleep(deps.devicePollMs));
    }
    throw fail(TIMED_OUT);
  } catch (err) {
    // Cancelled, timed out or lost: end the runner's login container now rather
    // than at its own 16-minute kill. Best effort; the real error wins.
    const ended = err instanceof AppError && err.message === NOT_APPROVED;
    if (!ended) {
      await deps.fetch(runnerId, RUNNER_CONNECTION_PATHS.deviceCancel.replace(':loginId', id), { method: 'DELETE', timeoutMs: 10_000 })
        .catch(() => undefined);
    }
    throw err;
  }
}
