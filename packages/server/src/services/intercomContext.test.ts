import { describe, expect, it } from 'vitest';
import type { MessageWithAlias } from './intercomStore.js';
import { HOOK_CONTEXT_BUDGET } from './intercomSchema.js';
import {
  HOOK_BODY_EXCERPT_MAX, HOOK_CONTEXT_ITEMS_SHOWN, HOOK_CONTEXT_VALUE_MAX,
  cutUtf8, formatInboxContext, renderHint, renderMessage, selectUnderBudget,
} from './intercomContext.js';

const T0 = new Date(2026, 8, 6, 14, 2).getTime();   // local 2026-09-06 14:02

function m(over: Partial<MessageWithAlias> = {}): MessageWithAlias {
  return {
    id: '01J8ZK3ABCDEFGHJKMNPQRSTVW', scopeId: 'ws', from: { agentId: 'claude-2@repo', executionId: 'x', alias: null },
    to: 'claude-1@repo', kind: 'message', replyTo: null, body: 'hello', context: [], state: 'delivered',
    createdAt: T0, expiresAt: null, deliveryCount: 1, redelivery: false, batchId: 'B', confirmed: false, escalationId: null, forkId: null, ...over,
  };
}
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('cutUtf8', () => {
  it('cuts on a character boundary and never exceeds the byte limit', () => {
    expect(cutUtf8('abc', 10)).toBe('abc');
    expect(cutUtf8('abcdef', 3)).toBe('abc');
    expect(cutUtf8('€'.repeat(2731), 8192)).toBe('€'.repeat(2730));   // 3-byte chars; 8193 bytes → 8190
    expect(bytes(cutUtf8('é'.repeat(5000), 8192))).toBeLessThanOrEqual(8192);
    expect(cutUtf8('😀😀', 5)).toBe('😀');                                // 4-byte chars
  });
});

describe('renderMessage', () => {
  it('renders the header, alias, kind, timestamp, request id, and redelivery marker', () => {
    expect(renderMessage(m(), 1)).toBe('[1] from claude-2@repo · message · 2026-09-06 14:02\nhello');
    expect(renderMessage(m({ from: { agentId: 'claude-2@repo', executionId: 'x', alias: 'reviewer' } }), 2).split('\n')[0])
      .toBe('[2] from claude-2@repo (reviewer) · message · 2026-09-06 14:02');
    expect(renderMessage(m({ kind: 'request' }), 1).split('\n')[0])
      .toBe('[1] from claude-2@repo · request · 2026-09-06 14:02 · id 01J8ZK3ABCDEFGHJKMNPQRSTVW');
    expect(renderMessage(m({ redelivery: true }), 1).split('\n')[0]).toMatch(/ \(redelivered\)$/);
    expect(renderMessage(m({ kind: 'reply', replyTo: 'R' }), 1).split('\n')[0]).not.toContain(' id ');
  });

  it('truncates a long body at the byte limit with the total', () => {
    const exact = renderMessage(m({ body: 'x'.repeat(HOOK_BODY_EXCERPT_MAX) }), 1);
    expect(exact).not.toContain('[truncated');
    const over = renderMessage(m({ body: 'x'.repeat(HOOK_BODY_EXCERPT_MAX + 1) }), 1);
    expect(over).toContain(`${'x'.repeat(HOOK_BODY_EXCERPT_MAX)} [truncated, ${HOOK_BODY_EXCERPT_MAX + 1} bytes total]`);
    const multi = renderMessage(m({ body: '€'.repeat(2731) }), 1);
    expect(multi).toContain(`${'€'.repeat(2730)} [truncated, 8193 bytes total]`);
  });

  it('renders context items with labels, value truncation, and an overflow line', () => {
    const items = Array.from({ length: HOOK_CONTEXT_ITEMS_SHOWN + 3 }, (_, i) => ({ kind: 'file' as const, value: `src/f${i}.ts`, ...(i === 0 ? { label: 'target' } : {}) }));
    const out = renderMessage(m({ context: items }), 1).split('\n');
    expect(out[2]).toBe('  context: file src/f0.ts (target)');
    expect(out[3]).toBe('  context: file src/f1.ts');
    expect(out.filter((l) => l.startsWith('  context:'))).toHaveLength(HOOK_CONTEXT_ITEMS_SHOWN);
    expect(out[out.length - 1]).toBe('  … 3 more context items');
    const long = renderMessage(m({ context: [{ kind: 'text', value: 'v'.repeat(HOOK_CONTEXT_VALUE_MAX + 50) }] }), 1);
    expect(long).toContain(`  context: text ${'v'.repeat(HOOK_CONTEXT_VALUE_MAX)}…`);
  });
});

