import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { toResponse, AppError } from '../errors.js';
import { registerHostTabsRunnerRoutes, type HostTabsRunnerDeps } from './hostTabsRunner.js';
import { sandboxSlugFor } from '../services/sandbox/sandboxes.js';

const WT = '/home/strado/.strado/worktrees/hello-world/e2e';
const SLUG = sandboxSlugFor('e2e', WT);

let app: FastifyInstance;
let logs: string[];

let sandbox: Record<'start' | 'stop' | 'remove' | 'worktreeOf', Mock<any[], any>>;
let deps: HostTabsRunnerDeps;

async function build(d: HostTabsRunnerDeps): Promise<FastifyInstance> {
  const a = Fastify();
  a.setErrorHandler((err, _req, reply) => {
    reply.code(err instanceof AppError ? err.httpStatus : 500).send(toResponse(err));
  });
  await registerHostTabsRunnerRoutes(a, d);
  return a;
}

beforeEach(async () => {
  logs = [];
  sandbox = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ ok: true, error: null })),
    remove: vi.fn(async () => ({ ok: true, error: null })),
    worktreeOf: vi.fn(async (slug: string) => (slug === SLUG ? WT : slug === 'stranger' ? null : '/elsewhere/x')),
  };
  deps = {
    sandbox,
    sandboxRuntime: { bin: 'podman' },
    findWorktree: vi.fn(async (p: string) => (p === WT ? { wsId: 'default', repoName: 'hello-world', worktreeName: 'E2E' } : null)),
    rebuild: vi.fn(async () => 'job-1'),
    list: vi.fn(async () => []),
    readLogs: vi.fn(async () => ({ lines: [], source: 'journal' as const, nextSince: null })),
    log: (l) => logs.push(l),
  };
  app = await build(deps);
});

afterEach(async () => {
  await app.close();
});

const act = (slug: string, action: string, payload?: unknown) =>
  app.inject({ method: 'POST', url: `/api/sandbox/containers/${slug}/${action}`, payload: payload as never });

describe('containers', () => {
  it('lists with display names from the runner state', async () => {
    vi.mocked(deps.list).mockImplementation(async (describe) => {
      expect(await describe(WT)).toEqual({ repoName: 'hello-world', worktreeName: 'E2E' });
      expect(await describe('/nope')).toBeNull();
      return [];
    });
    const res = await app.inject({ method: 'GET', url: '/api/sandbox/containers' });
    expect(res.json()).toEqual({ sandboxes: [], runtime: 'podman' });
  });

  it('no runtime: the container routes are not there, logs still are', async () => {
    const a = await build({ ...deps, sandbox: null, sandboxRuntime: null });
    expect((await a.inject({ method: 'GET', url: '/api/sandbox/containers' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: `/api/sandbox/containers/${SLUG}/stop` })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/sandbox/runner-logs' })).statusCode).toBe(200);
    await a.close();
  });
});

describe('actions', () => {
  it('stop, start and restart go through the sandbox service', async () => {
    expect((await act(SLUG, 'stop')).json()).toEqual({ ok: true });
    expect(sandbox.stop).toHaveBeenCalledWith(SLUG);
    expect((await act(SLUG, 'start')).json()).toEqual({ ok: true });
    expect(sandbox.start).toHaveBeenCalledWith(SLUG);
    expect((await act(SLUG, 'restart')).json()).toEqual({ ok: true });
    expect(sandbox.stop).toHaveBeenCalledTimes(2);
    expect(sandbox.start).toHaveBeenCalledTimes(2);
  });

  it('remove takes out a container of a known worktree', async () => {
    expect((await act(SLUG, 'remove')).json()).toEqual({ ok: true });
    expect(sandbox.remove).toHaveBeenCalledWith(SLUG);
  });

  it('an unlabeled container is never actionable', async () => {
    for (const a of ['stop', 'start', 'restart', 'remove', 'rebuild']) {
      const res = await act('stranger', a);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('not a Strado sandbox');
    }
    expect(sandbox.stop).not.toHaveBeenCalled();
    expect(sandbox.remove).not.toHaveBeenCalled();
  });

  it('every action refuses a label that is not a known worktree, or whose slug is not its own', async () => {
    for (const a of ['stop', 'start', 'restart', 'remove', 'rebuild']) {
      const res = await act('other-1234abcd', a);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('not a known worktree');
    }
    // Known worktree, but this container's name is not the one derived from it.
    vi.mocked(sandbox.worktreeOf).mockResolvedValueOnce(WT);
    const res = await act('e2e-00000000', 'remove');
    expect(res.json().error.message).toBe('not a known worktree');
    expect(sandbox.remove).not.toHaveBeenCalled();
    expect(sandbox.stop).not.toHaveBeenCalled();
    expect(sandbox.start).not.toHaveBeenCalled();
  });

  it('rebuild reuses the worktree rebuild path and returns its job', async () => {
    const res = await act(SLUG, 'rebuild', { sandboxEnv: { GIT_AUTHOR_NAME: 'me' } });
    expect(res.json()).toEqual({ jobId: 'job-1' });
    expect(deps.rebuild).toHaveBeenCalledWith('default', WT, { GIT_AUTHOR_NAME: 'me' });
  });

  it('failures are fixed strings, never runtime stderr', async () => {
    sandbox.stop.mockResolvedValueOnce({ ok: false, error: 'Error: SECRET stderr' });
    let res = await act(SLUG, 'stop');
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toBe('sandbox stop failed');
    sandbox.start.mockRejectedValueOnce(new Error('sandbox start failed: SECRET'));
    res = await act(SLUG, 'start');
    expect(res.json().error.message).toBe('sandbox start failed');
    vi.mocked(deps.rebuild).mockRejectedValueOnce(new AppError('VALIDATION', 'SECRET path detail'));
    res = await act(SLUG, 'rebuild');
    expect(res.json().error.message).toBe('sandbox rebuild failed');
    expect(res.body + logs.join()).not.toContain('SECRET');
  });

  it('bad slugs and actions are 400', async () => {
    expect((await act('-bad', 'stop')).statusCode).toBe(400);
    expect((await act(SLUG, 'exec')).statusCode).toBe(400);
    expect((await act(SLUG, 'rebuild', { sandboxEnv: { A: 1 } })).statusCode).toBe(400);
    // The worktree create/rebuild schema: env-var keys, at most 20, no extra fields.
    expect((await act(SLUG, 'rebuild', { sandboxEnv: { 'bad key': 'v' } })).statusCode).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`K${i}`, 'v']));
    expect((await act(SLUG, 'rebuild', { sandboxEnv: many })).statusCode).toBe(400);
    expect((await act(SLUG, 'rebuild', { sandboxEnv: {}, extra: 1 })).statusCode).toBe(400);
    expect(deps.rebuild).not.toHaveBeenCalled();
  });
});

