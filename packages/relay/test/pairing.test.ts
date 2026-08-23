// M2 end-to-end: pairing + cloud-backed relay auth.
// A fake strado-api implements the same internal contract as the cloud service
// (verify / attach-exchange / online) so this suite pins the wire contract
// from the relay's side; the cloud service's own test suite pins it from the API's side.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TunnelClient } from '../src/client.js';
import { cloudAuth, cloudPresenceReporter } from '../src/cloudAuth.js';
import { buildRelayApp, type TunnelManager } from '../src/server.js';

const INTERNAL_SECRET = 'internal-test-secret';
const DOMAIN = 'relay.test';

// Fake cloud state
const runnerId = 'runner-dev-ab12';
const runnerToken = randomBytes(32).toString('hex');
const tokenHash = createHash('sha256').update(runnerToken).digest('hex');
let revoked = false;
const attachCodes = new Map<string, { runnerId: string; used: boolean }>();
const onlinePings: string[] = [];

let cloud: FastifyInstance;
let cloudPort = 0;
let local: FastifyInstance;
let localPort = 0;
let relayApp: FastifyInstance;
let tunnels: TunnelManager;
let relayPort = 0;
let client: TunnelClient;

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function req(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: relayPort, path, headers: { host: `${runnerId}.${DOMAIN}`, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += String(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

beforeAll(async () => {
  cloud = Fastify({ logger: false });
  cloud.addHook('preHandler', async (req, reply) => {
    if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return reply.code(403).send({ error: 'forbidden' });
  });
  cloud.post('/internal/runners/verify', async (req) => {
    const { runnerId: id, runnerToken: token } = req.body as { runnerId: string; runnerToken: string };
    const ok = id === runnerId && !revoked && createHash('sha256').update(token).digest('hex') === tokenHash;
    return ok ? { ok: true, ownerCode: 'STRADO-TEST' } : { ok: false };
  });
  cloud.post('/internal/runners/attach-exchange', async (req, reply) => {
    const { code } = req.body as { code: string };
    const entry = attachCodes.get(code);
    if (!entry || entry.used) return reply.code(403).send({ error: 'invalid' });
    entry.used = true;
    return { runnerId: entry.runnerId };
  });
  cloud.post('/internal/runners/online', async (req) => {
    onlinePings.push((req.body as { runnerId: string }).runnerId);
    return { ok: true };
  });
  await cloud.listen({ host: '127.0.0.1', port: 0 });
  cloudPort = (cloud.server.address() as { port: number }).port;

  local = Fastify({ logger: false });
  local.get('/api/hello', async () => ({ msg: 'hi' }));
  await local.listen({ host: '127.0.0.1', port: 0 });
  localPort = (local.server.address() as { port: number }).port;

  const authOpts = { apiUrl: `http://127.0.0.1:${cloudPort}`, internalSecret: INTERNAL_SECRET };
  const built = buildRelayApp({
    domain: DOMAIN,
    // Tiny allow TTL so the revocation test doesn't wait out the prod cache.
    auth: cloudAuth({ ...authOpts, allowTtlMs: 50, denyTtlMs: 50 }),
    cookieSecret: 'cookie-secret',
    onRunnerOnline: cloudPresenceReporter(authOpts),
    log: () => {},
  });
  relayApp = built.app;
  tunnels = built.tunnels;
  await relayApp.listen({ host: '127.0.0.1', port: 0 });
  relayPort = (relayApp.server.address() as { port: number }).port;
});

afterAll(async () => {
  client?.stop();
  await relayApp.close();
  await local.close();
  await cloud.close();
});

async function startClient(token: string): Promise<{ client: TunnelClient; status: () => string }> {
  let status = 'none';
  const c = new TunnelClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    runnerId,
    token,
    accessKey: 'a'.repeat(32),
    localPort,
    log: () => {},
    onStatusChange: (s) => {
      status = s;
    },
  });
  c.start();
  return { client: c, status: () => status };
}

describe('cloud-authed relay', () => {
  it('rejects a runner with a wrong token', async () => {
    const bad = await startClient('f'.repeat(64));
    // Never registers: no tunnel appears, and the client keeps retrying.
    await new Promise((r) => setTimeout(r, 400));
    expect(tunnels.list()).toEqual([]);
    bad.client.stop();
  });

  it('registers a runner with its paired token and reports presence', async () => {
    const good = await startClient(runnerToken);
    client = good.client;
    await waitFor(() => good.status() === 'connected');
    expect(tunnels.list()).toEqual([runnerId]);
    await waitFor(() => onlinePings.includes(runnerId));
  });

  it('one-time attach code: works once, dies after use', async () => {
    const code = randomBytes(16).toString('hex');
    attachCodes.set(code, { runnerId, used: false });

    const first = await req(`/__strado_connect?key=${code}`);
    expect(first.status).toBe(302);
    const cookie = String(first.headers['set-cookie']).split(';')[0];

    // The cookie works for real traffic.
    const api = await req('/api/hello', { cookie: cookie as string });
    expect(api.status).toBe(200);
    expect(JSON.parse(api.body)).toEqual({ msg: 'hi' });

    // Replaying the code fails — it was consumed.
    const replay = await req(`/__strado_connect?key=${code}`);
    expect(replay.status).toBe(403);
  });

  it('an attach code for a different runner is rejected', async () => {
    const code = randomBytes(16).toString('hex');
    attachCodes.set(code, { runnerId: 'someone-elses-runner', used: false });
    const res = await req(`/__strado_connect?key=${code}`);
    expect(res.status).toBe(403);
  });

  it('revoking the runner blocks re-registration', async () => {
    revoked = true;
    client.stop();
    await waitFor(() => tunnels.list().length === 0);
    const again = await startClient(runnerToken);
    await new Promise((r) => setTimeout(r, 400));
    expect(tunnels.list()).toEqual([]);
    again.client.stop();
    revoked = false;
  });
});
