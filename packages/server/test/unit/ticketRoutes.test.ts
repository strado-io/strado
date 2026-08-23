import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registerTicketRoutes } from '../../src/routes/tickets';
import * as registry from '../../src/services/tickets/registry';
import { AppError, toResponse } from '../../src/errors';
import { linearConfigPath } from '../../src/services/tickets/linear';

// Jira/Linear are Pro-gated on the local server (see routes/tickets.ts). Mock
// the entitlement check so it's controllable per test — default ON, so the
// behavioural tests below run as before; the gating tests flip it OFF.
const entMock = vi.hoisted(() => ({ hasFeature: vi.fn(async () => true) }));
vi.mock('../../src/services/entitlements', () => ({
  hasFeature: entMock.hasFeature,
  orgFeatures: async () => ({}),
  resetEntitlementsCache: () => {},
}));
beforeEach(() => {
  entMock.hasFeature.mockReset();
  entMock.hasFeature.mockResolvedValue(true);
});

function makeProvider(id: 'jira' | 'linear', overrides: Partial<import('../../src/services/tickets/types').TicketProvider> = {}) {
  return {
    id, label: id === 'jira' ? 'Jira' : 'Linear',
    configured: async () => true,
    getMyOpenIssues: async () => [],
    getSprints: async () => [],
    getSprintIssues: async () => [],
    getIssue: vi.fn(), getIssues: vi.fn(), getTransitions: async () => [], doTransition: vi.fn(),
    ...overrides,
  } as import('../../src/services/tickets/types').TicketProvider;
}

const ISSUE = {
  provider: 'jira', key: 'FD-1', summary: 's', status: 'To Do', category: 'new',
  assignee: null, priority: null, estimate: null, url: 'https://x/browse/FD-1',
  timeSpent: null, remaining: null, timeSpentSeconds: null, remainingSeconds: null,
} as const;

async function buildApp(jira: ReturnType<typeof makeProvider>, linear: ReturnType<typeof makeProvider>) {
  vi.spyOn(registry, 'getTicketProvider').mockImplementation((id) => (id === 'jira' ? jira : linear));
  const app = Fastify();
  // Mirrors app.ts's error handler exactly — a bare Fastify() instance has no
  // ZodError -> 400 mapping otherwise, and the route's `.parse()` calls throw ZodError.
  app.setErrorHandler((err, _req, reply) => {
    const mapped = err instanceof ZodError ? new AppError('VALIDATION', 'invalid request body', err.issues) : err;
    const status = mapped instanceof AppError ? mapped.httpStatus : 500;
    reply.code(status).send(toResponse(mapped));
  });
  await registerTicketRoutes(app);
  return app;
}

