import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { createCloudApi } from '../services/cloudApi.js';
import type { RunnerFetch } from '../services/runnerFetch.js';
import { peekPin } from '../services/agentLogins/pins.js';
import { fingerprintOf } from '../services/agentLogins/seal.js';
import { loadSenderKey } from '../services/agentLogins/senderKey.js';
import { readClaudeToken } from '../services/agentLogins/store.js';
import { syncAgentLogins } from '../services/agentLogins/sync.js';
import { createSharedCapture } from '../services/connections/claudeSetupToken.js';
import {
  CONNECT_CANCELLED, checkConnection, createConnectionCache, disconnectConnection, runConnect,
  type ConnectDeps, type PinQuestion,
} from '../services/connections/connect.js';
import { CONNECTION_AGENTS, CONNECTION_ROUTES, type HostInfo } from '../services/connections/types.js';
import { readSshHosts } from '../services/sshSetup/hosts.js';
import { createSetupRun, type SetupRun } from '../services/sshSetup/job.js';
import { assertLocalHub } from './profile.js';

// A host's Connections tab: the verified login state of each agent on a runner,
// and Connect / Check / Disconnect. Local hub only, every route: a connect
// captures and sends this laptop's logins, so a relayed window must not start
// one.

const RunnerParams = z.object({ id: z.string().min(1).max(64) });
const AgentParams = RunnerParams.extend({ agent: z.enum(CONNECTION_AGENTS as [string, ...string[]]) });
const JobParams = z.object({ jobId: z.string().min(1).max(64) });
const AnswerBody = z.object({ questionId: z.string().min(1).max(64), yes: z.boolean() }).strict();

type Agent = (typeof CONNECTION_AGENTS)[number];

export function liveConnectDeps(runner: RunnerFetch): ConnectDeps {
  const { token, cloud } = createCloudApi();
  return {
    fetch: runner.fetch,
    isOnline: async (id) =>
      (await cloud<{ runners: { runnerId: string; online: boolean }[] }>(`/v1/runners?token=${encodeURIComponent(await token())}`))
        .runners.some((r) => r.runnerId === id && r.online),
    hasClaudeToken: async () => (await readClaudeToken()) !== null,
    captureSetupToken: createSharedCapture(),
    sync: (id, confirmPin, connect) => syncAgentLogins(id, { fetch: runner.fetch, confirmPin, connect }, 'explicit'),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    devicePollMs: 3_000,
  };
}

export async function registerConnectionRoutes(app: FastifyInstance, runner: RunnerFetch, deps: ConnectDeps = liveConnectDeps(runner)): Promise<void> {
  const cache = createConnectionCache();
  const live = new Map<string, SetupRun<PinQuestion>>();
  /** `${runnerId}\0${agent}` → jobId: one connect per row at a time. */
  const connecting = new Map<string, string>();

  app.get(CONNECTION_ROUTES.list, async (req) => {
    assertLocalHub(req.headers);
    const { id } = RunnerParams.parse(req.params);
    let online = false;
    try {
      online = await deps.isOnline(id);
    } catch { /* unknown reads as stale */ }
    // stale: the runner is offline (or unknown), so these are the last checks, not now.
    return { connections: cache.list(id), stale: !online };
  });

  app.post(CONNECTION_ROUTES.connect, async (req) => {
    assertLocalHub(req.headers);
    const { id, agent } = AgentParams.parse(req.params) as { id: string; agent: Agent };
    const rowKey = `${id}\0${agent}`;
    if (connecting.has(rowKey)) throw new AppError('CONFLICT', 'already connecting');
    const run = createSetupRun<PinQuestion>(CONNECT_CANCELLED);
    const job = app.deps.jobs.start('agent-connect', (ctx) => runConnect(ctx, { runnerId: id, agent }, deps, run, cache));
    live.set(job.id, run);
    connecting.set(rowKey, job.id);
    void app.deps.jobs.wait(job.id).then(() => {
      live.delete(job.id);
      if (connecting.get(rowKey) === job.id) connecting.delete(rowKey);
    });
    return { jobId: job.id };
  });

  app.post(CONNECTION_ROUTES.check, async (req) => {
    assertLocalHub(req.headers);
    const { id, agent } = AgentParams.parse(req.params) as { id: string; agent: Agent };
    return { connection: await checkConnection(id, agent, deps, cache) };
  });

  app.post(CONNECTION_ROUTES.disconnect, async (req) => {
    assertLocalHub(req.headers);
    const { id, agent } = AgentParams.parse(req.params) as { id: string; agent: Agent };
    return { connection: await disconnectConnection(id, agent, deps, cache) };
  });

  app.post(CONNECTION_ROUTES.answer, async (req, reply) => {
    assertLocalHub(req.headers);
    const { jobId } = JobParams.parse(req.params);
    const { questionId, yes } = AnswerBody.parse(req.body);
    if (!live.get(jobId)?.answer(questionId, yes)) throw new AppError('NOT_FOUND', 'no such question');
    return reply.code(204).send();
  });

  app.post(CONNECTION_ROUTES.cancel, async (req, reply) => {
    assertLocalHub(req.headers);
    const { jobId } = JobParams.parse(req.params);
    const run = live.get(jobId);
    if (!run) throw new AppError('NOT_FOUND', 'no such connect');
    live.delete(jobId);
    run.cancel();
    return reply.code(204).send();
  });

  app.get(CONNECTION_ROUTES.host, async (req): Promise<HostInfo> => {
    assertLocalHub(req.headers);
    const { id } = RunnerParams.parse(req.params);
    const ssh = (await readSshHosts())[id];
    const addedAt = ssh ? Date.parse(ssh.addedAt) : NaN;
    return {
      runnerId: id,
      ssh: ssh
        ? { target: ssh.target, port: ssh.port, addedAt: Number.isNaN(addedAt) ? 0 : addedAt, lastInstallVersion: ssh.lastInstallVersion }
        : null,
      pinnedRunnerFingerprint: await peekPin(id),
      laptopFingerprint: fingerprintOf((await loadSenderKey()).publicKey),
    };
  });
}