describe('renderHint', () => {
  it('targets the last request when present, else the last sender; port vs socket', () => {
    const plain = renderHint([m()], 'port');
    expect(plain).toContain('curl -s -X POST http://127.0.0.1:$STRADO_STATUS_PORT/api/intercom/messages');
    expect(plain).toContain(`-d '{"to":"claude-2@repo","body":"..."}'`);
    expect(plain).toContain('To answer a request add "kind":"reply"');
    const req = renderHint([m({ kind: 'request', id: 'REQ1', from: { agentId: 'shell-1@repo', executionId: 'x', alias: null } }), m()], 'socket');
    expect(req).toContain('curl -s --unix-socket $STRADO_SERVER_SOCKET -X POST http://localhost/api/intercom/messages');
    expect(req).toContain(`-d '{"to":"shell-1@repo","kind":"reply","replyTo":"REQ1","body":"..."}'`);
    expect(req).toContain('For a plain message drop "kind" and "replyTo".');
    for (const h of [plain, req]) {
      expect(h.split('$STRADO_AGENT_TOKEN').length - 1).toBe(1);
      expect(h).toContain('Never paste the token into a message.');
    }
  });
});

describe('formatInboxContext', () => {
  it('returns null for an empty list and wraps the block with a singular/plural header', () => {
    expect(formatInboxContext([], { transport: 'port' })).toBeNull();
    const one = formatInboxContext([m()], { transport: 'port' })!;
    expect(one.startsWith('<strado-intercom>\n1 new message from agents in this workspace. Read them before acting on the prompt, and mention them in your reply so the person at this tab sees they arrived.\n\n[1] from')).toBe(true);
    expect(one.endsWith('\n</strado-intercom>')).toBe(true);
    const two = formatInboxContext([m(), m({ id: 'X2' })], { transport: 'port' })!;
    expect(two).toContain('\n2 new messages from agents');
    expect(two).toContain('\n[2] from');
  });
});

describe('selectUnderBudget', () => {
  it('keeps the longest prefix that renders within the budget', () => {
    const candidates = Array.from({ length: 11 }, (_, i) => m({ id: `M${i}`, body: 'y'.repeat(6 * 1024), createdAt: T0 + i }));
    const chosen = selectUnderBudget(candidates, { transport: 'port' });
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.length).toBeLessThan(11);
    expect(chosen.map((c) => c.id)).toEqual(candidates.slice(0, chosen.length).map((c) => c.id));
    expect(bytes(formatInboxContext(chosen, { transport: 'port' })!)).toBeLessThanOrEqual(HOOK_CONTEXT_BUDGET);
    expect(bytes(formatInboxContext(candidates.slice(0, chosen.length + 1), { transport: 'port' })!)).toBeGreaterThan(HOOK_CONTEXT_BUDGET);
  });

  it('always fits at least the first candidate, even a maximal one', () => {
    const huge = m({ body: 'z'.repeat(64 * 1024), context: Array.from({ length: 32 }, (_, i) => ({ kind: 'text' as const, value: 'w'.repeat(8000) + i, label: 'L'.repeat(200) })) });
    const chosen = selectUnderBudget([huge, m()], { transport: 'socket' });
    expect(chosen.length).toBeGreaterThanOrEqual(1);
    expect(chosen[0]!.id).toBe(huge.id);
    expect(bytes(formatInboxContext(chosen, { transport: 'socket' })!)).toBeLessThanOrEqual(HOOK_CONTEXT_BUDGET);
  });

  it('honours a custom budget and returns [] for []', () => {
    expect(selectUnderBudget([], { transport: 'port' })).toEqual([]);
    const three = [m({ id: 'A1' }), m({ id: 'A2' }), m({ id: 'A3' })];
    const small = bytes(formatInboxContext(three.slice(0, 2), { transport: 'port' })!);
    expect(selectUnderBudget(three, { transport: 'port', budget: small })).toHaveLength(2);
  });
});
