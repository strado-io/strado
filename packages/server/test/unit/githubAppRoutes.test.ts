import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, toResponse } from '../../src/errors.js';
import { registerGitProviderConfigRoutes } from '../../src/routes/gitProvider.js';
import { issueSandboxGitBrokerToken } from '../../src/services/sandboxGitBroker.js';

const TOKEN = 'a'.repeat(64);
let home: string;
let app: ReturnType<typeof Fastify>;
let calls: Array<{ url: string; body: unknown }>;

beforeEach(async () => {
  calls = [];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-github-app-routes-'));
  process.env.STRADO_HOME = home;
  process.env.STRADO_LICENSE_API = 'https://api.test';
  fs.writeFileSync(path.join(home, 'license.json'), JSON.stringify({
    code: 'STRADO-TEST', token: TOKEN, name: 'Tester', deviceId: 'device-1',
  }));
  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof AppError ? error.httpStatus : 500).send(toResponse(error));
  });
  await registerGitProviderConfigRoutes(app);
});

afterEach(async () => {
  await app.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.STRADO_HOME;
  delete process.env.STRADO_LICENSE_API;
  delete process.env.STRADO_RUNNER;
  vi.unstubAllGlobals();
});

function mockCloud(result: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(result), { status: 200 });
  }));
}

describe('GitHub App proxy routes', () => {
  it('starts an installation without returning the device token to the renderer', async () => {
    mockCloud({ state: 's', url: 'https://github.com/apps/strado/installations/new?state=s', expiresAt: 'x' });
    const response = await app.inject({ method: 'POST', url: '/api/github/app/connect' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      state: 's', url: 'https://github.com/apps/strado/installations/new?state=s', expiresAt: 'x',
    });
    expect(calls).toEqual([{
      url: 'https://api.test/v1/integrations/github/connect',
      body: { token: TOKEN },
    }]);
    expect(response.body).not.toContain(TOKEN);
  });

  it('proxies installation status and unlink for the active Strado org', async () => {
    mockCloud({ installations: [{ installationId: 42, accountLogin: 'strado-io' }] });
    const status = await app.inject({ method: 'GET', url: '/api/github/app/status' });
    expect(status.statusCode).toBe(200);
    expect(calls[0]).toEqual({
      url: 'https://api.test/v1/integrations/github/status',
      body: { token: TOKEN },
    });

    calls = [];
    mockCloud({ ok: true });
    const unlink = await app.inject({ method: 'POST', url: '/api/github/app/disconnect/42' });
    expect(unlink.statusCode).toBe(200);
    expect(calls[0]).toEqual({
      url: 'https://api.test/v1/integrations/github/disconnect',
      body: { token: TOKEN, installationId: 42 },
    });
  });

  it('exchanges a worktree-bound sandbox capability for its repository credential', async () => {
    process.env.STRADO_RUNNER = '1';
    fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({
      runnerId: 'runner-1', runnerToken: TOKEN, apiUrl: 'https://api.test',
    }), { mode: 0o600 });
    const worktree = path.join(home, 'worktree');
    fs.mkdirSync(worktree);
    const brokerToken = await issueSandboxGitBrokerToken(worktree, 'strado-io/strado');
    expect(brokerToken).toBeTruthy();
    mockCloud({ username: 'x-access-token', token: 'ghs_short_lived', expiresAt: '2026-09-01T00:00:00Z' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/git/credential',
      // Unknown fields are stripped: the sandbox cannot redirect its
      // capability to a different owner/repository.
      payload: { brokerToken, projectPath: 'attacker/other' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().token).toBe('ghs_short_lived');
    expect(calls).toEqual([{
      url: 'https://api.test/v1/runners/git-credential',
      body: {
        runnerId: 'runner-1',
        runnerToken: TOKEN,
        host: 'github.com',
        projectPath: 'strado-io/strado',
        operation: 'write',
      },
    }]);
  });
});
