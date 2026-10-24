// The Connections routes over a fake runner: the connect job end to end (pin
// question, device code, cancel), check/disconnect, the cached list, the host
// record, and the local-hub guard on every route.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, toResponse } from '../errors.js';
import { createEventBus } from '../events/bus.js';
import { createJobQueue, type JobQueue } from '../services/jobs.js';
import { checkPin } from '../services/agentLogins/pins.js';
import { fingerprintOf } from '../services/agentLogins/seal.js';
import { loadSenderKey } from '../services/agentLogins/senderKey.js';
import { recordSshHost } from '../services/sshSetup/hosts.js';
import type { ConnectDeps } from '../services/connections/connect.js';
import type { ConnectProgress } from '../services/connections/types.js';
import { VIA_RELAY_HEADER } from './appControl.js';
import { registerConnectionRoutes } from './connections.js';

let tmp: string;
let prevHome: string | undefined;
let app: FastifyInstance & { deps: { jobs: JobQueue } };
let deps: ConnectDeps;
let runnerCalls: string[];

const agents = { claude: 'written', codex: 'skipped', opencode: 'skipped' } as const;

function fakeDeps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  runnerCalls = [];
  const fetch = (async (_id: string, p: string, init?: { method?: string }) => {
    runnerCalls.push(`${init?.method ?? 'GET'} ${p}`);
    if (p.endsWith('/check')) return { state: 'connected', detail: 'Logged in' };
    if (p.endsWith('/disconnect')) return { state: 'not-connected', detail: null };
    if (p.endsWith('/device')) return { loginId: 'L1', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', expiresAt: Date.now() + 60_000 };
    if (p.includes('/device/')) return { done: false };
    throw new Error('unexpected');
  }) as ConnectDeps['fetch'];
  return {
    fetch,
    isOnline: async () => true,
    hasClaudeToken: async () => true,
    captureSetupToken: vi.fn(async () => {}),
    sync: async () => ({ fingerprint: 'fp', agents, pin: 'match' }),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    devicePollMs: 5,
    ...over,
  };
}

async function build(d: ConnectDeps) {
  const a = Fastify() as unknown as typeof app;
  a.setErrorHandler((err, _req, reply) => {
    const mapped = err instanceof ZodError ? new AppError('VALIDATION', 'invalid request body') : err;
    reply.code(mapped instanceof AppError ? mapped.httpStatus : 500).send(toResponse(mapped));
  });
  a.decorate('deps', { jobs: createJobQueue(createEventBus()) } as unknown as FastifyInstance['deps']);
  await registerConnectionRoutes(a, { fetch: d.fetch, credential: async () => ({ ticket: '', httpBase: '' }) }, d);
  await a.ready();
  return a;
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'connections-route-')));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
  deps = fakeDeps();
  app = await build(deps);
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

const post = (url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload, headers });

async function frameWith<K extends string>(jobId: string, key: K) {
  await vi.waitFor(() => expect((app.deps.jobs.get(jobId)?.progress?.data as Record<string, unknown>)?.[key]).toBeTruthy());
  return app.deps.jobs.get(jobId)!.progress!.data as Extract<ConnectProgress, Record<K, unknown>>;
}

