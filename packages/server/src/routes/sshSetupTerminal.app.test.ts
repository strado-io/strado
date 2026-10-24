// The setup terminal's own tests register @fastify/websocket themselves, so
// they can't see where buildApp mounts the route. Mounted before the plugin,
// the route is a plain GET and every attach is an HTTP 500 — this pins that it
// upgrades in the real app.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, buildDeps } from '../app.js';
import { SSH_SETUP_KEY_PREFIX, SSH_SETUP_ROUTES } from '../services/sshSetup/types.js';

let tmp: string;
let prevHome: string | undefined;
let prevLicense: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-term-app-')));
  const home = path.join(tmp, 'strado-home');
  await fs.mkdir(home, { recursive: true });
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = home;
  prevLicense = process.env.STRADO_LICENSE_REQUIRED;
  delete process.env.STRADO_LICENSE_REQUIRED;
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'state') });
  app = await buildApp(deps);
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  if (prevLicense === undefined) delete process.env.STRADO_LICENSE_REQUIRED;
  else process.env.STRADO_LICENSE_REQUIRED = prevLicense;
  await fs.rm(tmp, { recursive: true, force: true });
});

it('upgrades to a websocket in the real app and refuses a key no job owns', async () => {
  const { port } = app.server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  const key = encodeURIComponent(`${SSH_SETUP_KEY_PREFIX}not-a-job`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${SSH_SETUP_ROUTES.terminal}?key=${key}`, { headers: { origin } });
  const outcome = await new Promise<{ frames: unknown[]; code: number }>((resolve, reject) => {
    const frames: unknown[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    ws.on('close', (code) => resolve({ frames, code }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
  expect(outcome.code).toBe(4404);
  expect(outcome.frames).toEqual([{ type: 'error', message: 'not a setup terminal' }]);
});
