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
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-fb-')));
  process.env.STRADO_LICENSE_API = 'https://api.test';
  process.env.STRADO_APP_VERSION = '9.9.9';
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

describe('POST /api/feedback', () => {
  it('forwards message-only feedback (no diagnostics) to the API', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { category: 'idea', message: 'add dark mode', includeDiagnostics: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/feedback');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.category).toBe('idea');
    expect(sent.message).toBe('add dark mode');
    expect(sent.appVersion).toBe('9.9.9');
    expect(sent.diagnostics).toBeUndefined();
  });

  it('attaches diagnostics (os/arch/logTail) when opted in', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    app.deps.debugLog.log('test', 'hello from the log');
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { category: 'bug', message: 'it broke', includeDiagnostics: true, context: 'tasks' },
    });
    expect(res.statusCode).toBe(200);
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.diagnostics.arch).toBe(os.arch());
    expect(sent.diagnostics.os).toContain(os.platform());
    expect(sent.diagnostics.logTail).toContain('hello from the log');
    expect(sent.diagnostics.context).toBe('tasks');
  });

  it('returns 502 when the upstream API fails', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { category: 'other', message: 'hi', includeDiagnostics: false },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('FEEDBACK_SEND_FAILED');
  });

  it('rejects an empty message with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { category: 'bug', message: '', includeDiagnostics: false },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
