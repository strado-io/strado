import { beforeEach, describe, expect, it, vi } from 'vitest';

const jf = vi.hoisted(() => vi.fn());
vi.mock('./hubToken', () => ({ jarvisFetch: jf }));

import { MODEL_CLIENT_TIMEOUT_MS, askModel } from './modelClient';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const input = { text: 'put the dev server under claude', context: { worktree: null }, thread: [] };

beforeEach(() => { jf.mockReset(); });

describe('askModel', () => {
  it('posts text, context and thread to the workspace plan route', async () => {
    jf.mockResolvedValue(res(200, { kind: 'plan', steps: [{ action: 'tab.open', args: { mode: 'shell' } }], model: 'claude-haiku-5-5', ms: 420 }));
    const r = await askModel('ws 1', input);
    expect(jf.mock.calls[0]![0]).toBe('/api/w/ws%201/jarvis/plan');
    expect(jf.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(jf.mock.calls[0]![1].body)).toEqual(input);
    expect(r).toEqual({ kind: 'plan', steps: [{ action: 'tab.open', args: { mode: 'shell' } }], model: 'claude-haiku-5-5', ms: 420 });
  });
  it('answers come back as answers', async () => {
    jf.mockResolvedValue(res(200, { kind: 'answer', text: 'claude-1 is idle', model: 'm', ms: 1 }));
    await expect(askModel('ws1', input)).resolves.toEqual({ kind: 'answer', text: 'claude-1 is idle', model: 'm', ms: 1 });
  });
  it('maps 412 no_key, 503 timeout/model_unavailable, 403 local_only and anything else to a typed error', async () => {
    const cases: [number, unknown, string][] = [
      [412, { error: { code: 'PRECONDITION', message: 'x', details: { reason: 'no_key' } } }, 'no_key'],
      [412, { reason: 'no_key' }, 'no_key'],
      [503, { error: { code: 'UNAVAILABLE', message: 'x', details: { reason: 'timeout' } } }, 'timeout'],
      [503, { error: { code: 'UNAVAILABLE', message: 'x', details: { reason: 'bad_key' } } }, 'bad_key'],
      [503, { error: { code: 'UNAVAILABLE', message: 'x', details: { reason: 'rate_limited' } } }, 'rate_limited'],
      [503, { error: { code: 'UNAVAILABLE', message: 'x', details: { reason: 'no_key' } } }, 'no_key'],
      [400, { error: { code: 'VALIDATION', message: 'x', details: { reason: 'secret' } } }, 'secret'],
      [400, { error: { code: 'VALIDATION', message: 'x', details: { reason: 'thread' } } }, 'thread'],
      [503, { reason: 'model_unavailable' }, 'model_unavailable'],
      [403, { error: { code: 'FORBIDDEN', message: 'x', details: { reason: 'local_only' } } }, 'local_only'],
      [500, { error: { code: 'INTERNAL', message: 'boom' } }, 'failed'],
    ];
    for (const [status, body, reason] of cases) {
      jf.mockResolvedValueOnce(res(status, body));
      await expect(askModel('ws1', input)).resolves.toMatchObject({ kind: 'error', reason });
    }
    jf.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(askModel('ws1', input)).resolves.toMatchObject({ kind: 'error', reason: 'failed' });
  });
  it('an aborted request resolves as aborted (never shown as an error), and the signal reaches fetch', async () => {
    const ac = new AbortController();
    ac.abort();
    jf.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(askModel('ws1', input, ac.signal)).resolves.toEqual({ kind: 'aborted' });
    expect(jf.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('gives up after the client budget with a timeout (and aborts the request, cancelling the model call)', async () => {
    let seen: AbortSignal | undefined;
    // A request that never answers (and ignores its abort).
    jf.mockImplementation((_u?: string, init?: RequestInit) => { seen = init?.signal ?? undefined; return new Promise(() => undefined); });
    await expect(askModel('ws1', input, undefined, { timeoutMs: 20 })).resolves.toEqual({ kind: 'error', reason: 'timeout' });
    expect(seen?.aborted).toBe(true);
    expect(MODEL_CLIENT_TIMEOUT_MS).toBe(14_000); // server budget 12 s + slack
  });
  it('$ lines are never sent', async () => {
    await expect(askModel('ws1', { ...input, text: '$ cat .env' })).resolves.toMatchObject({ kind: 'error', reason: 'refused' });
    expect(jf).not.toHaveBeenCalled();
  });
});
