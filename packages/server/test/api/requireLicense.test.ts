import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, buildDeps } from '../../src/app.js';

let tmp: string;

function writeValidLicense(extra: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(process.env.STRADO_HOME!, 'license.json'),
    JSON.stringify({ token: 'a'.repeat(64), name: 'K', deviceId: 'device-0001', email: 'k@example.com', ...extra }),
  );
}

async function makeApp() {
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  return buildApp(deps);
}

describe('license enforcement', () => {
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enf-')));
    process.env.STRADO_LICENSE_REQUIRED = '1';
    process.env.STRADO_HOME = path.join(tmp, 'strado-home');
  });

  afterEach(() => {
    delete process.env.STRADO_LICENSE_REQUIRED;
    delete process.env.STRADO_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('refuses a normal route with no license', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/w/default/repos' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'not_licensed' });
    await app.close();
  });

  // registerEventRoutes mounts at /events, not /api/events — easy to miss if
  // the gate only ever checks the /api/ prefix.
  it('refuses the SSE event stream with no license', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/events/worktrees' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // /ws/terminal is a live shell into the user's worktrees — the single
  // biggest hole a /api/-only prefix check would leave open. The onRequest
  // hook runs before Fastify's websocket upgrade machinery ever engages, so a
  // plain inject (no real socket/upgrade handshake needed) already proves the
  // route never reaches it while unlicensed.
  it('refuses the terminal websocket route with no license', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/ws/terminal?path=%2Ftmp&mode=shell' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('still serves the routes needed to sign in', async () => {
    // /api/auth/start reaches the real cloud unless stubbed; the gate is what
    // is under test here, not the cloud call, so give it a harmless response.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const app = await makeApp();
    for (const url of ['/api/license', '/api/health']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} must stay open`).not.toBe(401);
    }
    const start = await app.inject({ method: 'POST', url: '/api/auth/start' });
    expect(start.statusCode).not.toBe(401);
    await app.close();
  });

  it('serves everything once a license is present', async () => {
    fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
    writeValidLicense();
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/w/default/repos' });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it('refuses when the license is stale past the grace window', async () => {
    fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
    writeValidLicense({ lastVerifiedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/w/default/repos' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('enforces nothing when the gate is off, so developing Strado needs no login', async () => {
    delete process.env.STRADO_LICENSE_REQUIRED;
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/w/default/repos' });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  describe('POST /api/license/verify', () => {
    it('stamps the license when the cloud confirms the device', async () => {
      fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
      writeValidLicense();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const app = await makeApp();
      const res = await app.inject({ method: 'POST', url: '/api/license/verify' });
      expect(res.json()).toMatchObject({ ok: true });
      const saved = JSON.parse(fs.readFileSync(path.join(process.env.STRADO_HOME!, 'license.json'), 'utf8'));
      expect(saved.lastVerifiedAt).toBeTruthy();
      await app.close();
    });

    it('clears the license when the cloud says the device is revoked', async () => {
      fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
      writeValidLicense();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ ok: false, revoked: true }), { status: 200 })),
      );
      const app = await makeApp();
      const res = await app.inject({ method: 'POST', url: '/api/license/verify' });
      expect(res.json()).toMatchObject({ ok: false, reason: 'revoked' });
      expect(fs.existsSync(path.join(process.env.STRADO_HOME!, 'license.json'))).toBe(false);
      await app.close();
    });

    it('leaves the license alone when the cloud is unreachable', async () => {
      // Offline is not revoked. Clearing here would log people out on a plane.
      fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
      writeValidLicense();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('network');
        }),
      );
      const app = await makeApp();
      const res = await app.inject({ method: 'POST', url: '/api/license/verify' });
      expect(res.json()).toMatchObject({ ok: false, reason: 'unreachable' });
      expect(fs.existsSync(path.join(process.env.STRADO_HOME!, 'license.json'))).toBe(true);
      await app.close();
    });

    // A bare { ok: false } with no `revoked` flag is what the cloud answers
    // when the device row has been deleted entirely (store.pg.ts's join finds
    // nothing) — this is a real revocation path, not a corner case. Stamping
    // here would restart the install's own grace window and make deleting the
    // device row a no-op forever; clearing here would let one transient,
    // ambiguous cloud answer log everyone out at once. Neither is correct —
    // the license must be left exactly as it is, so the existing grace window
    // keeps counting down and the install locks itself out within it.
    it('neither stamps nor clears on a bare ok:false with no revoked flag', async () => {
      fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
      const before = new Date(Date.now() - 60_000).toISOString();
      writeValidLicense({ lastVerifiedAt: before });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 })));
      const app = await makeApp();
      const res = await app.inject({ method: 'POST', url: '/api/license/verify' });
      expect(res.json()).toMatchObject({ ok: false, reason: 'unconfirmed' });
      const saved = JSON.parse(fs.readFileSync(path.join(process.env.STRADO_HOME!, 'license.json'), 'utf8'));
      expect(saved.lastVerifiedAt).toBe(before);
      await app.close();
    });
  });

  // GET /api/license is on the OPEN_PATHS allow-list, so it must answer this
  // itself rather than the UI inferring it from a 401 on some other route —
  // the UI needs to tell "stale" (grace expired) apart from "signed out"
  // apart from "fine", and this is the only place it can learn that.
  describe('GET /api/license status', () => {
    it('reports none with no license on file', async () => {
      const app = await makeApp();
      const res = await app.inject({ method: 'GET', url: '/api/license' });
      expect(res.json()).toMatchObject({ status: 'none', license: null });
      await app.close();
    });

    it('reports ok for a freshly verified license', async () => {
      fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
      writeValidLicense({ lastVerifiedAt: new Date().toISOString() });
      const app = await makeApp();
      const res = await app.inject({ method: 'GET', url: '/api/license' });
      expect(res.json()).toMatchObject({ status: 'ok' });
      await app.close();
    });

    it('reports ok for a license that predates lastVerifiedAt (no field yet)', async () => {
      fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
      writeValidLicense();
      const app = await makeApp();
      const res = await app.inject({ method: 'GET', url: '/api/license' });
      expect(res.json()).toMatchObject({ status: 'ok' });
      await app.close();
    });

    it('reports stale once the grace window has run out', async () => {
      fs.mkdirSync(process.env.STRADO_HOME!, { recursive: true });
      writeValidLicense({ lastVerifiedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() });
      const app = await makeApp();
      const res = await app.inject({ method: 'GET', url: '/api/license' });
      expect(res.json()).toMatchObject({ status: 'stale' });
      await app.close();
    });
  });
});
