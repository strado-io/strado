// Runner side of a host's Connections tab: check an agent's login, start a
// device-code login, and disconnect. Reached by the laptop through the relay,
// never through /api/runners/:id/rpc (its /api/sandbox/ denylist).
//
// Every failure here is a fixed string: the laptop echoes far-side error
// bodies, and the CLIs these routes run print tokens and codes.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { realExec, type ExecFn, type SandboxRuntime } from '../services/sandbox/runtime.js';
import type { SandboxService } from '../services/sandbox/sandboxes.js';
import {
  readRunnerAgentLogins,
  markChanged,
  readRunnerClaudeToken,
  withRunnerStoreLock,
  writeRunnerAgentLogins,
} from '../services/agentLogins/runnerStore.js';
import { checkAgent } from '../services/connections/runnerChecks.js';
import { createDeviceLogins, type DeviceAgent, type DeviceLogins } from '../services/connections/deviceLogin.js';
import { disconnectAgent } from '../services/connections/disconnect.js';
import type { OneShotDeps } from '../services/connections/oneShot.js';
import {
  CONNECTION_AGENTS,
  RUNNER_CONNECTION_PATHS,
  type DeviceLoginPrompt,
  type RunnerCheckResult,
} from '../services/connections/types.js';
import { anySandboxImage } from './agentLoginsRunner.js';

const AgentParams = z.object({ agent: z.enum(CONNECTION_AGENTS as [string, ...string[]]) });
const DeviceParams = z.object({ agent: z.enum(['codex', 'opencode']) });
const LoginParams = z.object({ loginId: z.string().regex(/^[0-9a-f]{32}$/) });

const NO_IMAGE: RunnerCheckResult = { state: 'unknown', detail: 'no sandbox image on this runner yet' };

export async function registerConnectionsRunnerRoutes(
  app: FastifyInstance,
  deps: {
    sandbox: Pick<SandboxService, 'ensureHomeVolume' | 'userArgs'>;
    sandboxRuntime: SandboxRuntime;
    exec?: ExecFn;
    /** Seams for the tests. */
    findImage?: (rt: SandboxRuntime) => Promise<string | null>;
    check?: typeof checkAgent;
    disconnect?: typeof disconnectAgent;
    deviceLogins?: (d: Parameters<typeof createDeviceLogins>[0]) => DeviceLogins;
    log?: (line: string) => void;
  },
): Promise<void> {
  const exec = deps.exec ?? realExec;
  const findImage = deps.findImage ?? ((rt: SandboxRuntime) => anySandboxImage(rt, exec));
  const check = deps.check ?? checkAgent;
  const disconnect = deps.disconnect ?? disconnectAgent;
  const log = deps.log ?? (() => {});

  /** The one-shot runtime for the current image, with the HOME volume ready. */
  const oneShot = async (): Promise<OneShotDeps | null> => {
    const image = await findImage(deps.sandboxRuntime);
    if (!image) return null;
    await deps.sandbox.ensureHomeVolume(image);
    return { rt: deps.sandboxRuntime, exec, image, userArgs: deps.sandbox.userArgs() };
  };

  const runCheck = async (agent: string): Promise<RunnerCheckResult> => {
    const d = await oneShot();
    if (!d) {
      // Claude's state needs no image when there is no token to test.
      if (agent === 'claude' && !(await readRunnerClaudeToken())) return { state: 'not-connected', detail: null };
      return NO_IMAGE;
    }
    return check(agent as never, { ...d, readClaudeToken: readRunnerClaudeToken });
  };

  // One device-login registry for the process; each start runs on the image
  // found for it.
  let logins: DeviceLogins | null = null;

  /** A device login that succeeded is Strado's to remove on Disconnect. */
  const markManaged = (agent: DeviceAgent) =>
    withRunnerStoreLock(async () => {
      const cur = await readRunnerAgentLogins();
      const managed = { ...cur.managed };
      if (agent === 'codex') managed.codex = true;
      else managed.opencode = [...new Set([...(managed.opencode ?? []), 'openai'])];
      // Logging in again is a Connect: syncs reach this agent again.
      const disconnected = (cur.disconnected ?? []).filter((a) => a !== agent);
      await writeRunnerAgentLogins(markChanged({ ...cur, managed, disconnected }, [agent]));
    });

  app.post(RUNNER_CONNECTION_PATHS.check, async (req): Promise<RunnerCheckResult> => {
    const p = AgentParams.safeParse(req.params);
    if (!p.success) throw new AppError('VALIDATION', 'unknown agent');
    try {
      return await runCheck(p.data.agent);
    } catch {
      log(`connections: check ${p.data.agent} failed`);
      return { state: 'unknown', detail: 'could not run the check on this runner' };
    }
  });

  app.post(RUNNER_CONNECTION_PATHS.deviceStart, async (req): Promise<DeviceLoginPrompt & { loginId: string }> => {
    const p = DeviceParams.safeParse(req.params);
    if (!p.success) throw new AppError('VALIDATION', 'no device login for this agent');
    let d: OneShotDeps | null;
    try {
      d = await oneShot();
    } catch {
      throw new AppError('SHELL_FAILED', 'device login did not start');
    }
    if (!d) throw new AppError('CONFLICT', 'no sandbox image on this runner yet');
    logins ??= (deps.deviceLogins ?? createDeviceLogins)({ ...d, onSuccess: markManaged });
    try {
      // The image is resolved per start: the registry outlives the image it
      // was made with (a first sandbox builds one; a rebuild replaces it).
      return await logins.start(p.data.agent, d);
    } catch {
      log(`connections: device login ${p.data.agent} did not start`);
      throw new AppError('SHELL_FAILED', 'device login did not start');
    }
  });

  app.get(RUNNER_CONNECTION_PATHS.deviceWait, async (req): Promise<{ done: boolean; ok?: boolean }> => {
    const p = LoginParams.safeParse(req.params);
    const s = p.success && logins ? logins.status(p.data.loginId) : null;
    if (!s) throw new AppError('NOT_FOUND', 'no such device login');
    return s;
  });

  app.delete(RUNNER_CONNECTION_PATHS.deviceCancel, async (req, reply) => {
    const p = LoginParams.safeParse(req.params);
    if (!p.success || !logins || !(await logins.cancel(p.data.loginId))) {
      throw new AppError('NOT_FOUND', 'no such device login');
    }
    return reply.code(204).send();
  });

  app.post(RUNNER_CONNECTION_PATHS.disconnect, async (req): Promise<RunnerCheckResult> => {
    const p = AgentParams.safeParse(req.params);
    if (!p.success) throw new AppError('VALIDATION', 'unknown agent');
    const agent = p.data.agent as (typeof CONNECTION_AGENTS)[number];
    let d: OneShotDeps | null;
    try {
      d = await oneShot();
    } catch {
      throw new AppError('SHELL_FAILED', 'disconnect failed');
    }
    try {
      await withRunnerStoreLock(() =>
        disconnect(agent, { oneShot: d, readStore: readRunnerAgentLogins, writeStore: writeRunnerAgentLogins }),
      );
    } catch {
      log(`connections: disconnect ${agent} failed`);
      throw new AppError('SHELL_FAILED', 'disconnect failed');
    }
    log(`connections: disconnected ${agent}`);
    try {
      return await runCheck(agent);
    } catch {
      return { state: 'unknown', detail: 'could not run the check on this runner' };
    }
  });
}
