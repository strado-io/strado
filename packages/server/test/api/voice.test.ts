import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { ELEVENLABS_TOKEN_URL } from '../../src/routes/voice';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let prevHome: string | undefined;
const upstream = vi.fn();

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-voice-')));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = path.join(tmp, 'strado-home');
  app = await buildApp(await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') }));
  upstream.mockReset();
  vi.stubGlobal('fetch', upstream);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME; else process.env.STRADO_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

const saveKey = (key: string | null, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/voice-credential', headers, payload: { key } });
const token = (headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/voice/elevenlabs-token', headers });
const reason = (r: { json: () => unknown }) => (r.json() as { error?: { details?: { reason?: string } } }).error?.details?.reason;

describe('the ElevenLabs voice key', () => {
  it('is saved on this machine and only its last four ever come back', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/voice-credential' })).json()).toEqual({ present: false, last4: null });
    expect((await saveKey('sk_abcdefgh9876')).json()).toEqual({ present: true, last4: '9876' });
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/voice-credential' })).json())).not.toContain('abcd');
    const file = await fs.readFile(path.join(tmp, 'strado-home', 'voice-credential.json'), 'utf8');
    expect(JSON.parse(file)).toEqual({ elevenlabsApiKey: 'sk_abcdefgh9876' });
    expect((await fs.stat(path.join(tmp, 'strado-home', 'voice-credential.json'))).mode & 0o777).toBe(0o600);
    expect((await saveKey(null)).json()).toEqual({ present: false, last4: null });
  });

  it('cannot be set from another origin or a relayed window', async () => {
    expect((await saveKey('sk_x', { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await saveKey('sk_x', { 'x-strado-via': 'relay' })).statusCode).toBe(403);
  });
});

describe('POST /api/voice/elevenlabs-token', () => {
  it('mints a single-use token with the saved key; the key never reaches the renderer', async () => {
    await saveKey('sk_secretkey1234');
    upstream.mockResolvedValue(new Response(JSON.stringify({ token: 'sutkn_abc' }), { status: 200 }));
    const r = await token();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ token: 'sutkn_abc' });
    expect(upstream).toHaveBeenCalledWith(ELEVENLABS_TOKEN_URL, expect.objectContaining({ method: 'POST', headers: { 'xi-api-key': 'sk_secretkey1234' } }));
    expect(r.body).not.toContain('secretkey');
  });

  it('no key: 404 no_key, and nothing is sent', async () => {
    const r = await token();
    expect([r.statusCode, reason(r)]).toEqual([404, 'no_key']);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('Local only on: 403 local_only, and nothing is sent', async () => {
    await saveKey('sk_k');
    await app.inject({ method: 'PUT', url: '/api/profile', payload: { jarvisLocalOnly: true } });
    const r = await token();
    expect([r.statusCode, reason(r)]).toEqual([403, 'local_only']);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('a relayed window or another origin is refused', async () => {
    await saveKey('sk_k');
    expect((await token({ 'x-strado-via': 'relay' })).statusCode).toBe(403);
    expect((await token({ origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('ElevenLabs refuses the key: 401 bad_key; any other failure: 502 upstream', async () => {
    await saveKey('sk_k');
    upstream.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    let r = await token();
    expect([r.statusCode, reason(r)]).toEqual([401, 'bad_key']);
    upstream.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    r = await token();
    expect([r.statusCode, reason(r)]).toEqual([502, 'upstream']);
    upstream.mockRejectedValueOnce(new Error('ENOTFOUND'));
    r = await token();
    expect([r.statusCode, reason(r)]).toEqual([502, 'upstream']);
    upstream.mockResolvedValueOnce(new Response('{"nope":1}', { status: 200 }));
    r = await token();
    expect([r.statusCode, reason(r)]).toEqual([502, 'upstream']);
  });
});
