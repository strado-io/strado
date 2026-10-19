import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUB_TOKEN_HEADER, getHubToken, jarvisFetch, resetHubToken } from './hubToken';

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let tokens: string[];
let responder: (call: Call) => Response;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  resetHubToken();
  calls = [];
  tokens = ['tok-1', 'tok-2'];
  responder = (c) => (c.url === '/api/jarvis/session' ? json(200, { token: tokens.shift() }) : json(200, { ok: true }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { const c = { url, init }; calls.push(c); return responder(c); }));
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

const headerOf = (c: Call) => new Headers(c.init?.headers).get(HUB_TOKEN_HEADER);

describe('hub token', () => {
  it('fetches the session token once per page load, same-origin, and keeps it in memory only', async () => {
    expect(await getHubToken()).toBe('tok-1');
    expect(await getHubToken()).toBe('tok-1');
    const sessions = calls.filter((c) => c.url === '/api/jarvis/session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('concurrent first callers share one fetch', async () => {
    const [a, b] = await Promise.all([getHubToken(), getHubToken()]);
    expect([a, b]).toEqual(['tok-1', 'tok-1']);
    expect(calls.filter((c) => c.url === '/api/jarvis/session')).toHaveLength(1);
  });

  it('a failed fetch is not cached: the next call tries again', async () => {
    let fail = true;
    responder = (c) => (c.url === '/api/jarvis/session' ? (fail ? json(403, { error: { code: 'FORBIDDEN' } }) : json(200, { token: 'tok-ok' })) : json(200, {}));
    await expect(getHubToken()).rejects.toThrow(/hub token/);
    fail = false;
    expect(await getHubToken()).toBe('tok-ok');
  });

  it('a response without a token string is an error', async () => {
    responder = () => json(200, { nope: true });
    await expect(getHubToken()).rejects.toThrow(/hub token/);
  });

  it('jarvisFetch sends the token header with JSON and keeps the caller\'s headers', async () => {
    await jarvisFetch('/api/w/ws/jarvis/run', { method: 'POST', body: JSON.stringify({ x: 1 }), headers: { 'x-extra': '1' } });
    const call = calls.find((c) => c.url === '/api/w/ws/jarvis/run')!;
    expect(headerOf(call)).toBe('tok-1');
    expect(new Headers(call.init!.headers).get('x-extra')).toBe('1');
    expect(new Headers(call.init!.headers).get('content-type')).toBe('application/json');
    expect(call.init!.credentials).toBe('same-origin');
  });

  it('a 401/403 (server restarted: new per-boot token) refreshes the token and retries once', async () => {
    let seen = 0;
    responder = (c) => {
      if (c.url === '/api/jarvis/session') return json(200, { token: tokens.shift() });
      seen += 1;
      return headerOf(c) === 'tok-2' ? json(200, { ok: true }) : json(401, { error: { code: 'UNAUTHENTICATED' } });
    };
    const res = await jarvisFetch('/api/w/ws/jarvis/close', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(seen).toBe(2);
  });

  it('gives up after one retry rather than looping', async () => {
    responder = (c) => (c.url === '/api/jarvis/session' ? json(200, { token: `t${calls.length}` }) : json(403, { error: { code: 'FORBIDDEN' } }));
    const res = await jarvisFetch('/api/w/ws/jarvis/run', { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
    expect(calls.filter((c) => c.url !== '/api/jarvis/session')).toHaveLength(2);
  });
});
