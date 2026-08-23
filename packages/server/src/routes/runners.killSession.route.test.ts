// The kill-proxy route: POST /api/w/:ws/remote-worktrees/kill-session forwards
// a DELETE to the target runner (via runnerFetch, which mints a strado-api
// ticket and then hits the runner's own httpBase through it) and must surface
// a runner-side failure as a named error, not a silent { ok: true }.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../app.js';
import { runnerSessionPath } from './runners.js';

let tmp: string;
let home: string;
let prevHome: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;

const RUNNER_HTTP_BASE = 'https://fake-runner.test';

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runners-kill-route-')));
  home = path.join(tmp, 'strado-home');
  await fs.mkdir(home, { recursive: true });
  // token() reads ~/.strado/license.json straight off disk — no network — so a
  // well-formed license here is enough to get past it without mocking fetch.
  await fs.writeFile(
    path.join(home, 'license.json'),
    JSON.stringify({
      token: 'a'.repeat(64),
      name: 'Test User',
      deviceId: 'device-1234',
      email: 'test@example.com',
    }),
  );
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = home;

  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'state') });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * Stub the two network hops runnerFetch makes: mint a socket ticket from
 * strado-api, then hit the runner itself at the httpBase that ticket names.
 * `onRunnerCall` answers only the second hop; the first is always a canned
 * success so every test gets a stable ticket/httpBase pair.
 */
function stubRunnerFetch(onRunnerCall: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      calls.push({ url: u, init });
      if (u.includes('/v1/runners/socket-ticket')) {
        return new Response(
          JSON.stringify({
            ticket: 'tkt-1',
            httpBase: RUNNER_HTTP_BASE,
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.startsWith(RUNNER_HTTP_BASE)) {
        return onRunnerCall(u, init);
      }
      throw new Error(`unexpected fetch to ${u}`);
    }),
  );
  return calls;
}

describe('POST /api/w/:ws/remote-worktrees/kill-session', () => {
  it('forwards a DELETE to the runner at runnerSessionPath and returns ok', async () => {
    const calls = stubRunnerFetch(() => new Response(null, { status: 204 }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/remote-worktrees/kill-session',
      payload: { runnerId: 'runner-1', remoteWsId: 'ws1', path: '/w/FD-1', mode: 'claude' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const runnerCall = calls.find((c) => c.url.startsWith(RUNNER_HTTP_BASE));
    expect(runnerCall).toBeTruthy();
    expect(runnerCall!.init?.method).toBe('DELETE');
    const expectedPath = runnerSessionPath({ remoteWsId: 'ws1', path: '/w/FD-1', mode: 'claude' });
    expect(runnerCall!.url).toBe(`${RUNNER_HTTP_BASE}${expectedPath}?ticket=tkt-1`);
  });

  it('addresses a non-default session id via the query string', async () => {
    const calls = stubRunnerFetch(() => new Response(null, { status: 204 }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/remote-worktrees/kill-session',
      payload: { runnerId: 'runner-1', remoteWsId: 'ws1', path: '/w/FD-1', mode: 'shell', id: '2' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const runnerCall = calls.find((c) => c.url.startsWith(RUNNER_HTTP_BASE));
    const expectedPath = runnerSessionPath({ remoteWsId: 'ws1', path: '/w/FD-1', mode: 'shell', id: '2' });
    // expectedPath already carries `?id=2`, so runnerFetch appends the ticket
    // with `&`, not `?` (see the `sep` logic in runnerFetch).
    expect(runnerCall!.url).toBe(`${RUNNER_HTTP_BASE}${expectedPath}&ticket=tkt-1`);
  });

  it('surfaces a runner failure as a named error, not a silent ok', async () => {
    stubRunnerFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'no such session' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/remote-worktrees/kill-session',
      payload: { runnerId: 'runner-1', remoteWsId: 'ws1', path: '/w/FD-1', mode: 'claude' },
    });

    // runnerErrorMessage() prefixes the runner id onto the runner's own
    // sentence, and the route's error shape carries a named code (VALIDATION)
    // rather than a 200 { ok: true }.
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBe('runner-1: no such session');
  });

  it('maps an offline runner (503 from the relay) to CLOUD_UNREACHABLE', async () => {
    stubRunnerFetch(() => new Response('tunnel down', { status: 503 }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/remote-worktrees/kill-session',
      payload: { runnerId: 'runner-1', remoteWsId: 'ws1', path: '/w/FD-1', mode: 'claude' },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CLOUD_UNREACHABLE');
    expect(body.error.message).toBe('runner runner-1 is offline');
  });

  it('rejects a malformed body before ever touching the network', async () => {
    const calls = stubRunnerFetch(() => new Response(null, { status: 204 }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/remote-worktrees/kill-session',
      payload: { runnerId: 'runner-1', remoteWsId: 'ws1', path: '/w/FD-1', mode: 'not-a-real-mode' },
    });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
