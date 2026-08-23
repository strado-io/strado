import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRunnerRoutes } from '../src/routes/runners.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, toResponse } from '../src/errors.js';

// The routes' whole job is to keep the account token server-side, so the tests
// assert on what reaches the cloud rather than on the responses alone.
let app: FastifyInstance;
let home: string;
let calls: { url: string; body: unknown }[] = [];
const TOKEN = 'a'.repeat(64);

function mockCloud(handler: (url: string, body: unknown) => { status: number; json: unknown }) {
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const { status, json } = handler(url, body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  });
}

beforeEach(async () => {
  calls = [];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-runner-routes-'));
  process.env.STRADO_HOME = home;
  process.env.STRADO_LICENSE_API = 'https://api.test';
  app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof AppError ? err.httpStatus : 500;
    reply.code(status).send(toResponse(err));
  });
  await registerRunnerRoutes(app);
});

afterEach(async () => {
  await app.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.STRADO_HOME;
  delete process.env.STRADO_LICENSE_API;
  vi.unstubAllGlobals();
});

function writeLicense(): void {
  fs.writeFileSync(
    path.join(home, 'license.json'),
    JSON.stringify({ code: 'STRADO-TEST-CODE', token: TOKEN, name: 'Tester', deviceId: 'device-1' }),
  );
}

describe('runner routes', () => {
  it('refuses every call with a clear message when the machine has no account', async () => {
    mockCloud(() => ({ status: 200, json: {} }));
    for (const [method, url] of [
      ['GET', '/api/runners'],
      ['POST', '/api/runners/pair-code'],
      ['POST', '/api/runners/box/attach'],
      ['POST', '/api/runners/box/revoke'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/sign in first/i);
    }
    // Nothing should have been sent upstream without a token.
    expect(calls).toHaveLength(0);
  });

  it('lists runners using the stored token', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: { runners: [{ runnerId: 'box-1', name: 'box', online: true }] } }));
    const res = await app.inject({ method: 'GET', url: '/api/runners' });
    expect(res.statusCode).toBe(200);
    expect(res.json().runners[0].runnerId).toBe('box-1');
    expect(calls[0]!.url).toBe(`https://api.test/v1/runners?token=${TOKEN}`);
  });

  it('returns the exact commands to run on the new box', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: { code: 'PAIR-AAAA-BBBB', expiresAt: '2026-01-01T00:00:00.000Z' } }));
    const res = await app.inject({ method: 'POST', url: '/api/runners/pair-code' });
    const body = res.json();
    // The panel must not hardcode the installer URL — it would drift from the
    // API the app is actually pointed at.
    expect(body.installCommand).toBe('curl -fsSL https://api.test/install-runner.sh | sh');
    expect(body.pairCommand).toBe('strado-runner pair --code PAIR-AAAA-BBBB');
    expect(calls[0]!.body).toEqual({ token: TOKEN });
  });

  it('mints an attach url for a runner', async () => {
    writeLicense();
    mockCloud(() => ({
      status: 200,
      json: { code: 'f'.repeat(32), expiresAt: 'x', url: 'https://box-1.r.strado.io/__strado_connect?key=f' },
    }));
    const res = await app.inject({ method: 'POST', url: '/api/runners/box-1/attach' });
    expect(res.json().url).toContain('__strado_connect');
    expect(calls[0]!.body).toEqual({ token: TOKEN, runnerId: 'box-1' });
  });

  it('passes the runner id through url-encoded', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: { ok: true } }));
    await app.inject({ method: 'POST', url: '/api/runners/box%2Fweird/revoke' });
    expect(calls[0]!.body).toEqual({ token: TOKEN, runnerId: 'box/weird' });
  });

  it('surfaces the cloud reason on a rejection', async () => {
    writeLicense();
    mockCloud(() => ({ status: 403, json: { error: 'invalid token' } }));
    const res = await app.inject({ method: 'GET', url: '/api/runners' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('invalid token');
  });

  it('reports an unreachable cloud as a retryable upstream failure, not user error', async () => {
    writeLicense();
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await app.inject({ method: 'GET', url: '/api/runners' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('CLOUD_UNREACHABLE');
  });
});
