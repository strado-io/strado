// The model credential is the one secret the user pastes into the UI. The GET
// must never echo it back — the renderer only ever needs to know it is set and
// show its last four. These tests pin that contract at the route boundary.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../app.js';

let tmp: string;
let home: string;
let prevHome: string | undefined;
let prevLicense: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'model-cred-route-')));
  home = path.join(tmp, 'strado-home');
  await fs.mkdir(home, { recursive: true });
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = home;
  // This suite points STRADO_HOME at an unlicensed temp dir, so the license
  // gate would 401 every request. We are testing the credential contract, not
  // the gate — disable it for this file (restored in afterEach).
  prevLicense = process.env.STRADO_LICENSE_REQUIRED;
  delete process.env.STRADO_LICENSE_REQUIRED;
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'state') });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  if (prevLicense === undefined) delete process.env.STRADO_LICENSE_REQUIRED;
  else process.env.STRADO_LICENSE_REQUIRED = prevLicense;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('/api/model-credential', () => {
  it('GET reports absence before anything is stored', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-credential' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ present: false, last4: null });
  });

  it('round-trips presence and last4, and NEVER returns the key', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/model-credential',
      payload: { key: 'sk-ant-supersecret-9876' },
    });
    expect(post.statusCode).toBe(200);
    expect(post.body).not.toContain('supersecret');

    const get = await app.inject({ method: 'GET', url: '/api/model-credential' });
    expect(get.json()).toEqual({ present: true, last4: '9876' });
    expect(get.body).not.toContain('supersecret');
    expect(get.body).not.toContain('sk-ant');
  });

  it('clears when POSTed a null/empty key', async () => {
    await app.inject({ method: 'POST', url: '/api/model-credential', payload: { key: 'sk-ant-secret-0000' } });
    const cleared = await app.inject({ method: 'POST', url: '/api/model-credential', payload: { key: null } });
    expect(cleared.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/model-credential' });
    expect(get.json()).toEqual({ present: false, last4: null });
  });
});
