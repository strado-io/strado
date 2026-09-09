// A remote runner's error response should reach the caller as the SAME
// named AppError code it was raised with on the far side (CONFIG_UNPARSEABLE,
// PATH_FORBIDDEN, …) — not flattened to a generic VALIDATION/400, which would
// defeat any UI keyed on the code for a request that happens to be forwarded
// to a remote host. See routes/agentConfig.ts, the first caller that cares.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerFetch } from './runnerFetch.js';
import { AppError } from '../errors.js';

const TICKET_RES = { ticket: 'tkt-1', httpBase: 'https://fake-runner.test', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };

function makeRunnerFetch() {
  const cloud = vi.fn(async () => TICKET_RES);
  const token = vi.fn(async () => 'a'.repeat(64));
  return createRunnerFetch({ cloud: cloud as never, token, timeoutMs: 5_000 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runnerFetch — far-side error code propagation', () => {
  it('propagates a recognized far-side code and its own http status, not a flattened VALIDATION', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'CONFIG_UNPARSEABLE', message: 'settings.json: bad JSON' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));
    const runner = makeRunnerFetch();
    await expect(runner.fetch('runner-1', '/api/agent-config/claude')).rejects.toMatchObject({
      code: 'CONFIG_UNPARSEABLE',
      httpStatus: 409,
    });
  });

  it('propagates PATH_FORBIDDEN the same way', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'PATH_FORBIDDEN', message: 'not a managed config file' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));
    const runner = makeRunnerFetch();
    await expect(runner.fetch('runner-1', '/api/agent-config/claude/raw')).rejects.toMatchObject({
      code: 'PATH_FORBIDDEN',
      httpStatus: 403,
    });
  });

  it('still falls back to VALIDATION for a body with no code (the prior, existing behavior)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'no such session' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )));
    const runner = makeRunnerFetch();
    const err: unknown = await runner.fetch('runner-1', '/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VALIDATION');
    expect((err as AppError).httpStatus).toBe(400);
    expect((err as AppError).message).toBe('runner-1: no such session');
  });

  it('falls back to VALIDATION for a code we do not recognize, rather than an invalid AppError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'SOME_FUTURE_CODE', message: 'huh' } }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )));
    const runner = makeRunnerFetch();
    await expect(runner.fetch('runner-1', '/api/x')).rejects.toMatchObject({ code: 'VALIDATION', httpStatus: 400 });
  });

  it('falls back to VALIDATION for a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('plain text failure', { status: 500 })));
    const runner = makeRunnerFetch();
    await expect(runner.fetch('runner-1', '/api/x')).rejects.toMatchObject({ code: 'VALIDATION', httpStatus: 400 });
  });

  it('still maps a 503 to CLOUD_UNREACHABLE regardless of body shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'CONFIG_UNPARSEABLE', message: 'irrelevant' } }),
      { status: 503 },
    )));
    const runner = makeRunnerFetch();
    await expect(runner.fetch('runner-1', '/api/x')).rejects.toMatchObject({ code: 'CLOUD_UNREACHABLE', httpStatus: 502 });
  });

  // `code in ErrorCode` walks the prototype chain — every object has a
  // `toString`, `__proto__`, `constructor`, `hasOwnProperty`, etc. inherited
  // from `Object.prototype`, so a runner (malicious, or just confused) that
  // replies with one of THOSE strings as `code` would have read as
  // "recognized" under a plain `in` check, constructing an `AppError` whose
  // `httpStatus` is a FUNCTION (`ErrorCode.toString`, say, is not even the
  // fixed status table — `code` here indexes `ErrorCode`, not
  // `httpStatusByCode`, but either object exhibits the identical prototype-
  // chain hazard). Fastify then refuses to send that response at all
  // (`FST_ERR_BAD_STATUS_CODE`), turning a forwarded failure into an opaque
  // 500 instead of the far side's real error.
  for (const poison of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable']) {
    it(`does not treat "${poison}" (an inherited Object.prototype member) as a recognized code`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ error: { code: poison, message: 'huh' } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      )));
      const runner = makeRunnerFetch();
      const err: unknown = await runner.fetch('runner-1', '/api/x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      // The concrete failure mode this guards: httpStatus must be a NUMBER
      // Fastify can send, never whatever `ErrorCode[poison]` happens to be
      // (a function, `undefined`, …).
      expect(typeof (err as AppError).httpStatus).toBe('number');
      expect((err as AppError).code).toBe('VALIDATION');
      expect((err as AppError).httpStatus).toBe(400);
    });
  }

  // A REAL code — genuinely a key of `ErrorCode` — that these routes just
  // never raise, and that carries a special, non-error HTTP status
  // (`LOCKFILE_MISMATCH` is 200 by design for its own caller elsewhere).
  // Accepting "anything in ErrorCode" would answer the browser 200 for a
  // remote request that FAILED — worse than the generic VALIDATION/400
  // fallback this allowlist preserves instead.
  it('falls back to VALIDATION for a real but unlisted code (LOCKFILE_MISMATCH), never propagating its 200 status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'LOCKFILE_MISMATCH', message: 'stale lockfile' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )));
    const runner = makeRunnerFetch();
    await expect(runner.fetch('runner-1', '/api/x')).rejects.toMatchObject({ code: 'VALIDATION', httpStatus: 400 });
  });
});
