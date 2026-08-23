// The order this route writes is the order the sidebar swipes through, so it
// has to refuse a list that would drop or invent a workspace.
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

const newWorkspace = (id: string, portBase: number) => ({
  id,
  name: id.toUpperCase(),
  color: '#334455',
  icon: id[0]!,
  defaultEditor: 'code',
  defaultPortBase: portBase,
  logDir: null,
});

async function listIds(): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/api/workspaces' });
  return (res.json().workspaces as { id: string }[]).map((w) => w.id);
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-order-route-')));
  home = path.join(tmp, 'strado-home');
  await fs.mkdir(home, { recursive: true });
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = home;
  // Temp STRADO_HOME is unlicensed, and the gate would 401 every request;
  // this suite is about the order contract, not the gate.
  prevLicense = process.env.STRADO_LICENSE_REQUIRED;
  delete process.env.STRADO_LICENSE_REQUIRED;
  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'state'),
  });
  app = await buildApp(deps);
  for (const [id, port] of [['alpha', 8080], ['beta', 8090]] as const) {
    const res = await app.inject({ method: 'POST', url: '/api/workspaces', payload: newWorkspace(id, port) });
    expect(res.statusCode).toBe(200);
  }
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  if (prevLicense === undefined) delete process.env.STRADO_LICENSE_REQUIRED;
  else process.env.STRADO_LICENSE_REQUIRED = prevLicense;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('POST /api/workspaces/order', () => {
  it('rewrites the order and returns the new list', async () => {
    const before = await listIds();
    const reversed = [...before].reverse();
    const res = await app.inject({ method: 'POST', url: '/api/workspaces/order', payload: { ids: reversed } });
    expect(res.statusCode).toBe(200);
    expect((res.json().workspaces as { id: string }[]).map((w) => w.id)).toEqual(reversed);
    expect(await listIds()).toEqual(reversed);
  });

  it('400s on a list that is not a permutation, leaving the order intact', async () => {
    const before = await listIds();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces/order',
      payload: { ids: [...before, 'ghost'] },
    });
    expect(res.statusCode).toBe(400);
    expect(await listIds()).toEqual(before);
  });

  it('400s on a malformed body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/workspaces/order', payload: { ids: 'nope' } });
    expect(res.statusCode).toBe(400);
  });
});
