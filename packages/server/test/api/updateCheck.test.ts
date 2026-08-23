import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-upd-')));
  process.env.STRADO_LICENSE_API = 'https://api.test';
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  fetchMock.mockReset();
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env.STRADO_LICENSE_API;
  delete process.env.STRADO_APP_VERSION;
});

const rel = { version: '0.2.0', url: 'https://api.test/v1/download/Strado-0.2.0-arm64.dmg', sha256: 'deadbeef', notes: 'n', mandatory: true };

describe('GET /api/update-check', () => {
  it('reports an available update when the release is newer', async () => {
    process.env.STRADO_APP_VERSION = '0.1.0';
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rel), { status: 200 }));
    const res = await app.inject({ method: 'GET', url: '/api/update-check' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updateAvailable: true, current: '0.1.0', version: '0.2.0', url: rel.url, sha256: 'deadbeef', mandatory: true });
  });

  it('reports no update when current is same or newer', async () => {
    process.env.STRADO_APP_VERSION = '0.2.0';
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rel), { status: 200 }));
    expect((await app.inject({ method: 'GET', url: '/api/update-check' })).json()).toEqual({ updateAvailable: false });
  });

  it('fails closed on a dev run (no STRADO_APP_VERSION) without calling the API', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/update-check' });
    expect(res.json()).toEqual({ updateAvailable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the upstream errors or 204s', async () => {
    process.env.STRADO_APP_VERSION = '0.1.0';
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect((await app.inject({ method: 'GET', url: '/api/update-check' })).json()).toEqual({ updateAvailable: false });
  });

  it('fails closed on upstream network error', async () => {
    process.env.STRADO_APP_VERSION = '0.1.0';
    fetchMock.mockRejectedValue(new Error('network down'));
    const res = await app.inject({ method: 'GET', url: '/api/update-check' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updateAvailable: false });
  });
});
