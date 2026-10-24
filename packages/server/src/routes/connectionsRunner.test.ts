import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toResponse, AppError } from '../errors.js';
import { registerConnectionsRunnerRoutes } from './connectionsRunner.js';
import { writeRunnerAgentLogins, readRunnerAgentLogins, withRunnerStoreLock } from '../services/agentLogins/runnerStore.js';
import type { DeviceLogins } from '../services/connections/deviceLogin.js';

let tmp: string;
let prevHome: string | undefined;
let app: FastifyInstance;
let logs: string[];
let image: string | null;
let onSuccess: ((agent: 'codex' | 'opencode') => Promise<void>) | undefined;
const check = vi.fn();
const disconnect = vi.fn();
const logins: DeviceLogins = { start: vi.fn(), status: vi.fn(), cancel: vi.fn() };

async function build(): Promise<FastifyInstance> {
  const a = Fastify();
  a.setErrorHandler((err, _req, reply) => {
    reply.code(err instanceof AppError ? err.httpStatus : 500).send(toResponse(err));
  });
  await registerConnectionsRunnerRoutes(a, {
    sandbox: { ensureHomeVolume: async () => {}, userArgs: () => ['--userns=keep-id'] },
    sandboxRuntime: { bin: 'podman' },
    findImage: async () => image,
    check,
    disconnect,
    deviceLogins: (d) => {
      onSuccess = d.onSuccess;
      return logins;
    },
    log: (l) => logs.push(l),
  });
  return a;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'connections-runner-'));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
  logs = [];
  image = 'localhost/strado-sandbox:base-v4';
  vi.resetAllMocks();
  app = await build();
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

const post = (url: string) => app.inject({ method: 'POST', url });

