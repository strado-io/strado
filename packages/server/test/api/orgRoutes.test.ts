import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app.js';

// The org routes' whole job is to keep the account token server-side, so the
// tests assert on what reaches the cloud rather than on the responses alone
// — same shape as runnerRoutes.test.ts.
let app: Awaited<ReturnType<typeof buildApp>>;
let tmp: string;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-org-'));
  process.env.STRADO_HOME = path.join(tmp, 'strado-home');
  process.env.STRADO_LICENSE_API = 'https://api.test';
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.STRADO_HOME;
  delete process.env.STRADO_LICENSE_API;
  vi.unstubAllGlobals();
});

function writeLicense(): void {
  fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.STRADO_HOME!, 'license.json'),
    JSON.stringify({ code: 'STRADO-TEST-CODE', token: TOKEN, name: 'Tester', deviceId: 'device-1' }),
  );
}

const view = { active: 'org-1', orgs: [{ id: 'org-1', name: 'Acme' }], members: [], invitations: { outgoing: [], incoming: [] } };

describe('GET /api/org', () => {
  it('forwards the license token and returns the cloud body unchanged', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: view }));
    const res = await app.inject({ method: 'GET', url: '/api/org' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(calls[0]!.url).toBe(`https://api.test/v1/org?token=${TOKEN}`);
  });

  it('gives a clean 400 when the machine has no account, without calling the cloud', async () => {
    mockCloud(() => ({ status: 200, json: view }));
    const res = await app.inject({ method: 'GET', url: '/api/org' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/sign in/i);
    expect(calls).toHaveLength(0);
  });

  it('never echoes the token back in the response body', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: view }));
    const res = await app.inject({ method: 'GET', url: '/api/org' });
    expect(JSON.stringify(res.json())).not.toContain(TOKEN);
  });
});

describe('POST /api/org/switch', () => {
  it('forwards orgId with the stored token', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: view }));
    const res = await app.inject({ method: 'POST', url: '/api/org/switch', payload: { orgId: 'org-2' } });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toEqual({ token: TOKEN, orgId: 'org-2' });
  });
});

describe('POST /api/org/rename', () => {
  it('forwards name with the stored token', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: view }));
    const res = await app.inject({ method: 'POST', url: '/api/org/rename', payload: { name: 'New Name' } });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toEqual({ token: TOKEN, name: 'New Name' });
  });
});

describe('POST /api/org/invitations', () => {
  it('forwards email with the stored token', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: { ok: true } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/invitations', payload: { email: 'a@b.com' } });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toEqual({ token: TOKEN, email: 'a@b.com' });
  });

  // The cloud now answers { ok, emailed } so the UI can tell the owner
  // whether mail actually went out — this route is a thin proxy and must not
  // narrow that shape away, in either direction.
  it('passes emailed:true through unmodified', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: { ok: true, emailed: true } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/invitations', payload: { email: 'a@b.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, emailed: true });
  });

  it('passes emailed:false through unmodified', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: { ok: true, emailed: false } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/invitations', payload: { email: 'a@b.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, emailed: false });
  });

  it('surfaces a cloud 429 reason rather than flattening it', async () => {
    writeLicense();
    mockCloud(() => ({ status: 429, json: { error: 'cannot invite', reason: 'cap' } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/invitations', payload: { email: 'a@b.com' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('cap');
  });
});

describe('POST /api/org/invitations/cancel', () => {
  it('forwards email with the stored token', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: { ok: true } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/invitations/cancel', payload: { email: 'a@b.com' } });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toEqual({ token: TOKEN, email: 'a@b.com' });
  });
});

describe('POST /api/org/invitations/:id/accept', () => {
  it('forwards the invitation id as invitationId', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: view }));
    const res = await app.inject({ method: 'POST', url: '/api/org/invitations/inv-1/accept' });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toEqual({ token: TOKEN, invitationId: 'inv-1' });
  });

  it('surfaces a cloud 410 (gone) reason rather than flattening it', async () => {
    writeLicense();
    mockCloud(() => ({ status: 410, json: { error: 'cannot accept', reason: 'gone' } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/invitations/inv-1/accept' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('gone');
  });
});

describe('POST /api/org/invitations/:id/decline', () => {
  it('forwards the invitation id as invitationId', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: { ok: true } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/invitations/inv-1/decline' });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toEqual({ token: TOKEN, invitationId: 'inv-1' });
  });
});

describe('POST /api/org/members/remove', () => {
  it('forwards email with the stored token', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: view }));
    const res = await app.inject({ method: 'POST', url: '/api/org/members/remove', payload: { email: 'a@b.com' } });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toEqual({ token: TOKEN, email: 'a@b.com' });
  });

  it('surfaces a cloud 409 reason rather than flattening it', async () => {
    writeLicense();
    mockCloud(() => ({ status: 409, json: { error: 'cannot remove member', reason: 'last_owner' } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/members/remove', payload: { email: 'a@b.com' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('last_owner');
  });
});

describe('POST /api/org/leave', () => {
  it('forwards just the stored token', async () => {
    writeLicense();
    mockCloud(() => ({ status: 200, json: view }));
    const res = await app.inject({ method: 'POST', url: '/api/org/leave' });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toEqual({ token: TOKEN });
  });

  it('reports an unreachable cloud as a retryable upstream failure, not user error', async () => {
    writeLicense();
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await app.inject({ method: 'POST', url: '/api/org/leave' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('CLOUD_UNREACHABLE');
  });

  it('passes the orphans_runners body through as structured details, not truncated text', async () => {
    writeLicense();
    const runners = Array.from({ length: 12 }, (_, i) => `runner-with-a-long-descriptive-name-${i}`);
    mockCloud(() => ({ status: 409, json: { error: 'orphans_runners', runners } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/leave' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.details).toEqual({ error: 'orphans_runners', runners });
    expect(body.error.details.runners).toHaveLength(12);
  });

  it('passes the last_owner body through as structured details', async () => {
    writeLicense();
    mockCloud(() => ({ status: 409, json: { error: 'last_owner', members: 3 } }));
    const res = await app.inject({ method: 'POST', url: '/api/org/leave' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual({ error: 'last_owner', members: 3 });
  });
});
