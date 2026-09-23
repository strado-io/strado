import { describe, expect, it } from 'vitest';
import {
  BODY_MAX, CONTEXT_ITEMS_MAX, CONTEXT_MAX, EXPIRES_MAX_MS, PULL_DEFAULT, PULL_MAX,
  ListQuery, PullBody, SendBody, UI_LIST_DEFAULT, UI_LIST_MAX,
} from './intercomSchema.js';

const ok = (body: unknown) => SendBody.safeParse(body).success;

describe('SendBody', () => {
  it('applies defaults', () => {
    const v = SendBody.parse({ to: 'claude-2@repo', body: 'hi' });
    expect(v).toEqual({ to: 'claude-2@repo', kind: 'message', body: 'hi', context: [] });
  });

  it('measures body in bytes, not characters', () => {
    // 'é' is 2 bytes in UTF-8: 32768 of them is exactly BODY_MAX bytes.
    expect(ok({ to: 'a', body: 'é'.repeat(BODY_MAX / 2) })).toBe(true);
    expect(ok({ to: 'a', body: 'é'.repeat(BODY_MAX / 2) + 'x' })).toBe(false);
    expect(ok({ to: 'a', body: '' })).toBe(false);
  });

  it('bounds context by item count and by serialised bytes', () => {
    const item = { kind: 'text', value: 'v' };
    expect(ok({ to: 'a', body: 'b', context: Array(CONTEXT_ITEMS_MAX).fill(item) })).toBe(true);
    expect(ok({ to: 'a', body: 'b', context: Array(CONTEXT_ITEMS_MAX + 1).fill(item) })).toBe(false);
    const wrapper = JSON.stringify([{ kind: 'text', value: '' }]).length; // bytes of everything except the value
    const big = { kind: 'text', value: 'x'.repeat(CONTEXT_MAX - wrapper) };
    expect(ok({ to: 'a', body: 'b', context: [big] })).toBe(true);
    expect(ok({ to: 'a', body: 'b', context: [{ ...big, value: big.value + 'x' }] })).toBe(false);
  });

  it('rejects unknown context kinds and empty values', () => {
    expect(ok({ to: 'a', body: 'b', context: [{ kind: 'blob', value: 'v' }] })).toBe(false);
    expect(ok({ to: 'a', body: 'b', context: [{ kind: 'file', value: '' }] })).toBe(false);
    expect(ok({ to: 'a', body: 'b', context: [{ kind: 'url', value: 'https://x', label: 'docs' }] })).toBe(true);
  });

  it('ties replyTo to kind=reply', () => {
    expect(ok({ to: 'a', body: 'b', kind: 'reply' })).toBe(false);
    expect(ok({ to: 'a', body: 'b', kind: 'reply', replyTo: '01ABC' })).toBe(true);
    expect(ok({ to: 'a', body: 'b', kind: 'message', replyTo: '01ABC' })).toBe(false);
    expect(ok({ to: 'a', body: 'b', kind: 'request' })).toBe(true);
  });

  it('bounds expiresInMs and idempotencyKey', () => {
    expect(ok({ to: 'a', body: 'b', expiresInMs: 0 })).toBe(true);
    expect(ok({ to: 'a', body: 'b', expiresInMs: EXPIRES_MAX_MS })).toBe(true);
    expect(ok({ to: 'a', body: 'b', expiresInMs: EXPIRES_MAX_MS + 1 })).toBe(false);
    expect(ok({ to: 'a', body: 'b', expiresInMs: -1 })).toBe(false);
    expect(ok({ to: 'a', body: 'b', expiresInMs: 1.5 })).toBe(false);
    expect(ok({ to: 'a', body: 'b', idempotencyKey: 'k'.repeat(128) })).toBe(true);
    expect(ok({ to: 'a', body: 'b', idempotencyKey: 'k'.repeat(129) })).toBe(false);
    expect(ok({ to: 'a', body: 'b', idempotencyKey: '' })).toBe(false);
  });

  it('does not accept a sender field as identity (it is simply dropped)', () => {
    const v = SendBody.parse({ to: 'a', body: 'b', from: 'claude-9@repo' });
    expect('from' in v).toBe(false);
  });
});

describe('PullBody', () => {
  it('defaults and caps limit', () => {
    expect(PullBody.parse({})).toEqual({ limit: PULL_DEFAULT });
    expect(PullBody.parse(undefined)).toEqual({ limit: PULL_DEFAULT });
    expect(PullBody.parse({ limit: PULL_MAX })).toEqual({ limit: PULL_MAX });
    expect(PullBody.safeParse({ limit: PULL_MAX + 1 }).success).toBe(false);
    expect(PullBody.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('ListQuery', () => {
  it('coerces query strings with defaults and cap', () => {
    expect(ListQuery.parse({})).toEqual({ since: 0, limit: UI_LIST_DEFAULT });
    expect(ListQuery.parse({ since: '1700000000000', limit: '5' })).toEqual({ since: 1700000000000, limit: 5 });
    expect(ListQuery.safeParse({ limit: String(UI_LIST_MAX + 1) }).success).toBe(false);
    expect(ListQuery.safeParse({ since: '-1' }).success).toBe(false);
  });
});