describe('guards', () => {
  it.each([
    ['GET', '/api/runners/r1/connections'],
    ['POST', '/api/runners/r1/connections/claude/connect'],
    ['POST', '/api/runners/r1/connections/codex/check'],
    ['POST', '/api/runners/r1/connections/codex/disconnect'],
    ['POST', '/api/connections/jobs/j1/answer'],
    ['POST', '/api/connections/jobs/j1/cancel'],
    ['GET', '/api/runners/r1/host'],
  ])('%s %s: relayed → 403, foreign origin → 403', async (method, url) => {
    const payload = url.endsWith('/answer') ? { questionId: 'q1', yes: true } : undefined;
    expect((await app.inject({ method: method as 'GET', url, payload, headers: { [VIA_RELAY_HEADER]: '1' } })).statusCode).toBe(403);
    expect((await app.inject({ method: method as 'GET', url, payload, headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect(runnerCalls).toEqual([]);
  });

  it('an unknown agent → 400', async () => {
    expect((await post('/api/runners/r1/connections/gemini/connect')).statusCode).toBe(400);
  });
});

describe('list', () => {
  it('every agent unknown at first; a check fills its row', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/runners/r1/connections' })).json();
    expect(before.stale).toBe(false);
    expect(before.connections.map((c: { state: string }) => c.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    const res = await post('/api/runners/r1/connections/codex/check');
    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({ agent: 'codex', state: 'connected', detail: 'Logged in' });
    const after = (await app.inject({ method: 'GET', url: '/api/runners/r1/connections' })).json();
    expect(after.connections[1]).toMatchObject({ agent: 'codex', state: 'connected' });
  });

  it('offline: the cached states come back marked stale; actions refuse with a fixed 409', async () => {
    await post('/api/runners/r1/connections/codex/check');
    await app.close();
    app = await build({ ...deps, isOnline: async () => false });
    const list = (await app.inject({ method: 'GET', url: '/api/runners/r1/connections' })).json();
    expect(list.stale).toBe(true);
    for (const a of ['check', 'disconnect']) {
      const r = await post(`/api/runners/r1/connections/codex/${a}`);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.message).toBe('runner is offline');
    }
  });
});

describe('connect', () => {
  it('claude: the job runs to a connected row', async () => {
    const { jobId } = (await post('/api/runners/r1/connections/claude/connect')).json();
    const job = await app.deps.jobs.wait<{ connection: { state: string } }>(jobId);
    expect(job.status).toBe('done');
    expect(job.result!.connection.state).toBe('connected');
  });

  it('first pin: the answer route reaches the question; no → the job fails untrusted', async () => {
    await app.close();
    app = await build({
      ...deps,
      sync: async (_id, confirm) => {
        if (!(await confirm('RUN', 'LAP', null))) throw new AppError('FORBIDDEN', 'runner not trusted yet');
        return { fingerprint: 'fp', agents, pin: 'new' };
      },
    });
    const { jobId } = (await post('/api/runners/r1/connections/pi/connect')).json();
    const { question } = await frameWith(jobId, 'question');
    expect(question).toMatchObject({ kind: 'pin', runnerFingerprint: 'RUN', laptopFingerprint: 'LAP' });
    expect((await post(`/api/connections/jobs/${jobId}/answer`, { questionId: 'nope', yes: true })).statusCode).toBe(404);
    expect((await post(`/api/connections/jobs/${jobId}/answer`, { questionId: question.id, yes: false })).statusCode).toBe(204);
    const job = await app.deps.jobs.wait(jobId);
    expect(job.status).toBe('error');
    expect((job.error as Error).message).toBe('runner not trusted yet');
  });

  it('codex: the device code reaches a frame; cancel ends the job; a second connect is allowed after', async () => {
    const { jobId } = (await post('/api/runners/r1/connections/codex/connect')).json();
    const { device } = await frameWith(jobId, 'device');
    expect(device).toMatchObject({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' });
    expect((await post('/api/runners/r1/connections/codex/connect')).statusCode).toBe(409);
    expect((await post(`/api/connections/jobs/${jobId}/cancel`)).statusCode).toBe(204);
    const job = await app.deps.jobs.wait(jobId);
    expect((job.error as Error).message).toBe('connect cancelled');
    expect((await post(`/api/connections/jobs/${jobId}/cancel`)).statusCode).toBe(404);
    await vi.waitFor(async () => expect((await post('/api/runners/r1/connections/codex/connect')).statusCode).toBe(200));
  });

  it('no frame of a claude connect carries a token', async () => {
    const TOKEN = `sk-ant-oat01-${'z'.repeat(50)}`;
    await app.close();
    const frames: unknown[] = [];
    app = await build({ ...deps, hasClaudeToken: async () => false, captureSetupToken: async ({ onPhase }) => { onPhase('saving'); void TOKEN; } });
    const { jobId } = (await post('/api/runners/r1/connections/claude/connect')).json();
    const job = await app.deps.jobs.wait(jobId);
    frames.push(job.progress, job.result);
    expect(JSON.stringify(frames)).not.toContain('sk-ant');
  });
});

describe('disconnect', () => {
  it('posts to the runner and returns the fresh state', async () => {
    const res = await post('/api/runners/r1/connections/claude/disconnect');
    expect(res.json().connection).toMatchObject({ agent: 'claude', state: 'not-connected' });
    expect(runnerCalls).toEqual(['POST /api/sandbox/connections/claude/disconnect']);
  });
});

describe('host', () => {
  it('no ssh record and no pin yet: nulls, plus this laptop fingerprint', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/runners/r1/host' })).json();
    expect(res).toEqual({
      runnerId: 'r1', ssh: null, pinnedRunnerFingerprint: null,
      laptopFingerprint: fingerprintOf((await loadSenderKey()).publicKey),
    });
  });

  it('the ssh record and the pin when present', async () => {
    await recordSshHost('r1', { target: 'u@h', port: 2222, addedAt: '2026-10-24T00:00:00.000Z', lastInstallVersion: '0.1.40' });
    await checkPin('r1', 'aaaa-bbbb');
    const res = (await app.inject({ method: 'GET', url: '/api/runners/r1/host' })).json();
    expect(res.ssh).toEqual({ target: 'u@h', port: 2222, addedAt: Date.parse('2026-10-24T00:00:00.000Z'), lastInstallVersion: '0.1.40' });
    expect(res.pinnedRunnerFingerprint).toBe('aaaa-bbbb');
  });
});
