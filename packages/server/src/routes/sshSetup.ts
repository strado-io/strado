import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { createCloudApi } from '../services/cloudApi.js';
import { refusal, warnings } from '../services/sshSetup/checks.js';
import { recordSshHost } from '../services/sshSetup/hosts.js';
import { createSetupRun, runSshSetup, type SetupDeps, type SetupRun } from '../services/sshSetup/job.js';
import { podmanInstallCommand, podmanNeeded } from '../services/sshSetup/podman.js';
import { parseProbe, PROBE_SCRIPT } from '../services/sshSetup/probe.js';
import { openSession, parseDestination } from '../services/sshSetup/session.js';
import { SSH_SETUP_KEY_PREFIX, SSH_SETUP_ROUTES } from '../services/sshSetup/types.js';
import { assertLocalHub } from './profile.js';

// "Add over SSH". The renderer sends a destination, a name, and yes/no
// answers; the job builds every argv. Local hub only: a relayed window must not
// be able to make this machine ssh anywhere.

const StartBody = z.object({
  destination: z.string().min(1).max(300),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).refine((n) => !n.startsWith('-')).optional(),
}).strict();
const AnswerBody = z.object({ questionId: z.string().min(1).max(64), yes: z.boolean() }).strict();
const JobParams = z.object({ jobId: z.string().min(1).max(64) });

type RunnerRow = { runnerId: string; online: boolean };

export async function registerSshSetupRoutes(app: FastifyInstance): Promise<void> {
  const apiUrl = (process.env.STRADO_LICENSE_API ?? 'https://api.strado.io').replace(/\/$/, '');
  const { token, cloud } = createCloudApi();
  const runners = async () =>
    (await cloud<{ runners: RunnerRow[] }>(`/v1/runners?token=${encodeURIComponent(await token())}`)).runners;

  const deps: SetupDeps = {
    openSession: (dest) => openSession(dest),
    terminal: app.deps.terminal,
    home: os.homedir(),
    apiUrl,
    cloud: {
      listRunnerIds: async () => (await runners()).map((r) => r.runnerId),
      mintPairCode: async () =>
        (await cloud<{ code: string }>('/v1/runners/pair-code', { method: 'POST', body: { token: await token() } })).code,
      isOnline: async (id) => (await runners()).some((r) => r.runnerId === id && r.online),
    },
    feedVersion: async () => {
      try {
        const res = await fetch(`${apiUrl}/v1/release`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        const v = ((await res.json()) as { runner?: { version?: unknown } }).runner?.version;
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    },
    probeScript: PROBE_SCRIPT,
    parseProbe,
    refusal,
    warnings,
    podmanNeeded,
    podmanInstallCommand,
    recordHost: recordSshHost,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollTimeoutMs: 120_000,
    pollIntervalMs: 3_000,
  };

  const live = new Map<string, SetupRun>();
  /** Ended runs' transcripts: the failure reason is what a reopened dialog
   *  most needs. A few, briefly. */
  const ended = new Map<string, { lines: string[]; at: number }>();
  const KEEP_MS = 15 * 60_000;
  const KEEP_MAX = 20;
  const keep = (jobId: string, lines: string[]) => {
    const now = Date.now();
    for (const [id, e] of ended) if (now - e.at > KEEP_MS) ended.delete(id);
    ended.set(jobId, { lines, at: now });
    while (ended.size > KEEP_MAX) ended.delete(ended.keys().next().value!);
  };

  app.post(SSH_SETUP_ROUTES.start, async (req) => {
    assertLocalHub(req.headers);
    const body = StartBody.safeParse(req.body);
    if (!body.success) throw new AppError('VALIDATION', 'enter user@host, ssh://user@host:port, or an ssh config alias');
    let dest;
    try {
      dest = parseDestination(body.data.destination);
    } catch {
      throw new AppError('VALIDATION', 'not an ssh destination');
    }
    const run = createSetupRun();
    // The job body runs a tick after start() returns, so the id is set by then.
    let jobId = '';
    const job = app.deps.jobs.start('ssh-setup', (ctx) =>
      runSshSetup(ctx, { jobId, dest, name: body.data.name ?? null }, deps, run));
    jobId = job.id;
    live.set(job.id, run);
    void app.deps.jobs.wait(job.id).then(() => {
      live.delete(job.id);
      keep(job.id, run.transcript);
    });
    return { jobId: job.id };
  });

  app.post(SSH_SETUP_ROUTES.answer, async (req, reply) => {
    assertLocalHub(req.headers);
    const { jobId } = JobParams.parse(req.params);
    const { questionId, yes } = AnswerBody.parse(req.body);
    if (!live.get(jobId)?.answer(questionId, yes)) throw new AppError('NOT_FOUND', 'no such question');
    return reply.code(204).send();
  });

  app.post(SSH_SETUP_ROUTES.cancel, async (req, reply) => {
    assertLocalHub(req.headers);
    const { jobId } = JobParams.parse(req.params);
    const run = live.get(jobId);
    if (!run) throw new AppError('NOT_FOUND', 'no such setup run');
    live.delete(jobId);
    keep(jobId, run.transcript);
    run.cancel();
    // Now, not when the job settles: until then it still reads as running, and
    // the setup terminal ws would let a late attach reach a live pty.
    app.deps.terminal.kill(`${SSH_SETUP_KEY_PREFIX}${jobId}`);
    return reply.code(204).send();
  });

  app.get(SSH_SETUP_ROUTES.transcript, async (req) => {
    assertLocalHub(req.headers);
    const { jobId } = JobParams.parse(req.params);
    const lines = live.get(jobId)?.transcript ?? ended.get(jobId)?.lines;
    if (!lines) throw new AppError('NOT_FOUND', 'no such setup run');
    return { lines: [...lines] };
  });
}
