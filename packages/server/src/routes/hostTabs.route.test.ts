// The laptop side of a host's Sandboxes and Logs tabs over a fake runner: what
// is forwarded where, what is validated before anything leaves, what of the
// runner's answer is kept, and that no far-side text reaches a response.
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, toResponse } from '../errors.js';
import { createEventBus } from '../events/bus.js';
import { createJobQueue, type JobQueue } from '../services/jobs.js';
import type { RemoteJobEvent } from '../services/remoteJobs.js';
import type { RunnerFetch } from '../services/runnerFetch.js';
import type { LogPage, SandboxList } from '../services/hostTabs/types.js';
import { registerHostTabRoutes } from './hostTabs.js';

type Call = { id: string; path: string; method: string; body?: unknown };

const ROW = {
  slug: 'strado-sbx-app-feat', worktreePath: '/w/app/feat', repoName: 'app', worktreeName: 'feat',
  status: 'running', image: 'strado-sandbox:abc', createdAt: 1, startedAt: 2,
  cpuPercent: 1.5, memBytes: 100, memLimitBytes: 1000, staleLogins: ['claude'],
};
const PAGE: LogPage = { lines: [{ ts: 5, level: 'info', text: 'started' }], source: 'journal', nextSince: 5 };

let app: FastifyInstance & { deps: { jobs: JobQueue } };
let calls: Call[];
let answer: (path: string, method: string) => unknown;
let follow: ReturnType<typeof vi.fn>;
let localRepos: { repo: { path: string; cloneUrl: string | null }; cloneUrl: string | null }[];
let sandboxEnv: ReturnType<typeof vi.fn>;

async function build() {
  calls = [];
  const runner: RunnerFetch = {
    fetch: (async (id: string, path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({ id, path, method, ...(init?.body !== undefined ? { body: init.body } : {}) });
      return answer(path, method);
    }) as RunnerFetch['fetch'],
    credential: async () => ({ ticket: 'tkt', httpBase: 'https://relay.example/r1' }),
  };
  const a = Fastify() as unknown as typeof app;
  a.setErrorHandler((err, _req, reply) => {
    const mapped = err instanceof ZodError ? new AppError('VALIDATION', 'invalid request') : err;
    reply.code(mapped instanceof AppError ? mapped.httpStatus : 500).send(toResponse(mapped));
  });
  a.decorate('deps', { jobs: createJobQueue(createEventBus()) } as unknown as FastifyInstance['deps']);
  await registerHostTabRoutes(a, runner, {
    follow: follow as never,
    localRepos: async () => localRepos,
    sandboxEnv: sandboxEnv as never,
  });
  await a.ready();
  return a;
}

beforeEach(async () => {
  localRepos = [{ repo: { path: '/local/app', cloneUrl: 'git@github.com:acme/app.git' }, cloneUrl: 'git@github.com:acme/app.git' }];
  sandboxEnv = vi.fn(async () => ({ GH_TOKEN: 'ghp_SECRETTOKEN', GIT_AUTHOR_NAME: 'Me' })) as unknown as typeof sandboxEnv;
  answer = (path) => {
    if (path === '/api/sandbox/containers') return { sandboxes: [ROW], runtime: 'podman' };
    if (path === '/api/workspaces') return { activeWorkspaceId: 'ws1', workspaces: [{ id: 'ws1' }] };
    if (path === '/api/w/ws1/worktrees') return { worktrees: [{ path: '/w/app/feat', repoId: 'rp1' }] };
    if (path === '/api/w/ws1/repos') return { repos: [{ id: 'rp1', path: '/w/app', cloneUrl: 'https://github.com/acme/app.git' }] };
    if (path.startsWith('/api/sandbox/runner-logs')) return PAGE;
    if (path.endsWith('/rebuild')) return { jobId: 'remote-job-1' };
    return { ok: true };
  };
  follow = vi.fn(async (_url: string, on: (e: RemoteJobEvent) => void) => {
    on({ type: 'progress', message: 'building /secret/path with TOKEN=abc', step: 'sandbox-build' });
  }) as unknown as typeof follow;
  app = await build();
});

afterEach(async () => {
  await app.close();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const post = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers });

describe('GET sandboxes', () => {
  it("forwards to the runner's containers path and returns the list", async () => {
    const res = await get('/api/runners/r1/sandboxes');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sandboxes: [ROW], runtime: 'podman' });
    expect(calls).toEqual([{ id: 'r1', path: '/api/sandbox/containers', method: 'GET' }]);
  });

  it('keeps only the contract fields: anything else the runner adds (env, labels) is dropped', async () => {
    answer = () => ({ sandboxes: [{ ...ROW, env: ['ANTHROPIC_API_KEY=sk-ant-x'], labels: { a: 'b' } }], runtime: 'podman', extra: 1 });
    const body = (await get('/api/runners/r1/sandboxes')).json() as SandboxList;
    expect(Object.keys(body.sandboxes[0]!).sort()).toEqual(Object.keys(ROW).sort());
    expect(JSON.stringify(body)).not.toContain('sk-ant');
  });

  it('a malformed answer is a fixed failure', async () => {
    answer = () => ({ sandboxes: [{ slug: 1 }] });
    const res = await get('/api/runners/r1/sandboxes');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toBe('the runner sent an unusable answer');
  });

  it('offline or failing runner → fixed message, never the far side text', async () => {
    answer = () => { throw new AppError('CLOUD_UNREACHABLE', 'r1 returned 500: podman: secret stderr'); };
    const res = await get('/api/runners/r1/sandboxes');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toBe('runner is offline or unreachable');
    expect(res.body).not.toContain('secret stderr');
  });

  it('a runner without these routes (404) → update hint', async () => {
    answer = () => { throw new AppError('NOT_FOUND', 'r1: Route GET:/api/sandbox/containers not found'); };
    const res = await get('/api/runners/r1/sandboxes');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('update this runner to use this tab');
  });

  it('a foreign Host or Origin → 403', async () => {
    expect((await get('/api/runners/r1/sandboxes', { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('GET logs', () => {
  it('validated query params go through as a query string', async () => {
    const res = await get('/api/runners/r1/logs?lines=50&grep=error%20x&since=123');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(PAGE);
    const u = new URL(`http://x${calls[0]!.path}`);
    expect(u.pathname).toBe('/api/sandbox/runner-logs');
    expect(Object.fromEntries(u.searchParams)).toEqual({ lines: '50', grep: 'error x', since: '123' });
  });

  it('no params → none forwarded', async () => {
    await get('/api/runners/r1/logs');
    expect(calls[0]!.path).toBe('/api/sandbox/runner-logs');
  });

  it.each([
    'lines=0', 'lines=1001', 'lines=abc', 'lines=1.5', `grep=${'a'.repeat(201)}`, 'since=-1', 'since=x', 'other=1',
  ])('refuses %s before reaching the runner', async (q) => {
    expect((await get(`/api/runners/r1/logs?${q}`)).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('a log page of the wrong shape is a fixed failure', async () => {
    answer = () => ({ lines: [{ ts: 'x' }], source: 'journal', nextSince: null });
    expect((await get('/api/runners/r1/logs')).json().error.message).toBe('the runner sent an unusable answer');
  });
});

describe('POST action', () => {
  it.each(['restart', 'stop', 'start', 'remove'])('%s forwards and returns ok', async (action) => {
    const res = await post(`/api/runners/r1/sandboxes/strado-sbx-app-feat/${action}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ id: 'r1', path: `/api/sandbox/containers/strado-sbx-app-feat/${action}`, method: 'POST' }]);
  });

  it.each([
    ['strado-sbx-app-feat', 'destroy'],
    ['..', 'stop'],
    ['-rf', 'stop'],
    ['a%2Fb', 'stop'],
    ['a b', 'stop'],
    ['x'.repeat(200), 'stop'],
  ])('refuses slug %j / action %j before reaching the runner', async (slug, action) => {
    const res = await post(`/api/runners/r1/sandboxes/${encodeURIComponent(slug)}/${action}`);
    expect([400, 404]).toContain(res.statusCode);
    expect(calls).toEqual([]);
  });

  it('a foreign Origin → 403; the relay (loopback) is allowed, like remote worktree delete', async () => {
    expect((await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/stop', { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect((await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/stop', { 'x-strado-via': 'relay' })).statusCode).toBe(200);
  });

  it("the runner's own refusal maps to a fixed message", async () => {
    answer = () => { throw new AppError('NOT_FOUND', 'r1: no such container strado-sbx-app-feat (podman said …)'); };
    const res = await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/stop');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('no such sandbox on this runner');
    answer = () => { throw new AppError('VALIDATION', 'r1: not ours: label missing'); };
    expect((await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/stop')).json().error.message).toBe('the runner refused that');
  });

  it('rebuild: a local job that follows the runner job; progress is fixed text only', async () => {
    const res = await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/rebuild');
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json() as { jobId: string };
    expect(jobId).not.toBe('remote-job-1');
    const job = await app.deps.jobs.wait<{ slug: string }>(jobId);
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ runnerId: 'r1', slug: 'strado-sbx-app-feat' });
    expect(follow).toHaveBeenCalledWith('https://relay.example/r1/events/jobs/remote-job-1?ticket=tkt', expect.any(Function));
    expect(JSON.stringify(job.progress)).not.toMatch(/secret|TOKEN/);
    expect(job.kind).toBe('host-sandbox.rebuild');
  });

  it("rebuild failing on the runner → the job fails with a fixed message, not the runner's", async () => {
    follow.mockImplementation(async () => { throw new AppError('SHELL_FAILED', 'podman build: secret stderr'); });
    const { jobId } = (await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/rebuild')).json() as { jobId: string };
    const job = await app.deps.jobs.wait(jobId);
    expect(job.status).toBe('error');
    expect((job.error as Error).message).toBe('rebuild failed on the runner');
  });

  it('rebuild: a runner answer without a job id is a fixed failure, no job started', async () => {
    answer = () => ({ ok: true });
    const res = await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/rebuild');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toBe('the runner sent an unusable answer');
  });
});

describe('rebuild carries the laptop sandboxEnv when the worktree maps to a local repo', () => {
  it('mapped: the same env as rebuild-sandbox, in the action body; never in a frame or result', async () => {
    const { jobId } = (await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/rebuild')).json() as { jobId: string };
    const rebuild = calls.find((c) => c.path.endsWith('/rebuild'))!;
    expect(rebuild.body).toEqual({ sandboxEnv: { GH_TOKEN: 'ghp_SECRETTOKEN', GIT_AUTHOR_NAME: 'Me' } });
    expect(sandboxEnv).toHaveBeenCalledWith({ path: '/local/app', cloneUrl: 'git@github.com:acme/app.git' });
    const job = await app.deps.jobs.wait(jobId);
    expect(JSON.stringify([job.progress, job.result])).not.toContain('SECRET');
  });

  it('unmapped (no local repo matches): the runner-only rebuild, no body, env never read', async () => {
    localRepos = [{ repo: { path: '/local/other', cloneUrl: 'git@github.com:acme/other.git' }, cloneUrl: 'git@github.com:acme/other.git' }];
    await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/rebuild');
    expect(calls.find((c) => c.path.endsWith('/rebuild'))!.body).toBeUndefined();
    expect(sandboxEnv).not.toHaveBeenCalled();
  });

  it('a container with no worktree label, or a lookup that fails, also falls back', async () => {
    const base = answer;
    answer = (path, method) => (path === '/api/sandbox/containers' ? { sandboxes: [{ ...ROW, worktreePath: null }], runtime: 'podman' } : base(path, method));
    await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/rebuild');
    expect(calls.find((c) => c.path.endsWith('/rebuild'))!.body).toBeUndefined();
    calls.length = 0;
    answer = (path, method) => { if (path === '/api/workspaces') throw new Error('boom'); return base(path, method); };
    expect((await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/rebuild')).statusCode).toBe(200);
    expect(calls.find((c) => c.path.endsWith('/rebuild'))!.body).toBeUndefined();
  });

  it('other actions never look anything up or send env', async () => {
    await post('/api/runners/r1/sandboxes/strado-sbx-app-feat/restart');
    expect(calls).toEqual([{ id: 'r1', path: '/api/sandbox/containers/strado-sbx-app-feat/restart', method: 'POST' }]);
    expect(sandboxEnv).not.toHaveBeenCalled();
  });
});