describe('check', () => {
  it('runs the agent check against the found image', async () => {
    check.mockResolvedValue({ state: 'connected', detail: 'Logged in with ChatGPT' });
    const res = await post('/api/sandbox/connections/codex/check');
    expect(res.json()).toEqual({ state: 'connected', detail: 'Logged in with ChatGPT' });
    expect(check.mock.calls[0]![0]).toBe('codex');
    expect(check.mock.calls[0]![1]).toMatchObject({ image: 'localhost/strado-sandbox:base-v4', userArgs: ['--userns=keep-id'] });
  });

  it('the Claude token reaches the check only through readClaudeToken', async () => {
    await writeRunnerAgentLogins({ claudeToken: 'sk-ant-oat01-SECRET' });
    check.mockResolvedValue({ state: 'connected', detail: 'x' });
    await post('/api/sandbox/connections/claude/check');
    expect(await check.mock.calls[0]![1].readClaudeToken()).toBe('sk-ant-oat01-SECRET');
  });

  it('an unknown agent is a 400', async () => {
    expect((await post('/api/sandbox/connections/gemini/check')).statusCode).toBe(400);
  });

  it('no image: claude without a token is not-connected, others unknown', async () => {
    image = null;
    expect((await post('/api/sandbox/connections/claude/check')).json()).toEqual({ state: 'not-connected', detail: null });
    expect((await post('/api/sandbox/connections/pi/check')).json()).toEqual({
      state: 'unknown',
      detail: 'no sandbox image on this runner yet',
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('a throwing check is unknown, never its error text', async () => {
    check.mockRejectedValue(new Error('sk-SECRET leaked'));
    const res = await post('/api/sandbox/connections/codex/check');
    expect(res.json()).toEqual({ state: 'unknown', detail: 'could not run the check on this runner' });
    expect(res.body + logs.join()).not.toContain('SECRET');
  });
});

describe('device login', () => {
  it('starts for codex and opencode only', async () => {
    vi.mocked(logins.start).mockResolvedValue({ loginId: 'a'.repeat(32), url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHI', expiresAt: 1 });
    expect((await post('/api/sandbox/connections/codex/device')).json().code).toBe('ABCD-EFGHI');
    expect((await post('/api/sandbox/connections/pi/device')).statusCode).toBe(400);
    expect((await post('/api/sandbox/connections/claude/device')).statusCode).toBe(400);
  });

  it('a start failure is a fixed message', async () => {
    vi.mocked(logins.start).mockRejectedValue(new Error('codex said SECRET'));
    const res = await post('/api/sandbox/connections/codex/device');
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toBe('device login did not start');
    expect(res.body).not.toContain('SECRET');
  });

  it('no image is a conflict', async () => {
    image = null;
    expect((await post('/api/sandbox/connections/codex/device')).statusCode).toBe(409);
  });

  it('wait reports status; unknown or malformed ids are 404', async () => {
    vi.mocked(logins.start).mockResolvedValue({ loginId: 'a'.repeat(32), url: 'u', code: 'c', expiresAt: 1 });
    await post('/api/sandbox/connections/codex/device');
    vi.mocked(logins.status).mockImplementation((id) => (id === 'a'.repeat(32) ? { done: true, ok: true } : null));
    expect((await app.inject({ method: 'GET', url: `/api/sandbox/connections/device/${'a'.repeat(32)}` })).json()).toEqual({ done: true, ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/sandbox/connections/device/${'b'.repeat(32)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/sandbox/connections/device/../x' })).statusCode).toBe(404);
  });
});

describe('device login: cancel and managed', () => {
  const id = 'a'.repeat(32);
  beforeEach(async () => {
    vi.mocked(logins.start).mockResolvedValue({ loginId: id, url: 'u', code: 'c', expiresAt: 1 });
    await post('/api/sandbox/connections/codex/device');
  });

  it('DELETE cancels a running login: 204, then 404', async () => {
    vi.mocked(logins.cancel).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const url = `/api/sandbox/connections/device/${id}`;
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(204);
    expect(vi.mocked(logins.cancel).mock.calls[0]![0]).toBe(id);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/sandbox/connections/device/zz' })).statusCode).toBe(404);
  });

  it('a successful login is recorded as Strado-managed, keeping the rest of the store', async () => {
    await writeRunnerAgentLogins({ claudeToken: 't', managed: { opencode: ['openai'] }, disconnected: ['codex', 'pi'] });
    await onSuccess!('codex');
    await onSuccess!('opencode');
    // Logging in again also takes the agent off the disconnected list.
    expect(await readRunnerAgentLogins()).toEqual({
      claudeToken: 't',
      managed: { codex: true, opencode: ['openai'] },
      disconnected: ['pi'],
      changedAt: { codex: expect.any(Number), opencode: expect.any(Number) },
    });
  });

  it('each start runs on the image found for it', async () => {
    image = 'localhost/strado-sandbox:base-v5';
    await post('/api/sandbox/connections/opencode/device');
    const calls = vi.mocked(logins.start).mock.calls;
    expect(calls[0]![1]).toMatchObject({ image: 'localhost/strado-sandbox:base-v4' });
    expect(calls[1]![1]).toMatchObject({ image: 'localhost/strado-sandbox:base-v5' });
  });
});

describe('disconnect', () => {
  it('waits for the store lock that sync also takes', async () => {
    disconnect.mockResolvedValue(undefined);
    check.mockResolvedValue({ state: 'not-connected', detail: null });
    let release!: () => void;
    const held = withRunnerStoreLock(() => new Promise<void>((r) => (release = r)));
    const res = post('/api/sandbox/connections/codex/disconnect');
    await new Promise((r) => setTimeout(r, 20));
    expect(disconnect).not.toHaveBeenCalled();
    release();
    await held;
    expect((await res).statusCode).toBe(200);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects, then returns a fresh check', async () => {
    disconnect.mockResolvedValue(undefined);
    check.mockResolvedValue({ state: 'not-connected', detail: null });
    const res = await post('/api/sandbox/connections/codex/disconnect');
    expect(res.json()).toEqual({ state: 'not-connected', detail: null });
    expect(disconnect.mock.calls[0]![0]).toBe('codex');
    expect(disconnect.mock.calls[0]![1].oneShot).toMatchObject({ image: 'localhost/strado-sandbox:base-v4' });
  });

  it('claude with the real store: the token is gone and the check says not connected', async () => {
    const real = (await import('../services/connections/disconnect.js')).disconnectAgent;
    disconnect.mockImplementation(real);
    image = null;
    await writeRunnerAgentLogins({ claudeToken: 'sk-ant-oat01-SECRET', volume: { codex: { apiKey: 'k' } } });
    const res = await post('/api/sandbox/connections/claude/disconnect');
    expect(res.json()).toEqual({ state: 'not-connected', detail: null });
    expect(await readRunnerAgentLogins()).toEqual({
      volume: { codex: { apiKey: 'k' } },
      disconnected: ['claude'],
      changedAt: { claude: expect.any(Number) },
    });
  });

  it('a failure is a fixed message', async () => {
    disconnect.mockRejectedValue(new Error('rm said SECRET'));
    const res = await post('/api/sandbox/connections/pi/disconnect');
    expect(res.json().error.message).toBe('disconnect failed');
    expect(res.body + logs.join()).not.toContain('SECRET');
  });
});