describe('runner logs', () => {
  it('passes a validated query through', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sandbox/runner-logs?lines=50&grep=tunnel&since=1792835168371.098' });
    expect(res.statusCode).toBe(200);
    expect(deps.readLogs).toHaveBeenCalledWith({ lines: 50, grep: 'tunnel', since: 1792835168371.098 });
  });

  it('a bad query is 400; an over-long grep is refused', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sandbox/runner-logs?lines=abc' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/sandbox/runner-logs?grep=${'x'.repeat(300)}` })).statusCode).toBe(400);
  });

  it('a read that throws is a fixed message', async () => {
    vi.mocked(deps.readLogs).mockRejectedValueOnce(new Error('SECRET'));
    const res = await app.inject({ method: 'GET', url: '/api/sandbox/runner-logs' });
    expect(res.json().error.message).toBe('could not read the runner log');
  });
});

describe('runnerHostTabsDeps', () => {
  async function wired() {
    const { runnerHostTabsDeps } = await import('./hostTabsRunner.js');
    const a = Fastify();
    const meta = { repoId: 'r1', title: 'E2E ssh' };
    a.decorate('deps', {
      sandbox: null,
      sandboxRuntime: null,
      workspaces: { list: async () => [{ id: 'other' }, { id: 'default' }] },
      registry: {
        get: async (id: string) => ({
          state: { get: async (p: string) => (id === 'default' && p === WT ? meta : null) },
          repos: { list: async () => [{ id: 'r1', name: 'hello-world' }] },
        }),
      },
      debugLog: { log: () => {} },
    } as never);
    const seen: { ws: string; path: string; body: unknown }[] = [];
    a.post<{ Params: { ws: string; p: string } }>('/api/w/:ws/worktrees/:p/sandbox', async (req, reply) => {
      seen.push({ ws: req.params.ws, path: decodeURIComponent(req.params.p), body: req.body });
      if (req.params.ws === 'ok200') return reply.code(200).send({ jobId: 'job-200' });
      if (req.params.ws === 'nojob') return reply.code(202).send({});
      return req.params.ws === 'default' ? reply.code(202).send({ jobId: 'job-9' }) : reply.code(404).send({});
    });
    await a.ready();
    return { a, d: runnerHostTabsDeps(a), seen };
  }

  it('finds the owning workspace and display names', async () => {
    const { a, d } = await wired();
    expect(await d.findWorktree(WT)).toEqual({ wsId: 'default', repoName: 'hello-world', worktreeName: 'E2E ssh' });
    expect(await d.findWorktree('/nope')).toBeNull();
    await a.close();
  });

  it('rebuild posts to the existing worktree sandbox route and returns its job', async () => {
    const { a, d, seen } = await wired();
    expect(await d.rebuild('default', WT, { GIT_AUTHOR_NAME: 'me' })).toBe('job-9');
    expect(seen[0]).toEqual({ ws: 'default', path: WT, body: { sandboxEnv: { GIT_AUTHOR_NAME: 'me' } } });
    await expect(d.rebuild('other', WT, {})).rejects.toThrow('rebuild refused');
    expect(await d.rebuild('ok200', WT, {})).toBe('job-200');
    await expect(d.rebuild('nojob', WT, {})).rejects.toThrow('rebuild refused');
    await a.close();
  });
});