describe('ticket routes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects unknown providers', async () => {
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));
    const res = await app.inject({ method: 'GET', url: '/api/tickets/asana/my-issues' });
    expect(res.statusCode).toBe(400);
  });

  it('batch keeps one provider alive when the other throws', async () => {
    const jira = makeProvider('jira', { getIssues: async () => ({ issues: { 'FD-1': ISSUE }, missing: [] }) });
    const linear = makeProvider('linear', { getIssues: async () => { throw new Error('Linear rejected the token'); } });
    const app = await buildApp(jira, linear);
    const res = await app.inject({
      method: 'POST', url: '/api/tickets/issues',
      payload: { refs: [{ provider: 'jira', key: 'FD-1' }, { provider: 'linear', key: 'ENG-9' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issues['jira:FD-1'].summary).toBe('s');
    expect(body.errors.linear).toMatch(/rejected the token/);
    expect(body.missing).toEqual([]); // linear keys are NOT reported missing on provider error
  });

  it('batch stringifies a non-Error throw from a provider instead of dropping it', async () => {
    const jira = makeProvider('jira', { getIssues: async () => ({ issues: { 'FD-1': ISSUE }, missing: [] }) });
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    const linear = makeProvider('linear', { getIssues: async () => { throw 'linear exploded'; } });
    const app = await buildApp(jira, linear);
    const res = await app.inject({
      method: 'POST', url: '/api/tickets/issues',
      payload: { refs: [{ provider: 'jira', key: 'FD-1' }, { provider: 'linear', key: 'ENG-9' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors.linear).toBe('linear exploded');
  });

  it('batch namespaces missing keys by provider', async () => {
    const jira = makeProvider('jira', { getIssues: async () => ({ issues: {}, missing: ['FD-404'] }) });
    const app = await buildApp(jira, makeProvider('linear'));
    const res = await app.inject({
      method: 'POST', url: '/api/tickets/issues',
      payload: { refs: [{ provider: 'jira', key: 'FD-404' }] },
    });
    expect(res.json().missing).toEqual(['jira:FD-404']);
  });

  it('a Free org (no jira/linear entitlement) is refused and sees no providers', async () => {
    entMock.hasFeature.mockResolvedValue(false);
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));

    // Per-provider route refuses with 402 UPGRADE_REQUIRED.
    const denied = await app.inject({ method: 'GET', url: '/api/tickets/jira/my-issues' });
    expect(denied.statusCode).toBe(402);
    expect(denied.json().code).toBe('UPGRADE_REQUIRED');

    // Batch drops refs for un-entitled providers rather than fetching them.
    const batch = await app.inject({
      method: 'POST', url: '/api/tickets/issues',
      payload: { refs: [{ provider: 'jira', key: 'FD-1' }] },
    });
    expect(batch.json()).toEqual({ issues: {}, missing: [], errors: {} });
  });
});

describe('linear connect routes', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  let home: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-tickets-'));
    process.env.STRADO_HOME = home;
  });

  afterEach(() => {
    delete process.env.STRADO_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('connect returns a 64-hex state and a url containing it', async () => {
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));
    const res = await app.inject({ method: 'POST', url: '/api/tickets/linear/connect' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toMatch(/^[a-f0-9]{64}$/);
    expect(body.url).toContain(`state=${body.state}`);
  });

  it('poll returns not-connected while the cloud broker is still pending', async () => {
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));
    const { state } = (await app.inject({ method: 'POST', url: '/api/tickets/linear/connect' })).json();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ pending: true }) });
    const res = await app.inject({ method: 'GET', url: `/api/tickets/linear/connect/${state}` });
    expect(res.json()).toEqual({ connected: false });
  });

  it('poll writes the config and reports connected once the broker has a token', async () => {
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));
    const { state } = (await app.inject({ method: 'POST', url: '/api/tickets/linear/connect' })).json();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pending: false, accessToken: 'lin_tok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { organization: { name: 'Acme' } } }) });
    const res = await app.inject({ method: 'GET', url: `/api/tickets/linear/connect/${state}` });
    expect(res.json()).toEqual({ connected: true, workspaceName: 'Acme' });
    expect(JSON.parse(fs.readFileSync(linearConfigPath(), 'utf8')).accessToken).toBe('lin_tok');
  });

  // CSRF / token-injection guard: a third party can complete their own OAuth
  // flow against the (public) cloud broker under a state of their own
  // choosing, then get a victim's browser to hit this route with that state
  // (a plain <img> tag triggers no preflight). Without tracking which states
  // THIS server issued, that would let the attacker's token get written into
  // the victim's local Linear config.
  it('rejects a well-formed state this server never issued to it, with zero cloud contact', async () => {
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));
    const res = await app.inject({ method: 'GET', url: `/api/tickets/linear/connect/${'f'.repeat(64)}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a state is single-use — polling again after a completed connection is rejected', async () => {
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));
    const { state } = (await app.inject({ method: 'POST', url: '/api/tickets/linear/connect' })).json();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pending: false, accessToken: 'lin_tok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { organization: { name: 'Acme' } } }) });
    const first = await app.inject({ method: 'GET', url: `/api/tickets/linear/connect/${state}` });
    expect(first.json()).toEqual({ connected: true, workspaceName: 'Acme' });
    fetchMock.mockClear();
    const second = await app.inject({ method: 'GET', url: `/api/tickets/linear/connect/${state}` });
    expect(second.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // POST /connect needs no auth (it's the pre-login step) and needs no
  // preflight, so a malicious page firing unlimited cross-origin POSTs must
  // not be able to grow the issued-states map without bound.
  it('POST /connect refuses once too many states are pending', async () => {
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));
    let sawRefusal = false;
    // The map is a module-level singleton other tests in this file also
    // populate, so loop past the 1,000 cap rather than assuming a fresh map.
    for (let i = 0; i < 1_100; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/tickets/linear/connect' });
      if (res.statusCode === 429) {
        expect(res.json()).toEqual({ error: 'too many pending connections' });
        sawRefusal = true;
        break;
      }
      expect(res.statusCode).toBe(200);
    }
    expect(sawRefusal).toBe(true);
  });

  it('DELETE removes the config file', async () => {
    fs.writeFileSync(linearConfigPath(), JSON.stringify({ accessToken: 'x', workspaceName: 'Acme' }));
    const app = await buildApp(makeProvider('jira'), makeProvider('linear'));
    const res = await app.inject({ method: 'DELETE', url: '/api/tickets/linear/config' });
    expect(res.json()).toEqual({ ok: true });
    expect(fs.existsSync(linearConfigPath())).toBe(false);
  });
});
