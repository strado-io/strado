import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { licensePath } from '../../src/services/licenseFile';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-auth-')));
  process.env.STRADO_LICENSE_API = 'https://api.test';
  process.env.STRADO_HOME = path.join(tmp, 'strado-home');
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  fetchMock.mockReset();
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env.STRADO_LICENSE_API;
  delete process.env.STRADO_HOME;
});

const grant = {
  userCode: 'ABCD-1234',
  deviceCode: 'secret-device-code',
  verificationUrl: 'https://api.test/login?user_code=ABCD-1234',
  interval: 5,
  expiresAt: '2026-08-01T00:10:00.000Z',
};

async function start() {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(grant), { status: 200 }));
  const res = await app.inject({ method: 'POST', url: '/api/auth/start' });
  fetchMock.mockReset();
  return res;
}

describe('POST /api/auth/start', () => {
  it('mints a grant and never hands the device code to the caller', async () => {
    const res = await start();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      userCode: grant.userCode,
      verificationUrl: grant.verificationUrl,
      interval: grant.interval,
      expiresAt: grant.expiresAt,
    });
    expect(JSON.stringify(body)).not.toContain('secret-device-code');
  });

  it('returns 502 when the cloud is unreachable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const res = await app.inject({ method: 'POST', url: '/api/auth/start' });
    expect(res.statusCode).toBe(502);
  });

  it('mints a fresh device id when there is no license yet', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(grant), { status: 200 }));
    await app.inject({ method: 'POST', url: '/api/auth/start' });
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses the device id from an existing license rather than minting a new one', async () => {
    await fs.mkdir(path.dirname(licensePath()), { recursive: true });
    await fs.writeFile(
      licensePath(),
      JSON.stringify({ token: 'a'.repeat(64), name: 'K', deviceId: 'device-abcdefgh', email: 'a@b.com' }),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(grant), { status: 200 }));
    await app.inject({ method: 'POST', url: '/api/auth/start' });
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.deviceId).toBe('device-abcdefgh');
  });
});

describe('POST /api/auth/poll', () => {
  it('rejects an unknown user code without calling the cloud', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: 'NOPE-0000' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unknown_user_code' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports authorization_pending and keeps the entry alive for the next poll', async () => {
    await start();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
    );
    const res = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res.json()).toEqual({ status: 'authorization_pending' });

    // still pending — a second poll reaches the cloud again rather than 400ing locally
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 }));
    const res2 = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res2.json()).toEqual({ status: 'slow_down' });
  });

  it('terminates on 400 expired_token and forgets the pending entry', async () => {
    await start();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 }));
    const res = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res.json()).toEqual({ status: 'expired' });

    const res2 = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res2.statusCode).toBe(400);
    expect(res2.json()).toEqual({ error: 'unknown_user_code' });
  });

  // The invite-code gate is gone from the cloud (the cloud service's auth routes
  // no longer have a reason to answer /v1/auth/device/token with 403), so this
  // poll route no longer special-cases that status: it must fall into the same
  // `!res.ok` -> 502 branch as any other unexpected upstream response, with the
  // pending entry left alive for the next poll rather than being torn down.
  it('502s on an unexpected 403 rather than treating it as a terminal status', async () => {
    await start();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no_invite_code' }), { status: 403 }));
    const res = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res.statusCode).toBe(502);

    // the entry survives — a retry reaches the cloud again, not "unknown"
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }));
    const res2 = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res2.json()).toEqual({ status: 'authorization_pending' });
  });

  it('still 502s on a genuinely unexpected upstream failure', async () => {
    await start();
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const res = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res.statusCode).toBe(502);
  });

  it('writes the license file and clears the pending entry on success', async () => {
    await start();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token: 'a'.repeat(64), email: 'a@b.com', name: 'A', deviceId: 'device-abcdefgh' }),
        { status: 200 },
      ),
    );
    const res = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res.json()).toEqual({ status: 'signed_in', email: 'a@b.com', name: 'A' });

    const written = JSON.parse(await fs.readFile(licensePath(), 'utf8'));
    expect(written).toEqual({ token: 'a'.repeat(64), name: 'A', deviceId: 'device-abcdefgh', email: 'a@b.com' });

    // the map entry is gone — a repeat poll is now "unknown", not another success
    const res2 = await app.inject({ method: 'POST', url: '/api/auth/poll', payload: { userCode: grant.userCode } });
    expect(res2.json()).toEqual({ error: 'unknown_user_code' });
  });
});

describe('POST /api/auth/signout', () => {
  it('removes the license file', async () => {
    await fs.mkdir(path.dirname(licensePath()), { recursive: true });
    await fs.writeFile(licensePath(), '{}');
    const res = await app.inject({ method: 'POST', url: '/api/auth/signout' });
    expect(res.statusCode).toBe(204);
    await expect(fs.access(licensePath())).rejects.toThrow();
  });

  it('is a no-op when there is no license file', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signout' });
    expect(res.statusCode).toBe(204);
  });
});
