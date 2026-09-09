import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createEventBus, type BusEvent } from '../events/bus.js';
import { BODY_MAX, CONTEXT_ITEMS_MAX, CONTEXT_MAX, EXPIRES_MAX_MS, RETENTION_MS, STRADO_SENDER_ID } from './intercomSchema.js';
import {
  HUMAN, INTERCOM_CHANNEL, SCHEMA_VERSION, createDisabledIntercomStore, createIntercomStore, newMessageId,
  type EscalationInput, type ForkInput, type IntercomStore, type SendInput, type TaskInput, type TurnInput,
} from './intercomStore.js';

let dir: string;
let file: string;
let store: IntercomStore;
let events: BusEvent[];
let clock: { now: number };
const bus = createEventBus();

const A = 'claude-1@repo';
const B = 'claude-2@repo';
const C = 'shell-1@repo';

function msg(over: Partial<SendInput> = {}): SendInput {
  return {
    scopeId: 'ws', fromAgentId: A, fromExecutionId: 'exA', toAgentId: B,
    kind: 'message', body: 'hello', context: [], ...over,
  };
}

async function open(extra: { scopeCap?: number; taskOpenCap?: number } = {}): Promise<IntercomStore> {
  return createIntercomStore({ file, bus, now: () => clock.now, ...extra });
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'intercom-'));
  file = path.join(dir, 'intercom.sqlite');
  clock = { now: 1_700_000_000_000 };
  events = [];
  store = await open();
});
afterEach(async () => {
  store.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

const listen = () => bus.on(INTERCOM_CHANNEL, (e) => events.push(e));

describe('newMessageId', () => {
  it('is 26 Crockford chars and sorts by time', () => {
    const a = newMessageId(1000, Buffer.alloc(10, 0xff));
    const b = newMessageId(1001, Buffer.alloc(10, 0));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(b > a).toBe(true);
    expect(newMessageId(1000, Buffer.alloc(10, 1))).not.toBe(newMessageId(1000, Buffer.alloc(10, 2)));
  });
});

describe('open', () => {
  it('creates the schema at the current user_version with mode 0600 and reopens', async () => {
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const r1 = store.send(msg()).receipt;
    store.close();
    store = await open();
    expect(store.receipt('ws', A, r1.id).id).toBe(r1.id);
    expect(SCHEMA_VERSION).toBe(5);
  });

  it('throws on close, then any call', () => {
    store.close();
    expect(() => store.send(msg())).toThrow();
    store = createDisabledIntercomStore('test'); // afterEach closes this harmlessly
  });

  it('migrates a pre-created empty file (user_version 0, no tables)', async () => {
    store.close();
    const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'intercom-premigrate-'));
    const file2 = path.join(dir2, 'intercom.sqlite');
    // Simulate a file that exists (e.g. touched by a prior process) but was
    // never migrated: user_version 0, no tables at all.
    fs.writeFileSync(file2, '');
    const s2 = await createIntercomStore({ file: file2, bus, now: () => clock.now });
    const { receipt } = s2.send(msg());
    expect(s2.receipt('ws', A, receipt.id).state).toBe('queued');
    s2.close();
    // Reopen and confirm user_version stuck at 1 and the data survived.
    const s3 = await createIntercomStore({ file: file2, bus, now: () => clock.now });
    expect(s3.receipt('ws', A, receipt.id).id).toBe(receipt.id);
    s3.close();
    await fsp.rm(dir2, { recursive: true, force: true });
    store = await open(); // afterEach closes `store`
  });
});

describe('send', () => {
  it('queues and emits message.queued without the body', () => {
    const off = listen();
    const { receipt, replayed } = store.send(msg({ context: [{ kind: 'file', value: 'src/a.ts' }] }));
    off();
    expect(replayed).toBe(false);
    expect(receipt).toMatchObject({ state: 'queued', createdAt: clock.now, expiresAt: null, deliveryCount: 0, replyId: null });
    expect(events).toEqual([{ type: 'message.queued', data: { id: receipt.id, scopeId: 'ws', from: A, to: B, kind: 'message' } }]);
    expect(JSON.stringify(events)).not.toContain('hello');
  });

  it('stores an absolute expiresAt; 0 means never', () => {
    expect(store.send(msg({ expiresInMs: 5000 })).receipt.expiresAt).toBe(clock.now + 5000);
    expect(store.send(msg({ expiresInMs: 0 })).receipt.expiresAt).toBeNull();
  });

  it('validates sizes in bytes and the replyTo/kind pairing', () => {
    expect(() => store.send(msg({ body: '' }))).toThrow(/VALIDATION|empty/);
    expect(store.send(msg({ body: 'x'.repeat(BODY_MAX) })).receipt.state).toBe('queued');
    expect(() => store.send(msg({ body: 'x'.repeat(BODY_MAX + 1) }))).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    const item = { kind: 'text' as const, value: 'v' };
    expect(store.send(msg({ context: Array(CONTEXT_ITEMS_MAX).fill(item) })).receipt.state).toBe('queued');
    expect(() => store.send(msg({ context: Array(CONTEXT_ITEMS_MAX + 1).fill(item) }))).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    const wrapper = JSON.stringify([{ kind: 'text', value: '' }]).length;
    expect(store.send(msg({ context: [{ kind: 'text', value: 'x'.repeat(CONTEXT_MAX - wrapper) }] })).receipt.state).toBe('queued');
    expect(() => store.send(msg({ context: [{ kind: 'text', value: 'x'.repeat(CONTEXT_MAX - wrapper + 1) }] }))).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => store.send(msg({ expiresInMs: EXPIRES_MAX_MS + 1 }))).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => store.send(msg({ kind: 'reply' }))).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => store.send(msg({ kind: 'message', replyTo: 'x' }))).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('rejects a context item with an invalid kind', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bogus = [{ kind: 'blob', value: 'x' }] as any;
    expect(() => store.send(msg({ context: bogus }))).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('idempotency: same key + same content replays, different content conflicts, keys are per sender', () => {
    const first = store.send(msg({ idempotencyKey: 'k1' }));
    clock.now += 10;
    const again = store.send(msg({ idempotencyKey: 'k1' }));
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt);
    expect(() => store.send(msg({ idempotencyKey: 'k1', body: 'changed' }))).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    const other = store.send(msg({ idempotencyKey: 'k1', fromAgentId: B, fromExecutionId: 'exB', toAgentId: A }));
    expect(other.replayed).toBe(false);
    expect(other.receipt.id).not.toBe(first.receipt.id);
  });

  it('request/reply pairing is enforced', () => {
    const req = store.send(msg({ kind: 'request' })).receipt;               // A asks B
    const plain = store.send(msg()).receipt;                                 // A -> B, not a request
    const replyBy = (from: string, to: string, replyTo: string) =>
      store.send(msg({ kind: 'reply', fromAgentId: from, fromExecutionId: 'x', toAgentId: to, replyTo }));
    expect(() => replyBy(B, A, plain.id)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));   // not a request
    expect(() => replyBy(C, A, req.id)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));     // third party
    expect(() => replyBy(B, C, req.id)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));     // wrong recipient
    expect(() => replyBy(B, A, 'nope')).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));     // unknown
    const rep = replyBy(B, A, req.id).receipt;
    expect(rep.state).toBe('queued');
    expect(store.receipt('ws', A, req.id).replyId).toBe(rep.id);
    expect(() => replyBy(B, A, req.id)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));     // second reply
  });

  it('backpressure counts queued+delivered per scope', async () => {
    store.close();
    store = await open({ scopeCap: 2 });
    store.send(msg());
    store.send(msg({ scopeId: 'other', toAgentId: A }));  // another scope does not count
    store.send(msg());
    expect(() => store.send(msg())).toThrowError(expect.objectContaining({ code: 'BACKPRESSURE' }));
  });

  it('backpressure counts delivered rows too, not just queued', async () => {
    store.close();
    store = await open({ scopeCap: 2 });
    store.send(msg());
    store.send(msg());
    store.pull('ws', B, 'exB', 1);   // one queued -> delivered, one stays queued; both still count
    expect(() => store.send(msg())).toThrowError(expect.objectContaining({ code: 'BACKPRESSURE' }));
  });
});

describe('receipt', () => {
  it('is visible to sender and recipient only, within the scope', () => {
    const { id } = store.send(msg()).receipt;
    expect(store.receipt('ws', A, id).state).toBe('queued');
    expect(store.receipt('ws', B, id).state).toBe('queued');
    expect(() => store.receipt('ws', C, id)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => store.receipt('other', A, id)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => store.receipt('ws', A, 'missing')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('disabled store', () => {
  it('throws UNAVAILABLE from data methods and is inert otherwise', () => {
    const d = createDisabledIntercomStore('no sqlite');
    expect(() => d.send(msg())).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE', httpStatus: 503 }));
    expect(() => d.receipt('ws', A, 'x')).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(() => d.close()).not.toThrow();
  });
});

describe('pull', () => {
  it('delivers queued messages oldest first, atomically, and emits message.delivered', () => {
    const ids = [1, 2, 3].map((i) => { clock.now += 1; return store.send(msg({ body: `m${i}` })).receipt.id; });
    const off = listen();
    const got = store.pull('ws', B, 'exB').messages;
    off();
    expect(got.map((m) => m.id)).toEqual(ids);
    expect(got.map((m) => m.body)).toEqual(['m1', 'm2', 'm3']);
    expect(got[0]).toMatchObject({ state: 'delivered', deliveryCount: 1, redelivery: false, from: { agentId: A, executionId: 'exA' }, to: B });
    expect(events.map((e) => e.type)).toEqual(['message.delivered', 'message.delivered', 'message.delivered']);
    expect(events[0]!.data).toEqual({ id: ids[0], scopeId: 'ws', from: A, to: B, redelivery: false });
    expect(store.pull('ws', B, 'exB').messages).toEqual([]);           // a second pull right after gets nothing
    expect(store.pull('ws', A, 'exA').messages).toEqual([]);           // sender's inbox is unaffected
    expect(store.receipt('ws', A, ids[0]!)).toMatchObject({ state: 'delivered', deliveredAt: clock.now, deliveryCount: 1 });
  });

  it('honours limit with default 20 and cap 50', () => {
    for (let i = 0; i < 60; i++) { clock.now += 1; store.send(msg()); }
    expect(store.pull('ws', B, 'exB').messages.length).toBe(20);
    expect(store.pull('ws', B, 'exB', 50).messages.length).toBe(40);
    expect(store.pull('ws', B, 'exB', 500).messages.length).toBe(0);
    for (let i = 0; i < 60; i++) { clock.now += 1; store.send(msg()); }
    expect(store.pull('ws', B, 'exB', 500).messages.length).toBe(50);
    expect(store.pull('ws', B, 'exB', 0).messages.length).toBe(1);
  });

  it('redelivers unacknowledged messages after 5 minutes, flagged', () => {
    const { id } = store.send(msg()).receipt;
    expect(store.pull('ws', B, 'exB').messages).toHaveLength(1);
    clock.now += 5 * 60 * 1000 - 1;
    expect(store.pull('ws', B, 'exB').messages).toEqual([]);
    clock.now += 1;
    const off = listen();
    const again = store.pull('ws', B, 'exB').messages;
    off();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ id, redelivery: true, deliveryCount: 2, state: 'delivered' });
    expect(events).toEqual([{ type: 'message.delivered', data: { id, scopeId: 'ws', from: A, to: B, redelivery: true } }]);
    clock.now += 5 * 60 * 1000;
    store.ack('ws', B, id);
    expect(store.pull('ws', B, 'exB').messages).toEqual([]);           // acknowledged messages never come back
  });

  it('mixes fresh and redelivered rows oldest first within one limit', () => {
    const old = store.send(msg({ body: 'old' })).receipt.id;
    store.pull('ws', B, 'exB', 1);
    clock.now += 5 * 60 * 1000;
    const fresh = store.send(msg({ body: 'fresh' })).receipt.id;
    const got = store.pull('ws', B, 'exB', 2).messages;
    expect(got.map((m) => m.id)).toEqual([old, fresh]);
    expect(got.map((m) => m.redelivery)).toEqual([true, false]);
  });

  it('skips messages whose expiresAt has passed', () => {
    store.send(msg({ expiresInMs: 1000 }));
    clock.now += 1000;
    expect(store.pull('ws', B, 'exB').messages).toEqual([]);
  });
});

describe('ack', () => {
  it('acknowledges delivered or queued, is idempotent, recipient only', () => {
    const { id } = store.send(msg()).receipt;
    const off = listen();
    expect(store.ack('ws', B, id)).toMatchObject({ state: 'acknowledged', acknowledgedAt: clock.now });   // queued → acknowledged
    expect(store.ack('ws', B, id).state).toBe('acknowledged');                                            // no-op
    off();
    expect(events).toEqual([{ type: 'message.acknowledged', data: { id, scopeId: 'ws', from: A, to: B } }]);
    const second = store.send(msg()).receipt.id;
    store.pull('ws', B, 'exB');
    expect(store.ack('ws', B, second).state).toBe('acknowledged');                                        // delivered → acknowledged
    const third = store.send(msg()).receipt.id;
    expect(() => store.ack('ws', A, third)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));   // sender cannot ack
    expect(() => store.ack('ws', C, third)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => store.ack('other', B, third)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => store.ack('ws', B, 'missing')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('listScope', () => {
  it('returns every state newest first, honouring since and limit', () => {
    const t0 = clock.now;
    const a = store.send(msg({ body: 'a' })).receipt.id;
    clock.now += 10;
    const b = store.send(msg({ body: 'b', fromAgentId: B, fromExecutionId: 'exB', toAgentId: A })).receipt.id;
    clock.now += 10;
    const c = store.send(msg({ body: 'c' })).receipt.id;
    store.send(msg({ scopeId: 'other', toAgentId: A }));
    store.pull('ws', B, 'exB', 1);       // a delivered
    store.ack('ws', B, a);        // a acknowledged
    const all = store.listScope('ws');
    expect(all.map((m) => m.id)).toEqual([c, b, a]);
    expect(all.map((m) => m.state)).toEqual(['queued', 'queued', 'acknowledged']);
    expect(all.every((m) => m.redelivery === false)).toBe(true);
    expect(store.listScope('ws', { since: t0 + 10 }).map((m) => m.id)).toEqual([c, b]);
    expect(store.listScope('ws', { limit: 1 }).map((m) => m.id)).toEqual([c]);
    expect(store.listScope('ws', { limit: 999 }).length).toBe(3);
  });
});

describe('disabled store (task 4 methods)', () => {
  it('throws UNAVAILABLE', () => {
    const d = createDisabledIntercomStore('x');
    expect(() => d.pull('ws', B, 'exB')).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(() => d.ack('ws', B, 'x')).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(() => d.listScope('ws')).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
  });
});

describe('sweep', () => {
  it('expires queued messages past expiresAt with an event, never delivered ones', () => {
    const q2 = store.send(msg({ expiresInMs: 1000, body: 'a' })).receipt.id;
    clock.now += 1;
    const d2 = store.send(msg({ expiresInMs: 1000, body: 'b' })).receipt.id;
    store.pull('ws', B, 'exB', 2);                              // both delivered
    const q3 = store.send(msg({ expiresInMs: 1000, body: 'c' })).receipt.id;   // stays queued
    clock.now += 1000;
    const off = listen();
    const r = store.sweep();
    off();
    expect(r.expired).toBe(1);
    expect(store.receipt('ws', A, q3).state).toBe('expired');
    expect(store.receipt('ws', A, d2).state).toBe('delivered');
    expect(store.receipt('ws', A, q2).state).toBe('delivered');
    expect(events).toEqual([{ type: 'message.expired', data: { id: q3, scopeId: 'ws', from: A, to: B } }]);
    expect(() => store.ack('ws', B, q3)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('rejects a reply to an expired request', () => {
    const req = store.send(msg({ kind: 'request', expiresInMs: 10 })).receipt.id;
    clock.now += 10;
    store.sweep();
    expect(() => store.send(msg({ kind: 'reply', fromAgentId: B, fromExecutionId: 'exB', toAgentId: A, replyTo: req })))
      .toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('deletes acknowledged and expired rows after 7 days and keeps the rest', () => {
    const acked = store.send(msg()).receipt.id;
    store.ack('ws', B, acked);                                   // acknowledged_at = t0
    const expired = store.send(msg({ expiresInMs: 1 })).receipt.id;  // expires_at = t0 + 1
    clock.now += 1;
    store.sweep();                                               // → expired
    const delivered = store.send(msg()).receipt.id;
    store.pull('ws', B, 'exB', 1);                                      // only `delivered` is queued → delivered
    const queued = store.send(msg()).receipt.id;
    clock.now += 7 * 24 * 60 * 60 * 1000 - 2;                    // acked is 1 ms short of 7 d, expired 2 ms short
    expect(store.sweep().deleted).toBe(0);
    clock.now += 2;
    expect(store.sweep().deleted).toBe(2);
    expect(() => store.receipt('ws', A, acked)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => store.receipt('ws', A, expired)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(store.receipt('ws', A, delivered).state).toBe('delivered');
    expect(store.receipt('ws', A, queued).state).toBe('queued');
  });

  it('deleting a request leaves its reply with replyTo null (FK ON DELETE SET NULL)', () => {
    const req = store.send(msg({ kind: 'request' })).receipt.id;
    store.ack('ws', B, req);
    const rep = store.send(msg({ kind: 'reply', fromAgentId: B, fromExecutionId: 'exB', toAgentId: A, replyTo: req })).receipt.id;
    clock.now += 7 * 24 * 60 * 60 * 1000;
    expect(store.sweep().deleted).toBe(1);
    expect(store.listScope('ws').find((m) => m.id === rep)?.replyTo).toBeNull();
  });

  it('disabled store sweeps as a no-op', () => {
    expect(createDisabledIntercomStore('x').sweep()).toEqual({ expired: 0, deleted: 0, turnsDeleted: 0, tasksDeleted: 0, escalationsDeleted: 0, escalationsRetargeted: 0, forksDeleted: 0 });
  });
});

describe('schema v2 / delivery batches', () => {
  const V1_DDL = `
CREATE TABLE messages (
  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, from_agent_id TEXT NOT NULL, from_execution_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('message','request','reply')),
  reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL, body TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT, content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','delivered','acknowledged','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER, delivered_at INTEGER, acknowledged_at INTEGER,
  delivery_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX messages_idem ON messages (scope_id, from_agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_inbox ON messages (scope_id, to_agent_id, state, created_at);
CREATE INDEX messages_pressure ON messages (scope_id, state);
CREATE UNIQUE INDEX messages_one_reply ON messages (reply_to) WHERE kind = 'reply';
CREATE INDEX messages_scope_time ON messages (scope_id, created_at);
PRAGMA user_version = 1;`;

  it('migrates a version-1 file in place and reads old rows with null batch fields', async () => {
    store.close();
    await fsp.rm(file, { force: true });
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(V1_DDL);
    raw.prepare(`INSERT INTO messages (id, scope_id, from_agent_id, from_execution_id, to_agent_id, kind, body, content_hash, state, created_at)
                 VALUES ('OLD1', 'ws', ?, 'exA', ?, 'message', 'legacy', 'h', 'queued', ?)`).run(A, B, clock.now);
    raw.close();
    store = await open();
    const r = store.pull('ws', B, 'exB');
    expect(r.messages.map((m) => m.id)).toEqual(['OLD1']);
    expect(r.messages[0]).toMatchObject({ batchId: r.batchId, confirmed: false });
    const again = new DatabaseSync(file);
    expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    const cols = (again.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['delivery_batch', 'delivered_to_execution', 'delivery_confirmed_at']));
    again.close();
  });

  it('a pull forms one batch bound to the execution; an empty pull has a null batchId', () => {
    store.send(msg()); clock.now += 1; store.send(msg());
    const r = store.pull('ws', B, 'exB');
    expect(r.batchId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.messages.map((m) => m.batchId)).toEqual([r.batchId, r.batchId]);
    expect(r.messages.every((m) => m.confirmed === false)).toBe(true);
    expect(store.receipt('ws', A, r.messages[0]!.id)).toMatchObject({ state: 'delivered', confirmedAt: null });
    expect(store.pull('ws', B, 'exB')).toEqual({ batchId: null, messages: [] });
  });

  it('a redelivery is a new, unconfirmed batch', () => {
    const { id } = store.send(msg()).receipt;
    const first = store.pull('ws', B, 'exB');
    clock.now += 5 * 60 * 1000;
    const second = store.pull('ws', B, 'exB2');
    expect(second.messages[0]).toMatchObject({ id, redelivery: true, confirmed: false });
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.messages[0]!.batchId).toBe(second.batchId);
  });
});

describe('peek / claim / confirm / ackAll', () => {
  it('peek is read-only and returns the oldest deliverable rows, redeliveries flagged', () => {
    const old = store.send(msg({ body: 'old' })).receipt.id;
    store.pull('ws', B, 'exB', 1);                       // old → delivered
    clock.now += 5 * 60 * 1000;
    const fresh = store.send(msg({ body: 'fresh' })).receipt.id;
    const off = listen();
    const seen = store.peek('ws', B, 10);
    off();
    expect(seen.map((m) => [m.id, m.redelivery])).toEqual([[old, true], [fresh, false]]);
    expect(events).toEqual([]);
    expect(store.receipt('ws', A, fresh).state).toBe('queued');   // unchanged
    expect(store.peek('ws', B, 1).map((m) => m.id)).toEqual([old]);
    expect(store.peek('ws', B, 10).map((m) => m.id)).toEqual(store.pull('ws', B, 'exB').messages.map((m) => m.id));
  });

  it('peek skips expired and other agents', () => {
    store.send(msg({ expiresInMs: 1 }));
    store.send(msg({ toAgentId: C }));
    clock.now += 1;
    expect(store.peek('ws', B, 10)).toEqual([]);
  });

  it('claim flips only the given claimable ids into one batch, emits per row, and ignores ids someone else took', () => {
    const ids = [1, 2, 3].map((i) => { clock.now += 1; return store.send(msg({ body: `m${i}` })).receipt.id; });
    store.pull('ws', B, 'exOther', 1);                   // m1 taken by another pull just now
    const off = listen();
    const r = store.claim('ws', B, 'exB', [ids[0]!, ids[1]!, 'nope']);
    off();
    expect(r.messages.map((m) => m.id)).toEqual([ids[1]]);
    expect(r.messages[0]).toMatchObject({ state: 'delivered', batchId: r.batchId, confirmed: false, redelivery: false, deliveryCount: 1 });
    expect(events).toEqual([{ type: 'message.delivered', data: { id: ids[1], scopeId: 'ws', from: A, to: B, redelivery: false } }]);
    expect(store.receipt('ws', A, ids[2]!).state).toBe('queued');
    expect(store.claim('ws', B, 'exB', [])).toEqual({ batchId: null, messages: [] });
    expect(store.claim('ws', B, 'exB', [ids[1]!])).toEqual({ batchId: null, messages: [] });   // already delivered, not yet redeliverable
  });

  it('claim can take a redeliverable row and marks it redelivered', () => {
    const { id } = store.send(msg()).receipt;
    store.pull('ws', B, 'exB', 1);
    clock.now += 5 * 60 * 1000;
    const r = store.claim('ws', B, 'exB', [id]);
    expect(r.messages[0]).toMatchObject({ id, redelivery: true, deliveryCount: 2, confirmed: false });
  });

  it('confirm stamps only that batch for that agent and execution, and only once', () => {
    store.send(msg()); store.send(msg());
    const r = store.pull('ws', B, 'exB');
    expect(store.confirm('ws', B, 'exOther', r.batchId!)).toBe(0);
    expect(store.confirm('ws', A, 'exB', r.batchId!)).toBe(0);
    expect(store.confirm('other', B, 'exB', r.batchId!)).toBe(0);
    expect(store.confirm('ws', B, 'exB', 'no-such-batch')).toBe(0);
    expect(store.confirm('ws', B, 'exB', r.batchId!)).toBe(2);
    expect(store.confirm('ws', B, 'exB', r.batchId!)).toBe(0);
    expect(store.receipt('ws', A, r.messages[0]!.id)).toMatchObject({ confirmedAt: clock.now });
    expect(store.listScope('ws').every((m) => m.confirmed)).toBe(true);
  });

  it('ackAll acknowledges only confirmed rows of this execution', () => {
    const confirmedIds = [store.send(msg({ body: 'c1' })).receipt.id, store.send(msg({ body: 'c2' })).receipt.id];
    const r1 = store.pull('ws', B, 'exB');
    store.confirm('ws', B, 'exB', r1.batchId!);
    clock.now += 1;
    const unconfirmed = store.send(msg({ body: 'u' })).receipt.id;
    store.pull('ws', B, 'exB');                          // second batch, never confirmed
    clock.now += 1;
    const queued = store.send(msg({ body: 'q' })).receipt.id;
    const otherExec = store.send(msg({ body: 'o', toAgentId: C })).receipt.id;
    const rc = store.pull('ws', C, 'exC'); store.confirm('ws', C, 'exC', rc.batchId!);
    const off = listen();
    expect(store.ackAll('ws', B, 'exB2')).toBe(0);      // a later execution cannot ack exB's batch
    expect(store.ackAll('ws', B, 'exB')).toBe(2);
    off();
    expect(events.map((e) => e.type)).toEqual(['message.acknowledged', 'message.acknowledged']);
    expect(events.map((e) => (e.data as { id: string }).id).sort()).toEqual([...confirmedIds].sort());
    expect(store.receipt('ws', A, unconfirmed.toString()).state).toBe('delivered');
    expect(store.receipt('ws', A, queued).state).toBe('queued');
    expect(store.receipt('ws', A, otherExec).state).toBe('delivered');
    expect(store.ackAll('ws', B, 'exB')).toBe(0);
  });

  it('disabled store throws UNAVAILABLE for the new methods', () => {
    const d = createDisabledIntercomStore('x');
    expect(() => d.peek('ws', B, 1)).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(() => d.claim('ws', B, 'exB', [])).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(() => d.confirm('ws', B, 'exB', 'b')).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(() => d.ackAll('ws', B, 'exB')).toThrowError(expect.objectContaining({ code: 'UNAVAILABLE' }));
  });
});

describe('turns', () => {
  const turn = (over: Partial<TurnInput> = {}): TurnInput => ({
    turnIndex: 0, prompt: 'fix login', promptTruncated: false, reply: 'done', replyTruncated: false,
    startedAt: clock.now - 5000, endedAt: clock.now - 1000, ...over,
  });

  it('migrates a v2 database to v3 keeping messages, creating turns and both indexes', async () => {
    const r1 = store.send(msg()).receipt;
    store.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file);
    // A real version-2 file predates tasks/escalations (schema 4) and forks
    // (schema 5); drop them too so this simulated file matches what a genuine
    // v2 store looks like.
    db.exec('DROP TABLE turns; DROP TABLE tasks; DROP TABLE escalations; DROP TABLE forks; PRAGMA user_version = 2');
    db.close();
    store = await open();
    expect(store.receipt('ws', A, r1.id).id).toBe(r1.id);
    const db2 = new DatabaseSync(file);
    const names = (db2.prepare("SELECT name FROM sqlite_master WHERE name IN ('turns','turns_identity','turns_list')").all() as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual(['turns', 'turns_identity', 'turns_list']);
    expect((db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    db2.close();
  });

  it('recordTurns inserts, updates only a changed reply, ignores identical rows, and emits per outcome', () => {
    listen();
    const first = store.recordTurns('ws', A, 'conv1', [turn(), turn({ turnIndex: 1, prompt: 'next', reply: "I'll look" })]);
    expect(first.inserted).toHaveLength(2);
    expect(first.updated).toEqual([]);
    clock.now += 10;
    const second = store.recordTurns('ws', A, 'conv1', [turn(), turn({ turnIndex: 1, prompt: 'next', reply: 'Found it: the redirect.', endedAt: clock.now })]);
    expect(second.inserted).toEqual([]);
    expect(second.updated).toEqual([first.inserted[1]]);
    const rows = store.listTurns('ws', A, { limit: 10 });
    expect(rows.map((t) => t.turnIndex)).toEqual([1, 0]);
    expect(rows[0]).toMatchObject({ id: first.inserted[1], reply: 'Found it: the redirect.', prompt: 'next', recordedAt: clock.now - 10, endedAt: clock.now });
    expect(events.map((e) => e.type)).toEqual(['turn.recorded', 'turn.recorded', 'turn.updated']);
    expect(events[2]!.data).toEqual({ scopeId: 'ws', agentId: A, turnId: first.inserted[1] });
  });

  it('a later refresh cannot change prompt, started_at or recorded_at', () => {
    const [id] = store.recordTurns('ws', A, 'conv1', [turn({ prompt: 'p', startedAt: 1 })]).inserted;
    clock.now += 5000;
    store.recordTurns('ws', A, 'conv1', [turn({ prompt: 'different', startedAt: 2, reply: 'changed' })]);
    expect(store.listTurns('ws', A, { limit: 1 })[0]).toMatchObject({ id, prompt: 'p', startedAt: 1, recordedAt: clock.now - 5000, reply: 'changed' });
  });

  it('an update moves the turn to its new scope, not just its reply', () => {
    store.recordTurns('ws', A, 'conv1', [turn({ reply: 'first' })]);
    clock.now += 1000;
    store.recordTurns('ws2', A, 'conv1', [turn({ reply: 'changed' })]);
    expect(store.listTurns('ws2', A, { limit: 5 })).toEqual([expect.objectContaining({ scopeId: 'ws2', reply: 'changed' })]);
    expect(store.listTurns('ws', A, { limit: 5 })).toEqual([]);
  });

  it('listTurns is newest first, scoped to the agent, and pages with before', () => {
    store.recordTurns('ws', A, 'conv1', [turn({ turnIndex: 0 }), turn({ turnIndex: 1 }), turn({ turnIndex: 2 })]);
    clock.now += 1;
    store.recordTurns('ws', A, 'conv2', [turn({ turnIndex: 0, prompt: 'new conv' })]);
    store.recordTurns('ws', B, 'convB', [turn({ turnIndex: 0, prompt: 'B only' })]);
    const page1 = store.listTurns('ws', A, { limit: 2 });
    expect(page1.map((t) => [t.providerSessionId, t.turnIndex])).toEqual([['conv2', 0], ['conv1', 2]]);
    const page2 = store.listTurns('ws', A, { limit: 2, before: page1[1]!.id });
    expect(page2.map((t) => t.turnIndex)).toEqual([1, 0]);
    expect(store.listTurns('ws', A, { limit: 2, before: page2[1]!.id })).toEqual([]);
    expect(store.listTurns('ws', A, { limit: 5, before: 'NOPE' })).toEqual([]);
    expect(store.listTurns('ws', B, { limit: 5 }).map((t) => t.prompt)).toEqual(['B only']);
    expect(store.listTurns('other', A, { limit: 5 })).toEqual([]);
  });

  it('sweep keeps the newest 50 per agent and drops turns older than the retention window', () => {
    store.recordTurns('ws', A, 'old', [turn({ turnIndex: 0, prompt: 'ancient' })]);
    clock.now += 7 * 24 * 60 * 60 * 1000 + 1;
    const many = Array.from({ length: 55 }, (_, i) => turn({ turnIndex: i, prompt: `p${i}` }));
    store.recordTurns('ws', A, 'conv1', many);
    store.recordTurns('ws', B, 'convB', [turn({ turnIndex: 0 })]);
    expect(store.sweep()).toEqual({ expired: 0, deleted: 0, turnsDeleted: 6, tasksDeleted: 0, escalationsDeleted: 0, escalationsRetargeted: 0, forksDeleted: 0 });
    const left = store.listTurns('ws', A, { limit: 100 });
    expect(left).toHaveLength(50);
    expect(left.map((t) => t.turnIndex)).toEqual(Array.from({ length: 50 }, (_, i) => 54 - i));
    expect(left.some((t) => t.prompt === 'ancient')).toBe(false);
    expect(store.listTurns('ws', B, { limit: 100 })).toHaveLength(1);
  });

  it('disabled store: turn methods throw UNAVAILABLE, sweep reports zeros', () => {
    const d = createDisabledIntercomStore('x');
    expect(() => d.recordTurns('ws', A, 'c', [])).toThrow(/unavailable/);
    expect(() => d.listTurns('ws', A, { limit: 1 })).toThrow(/unavailable/);
    expect(d.sweep()).toEqual({ expired: 0, deleted: 0, turnsDeleted: 0, tasksDeleted: 0, escalationsDeleted: 0, escalationsRetargeted: 0, forksDeleted: 0 });
  });
});

describe('tasks', () => {
  const exA = { agentId: A, executionId: 'exA' };
  const exB = { agentId: B, executionId: 'exB' };
  const task = (over: Partial<TaskInput> = {}): TaskInput => ({ scopeId: 'ws', by: exA, title: 'write tests', ...over });

  beforeEach(async () => { store = await open(); });

  it('creates with defaults and emits task.created without the body', () => {
    const t = store.createTask(task({ body: 'secret body', ticketKey: 'FLT-1' }));
    expect(t).toMatchObject({ scopeId: 'ws', title: 'write tests', body: 'secret body', ticketKey: 'FLT-1', status: 'open', createdBy: exA, claimedBy: null, dependsOn: [], worktreePath: null });
    expect(t.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const ev = events.find((e) => e.type === 'task.created');
    expect(ev?.data).toEqual({ scopeId: 'ws', id: t.id, status: 'open', title: 'write tests', claimedBy: null, worktreePath: null });
    expect(JSON.stringify(ev)).not.toContain('secret body');
  });

  it('claims once, binds the claim to the execution, and refuses the second claim with a reason', () => {
    const t = store.createTask(task());
    const c = store.claimTask('ws', t.id, exB);
    expect(c.status).toBe('claimed');
    expect(c.claimedBy).toEqual(exB);
    expect(c.claimedAt).toBe(clock.now);
    try { store.claimTask('ws', t.id, exA); throw new Error('unreachable'); } catch (err) {
      expect(err).toMatchObject({ code: 'CONFLICT', details: { reason: 'already_claimed' } });
    }
  });

  it('a task with an open dependency is not claimable; a done or unknown dependency does not block', () => {
    const dep = store.createTask(task({ title: 'dep' }));
    const t = store.createTask(task({ dependsOn: [dep.id, '01ARZ3NDEKTSV4RRFFQ69G5FAV'] }));
    expect(() => store.claimTask('ws', t.id, exA)).toThrow(expect.objectContaining({ code: 'CONFLICT', details: { reason: 'deps_open' } }));
    store.claimTask('ws', dep.id, exA);
    store.doneTask('ws', dep.id, exA);
    expect(store.claimTask('ws', t.id, exA).status).toBe('claimed');
  });

  it('only the claimer or the human may release or finish; a stranger is FORBIDDEN', () => {
    const t = store.createTask(task());
    store.claimTask('ws', t.id, exA);
    expect(() => store.doneTask('ws', t.id, exB)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => store.releaseTask('ws', t.id, exB)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(store.releaseTask('ws', t.id, HUMAN).status).toBe('open');
    store.claimTask('ws', t.id, exA);
    const d = store.doneTask('ws', t.id, exA);
    expect(d.status).toBe('done');
    expect(d.doneAt).toBe(clock.now);
    expect(() => store.claimTask('ws', t.id, exB)).toThrow(expect.objectContaining({ code: 'CONFLICT', details: { reason: 'not_open' } }));
  });

  it('assign moves a claim to another execution and emits task.assigned; cancel is final except after done', () => {
    const t = store.createTask(task());
    store.claimTask('ws', t.id, exA);
    const a = store.assignTask('ws', t.id, exB);
    expect(a.claimedBy).toEqual(exB);
    expect(events.filter((e) => e.type === 'task.assigned').map((e) => (e.data as { claimedBy: string }).claimedBy)).toEqual([B]);
    // Displacing exA's claim releases it first (spec 1.1): task.released with
    // reason "reassigned" and the previous claimer, emitted before task.assigned.
    const relevant = events.filter((e) => e.type === 'task.released' || e.type === 'task.assigned');
    expect(relevant.map((e) => e.type)).toEqual(['task.released', 'task.assigned']);
    expect(relevant[0]!.data).toMatchObject({ reason: 'reassigned', claimedBy: A });
    const c = store.cancelTask('ws', t.id);
    expect(c.status).toBe('cancelled');
    expect(store.cancelTask('ws', t.id).status).toBe('cancelled'); // idempotent
    const d = store.createTask(task());
    store.claimTask('ws', d.id, exA); store.doneTask('ws', d.id, exA);
    expect(() => store.cancelTask('ws', d.id)).toThrow(expect.objectContaining({ code: 'CONFLICT', details: { reason: 'already_done' } }));
  });

  it('releaseClaimsOf frees every claim of a vanished execution across scopes with reason execution_gone', () => {
    const t1 = store.createTask(task()); store.claimTask('ws', t1.id, exA);
    const t2 = store.createTask(task({ scopeId: 'other' })); store.claimTask('other', t2.id, exA);
    const t3 = store.createTask(task()); store.claimTask('ws', t3.id, exB);
    const freed = store.releaseClaimsOf('exA');
    expect(freed.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    expect(store.getTask('ws', t1.id).status).toBe('open');
    expect(store.getTask('ws', t3.id).status).toBe('claimed');
    const rel = events.filter((e) => e.type === 'task.released');
    expect(rel).toHaveLength(2);
    expect(rel.every((e) => (e.data as { reason: string }).reason === 'execution_gone')).toBe(true);
  });

  it('lists open first, then claimed, then closed, newest first inside a group; filters by status and claimer; caps at TASK_LIST_MAX', () => {
    const t1 = store.createTask(task({ title: 'one' })); clock.now += 1;
    const t2 = store.createTask(task({ title: 'two' })); clock.now += 1;
    const t3 = store.createTask(task({ title: 'three' })); clock.now += 1;
    store.claimTask('ws', t1.id, exA);
    store.claimTask('ws', t2.id, exB); store.doneTask('ws', t2.id, exB);
    expect(store.listTasks('ws').map((t) => t.title)).toEqual(['three', 'one', 'two']);
    expect(store.listTasks('ws', { status: 'claimed' }).map((t) => t.id)).toEqual([t1.id]);
    expect(store.listTasks('ws', { claimedBy: A }).map((t) => t.id)).toEqual([t1.id]);
    expect(store.listTasks('ws', { limit: 1 })).toHaveLength(1);
    expect(store.listTasks('nope')).toEqual([]);
    expect(t3.status).toBe('open');
  });

  it('getTask is scope-bound; BACKPRESSURE past TASK_OPEN_CAP', async () => {
    const t = store.createTask(task());
    expect(() => store.getTask('other', t.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    store.cancelTask('ws', t.id); // this test's own cap check starts from zero open tasks in the scope
    store.close();
    store = await open({ taskOpenCap: 2 });
    store.createTask(task()); store.createTask(task());
    expect(() => store.createTask(task())).toThrow(expect.objectContaining({ code: 'BACKPRESSURE' }));
  });

  it('migrating a version-3 store keeps its messages and turns and adds the tables', async () => {
    store.send(msg());
    store.close();
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('DROP TABLE tasks'); db.exec('DROP TABLE escalations'); db.exec('DROP TABLE forks');
    db.exec('PRAGMA user_version = 3');
    db.close();
    store = await open();
    expect(store.listScope('ws')).toHaveLength(1);
    expect(store.listTasks('ws')).toEqual([]);
    const db2 = new DatabaseSync(file);
    expect((db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    db2.close();
  });
});

describe('escalations', () => {
  const exA = { agentId: A, executionId: 'exA' };
  const exB = { agentId: B, executionId: 'exB' };
  const esc = (over: Partial<EscalationInput> = {}): EscalationInput => ({ scopeId: 'ws', from: exA, to: 'human', title: 'which db?', body: 'postgres or sqlite?', context: [], ...over });

  beforeEach(async () => { store = await open(); });

  it('timeoutMs is rejected with a human target, including 0 (not just a truthy check)', () => {
    expect(() => store.createEscalation(esc({ timeoutMs: 0 }))).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => store.createEscalation(esc({ timeoutMs: 10_000 }))).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('a human escalation sends no message on creation and emits escalation.opened without the body', () => {
    const e = store.createEscalation(esc());
    expect(e).toMatchObject({ to: 'human', status: 'open', askMessageId: null, replyMessageId: null, expiresAt: null, taskId: null });
    expect(store.listScope('ws')).toEqual([]);
    const ev = events.find((x) => x.type === 'escalation.opened');
    expect(ev?.data).toEqual({ scopeId: 'ws', id: e.id, from: A, to: 'human', title: 'which db?', status: 'open', taskId: null });
    expect(JSON.stringify(ev)).not.toContain('postgres');
  });

  it('human resolution: one message from human tagged with the escalation, pushed via message.queued; idempotent', () => {
    const e = store.createEscalation(esc());
    const r = store.resolveEscalation('ws', e.id, HUMAN, 'sqlite');
    expect(r).toMatchObject({ status: 'resolved', resolution: 'sqlite', resolvedBy: 'human', resolvedAt: clock.now });
    const inbox = store.pull('ws', A, 'exA').messages;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: { agentId: 'human', executionId: 'human' }, kind: 'message', body: 'sqlite', escalationId: e.id });
    expect(r.replyMessageId).toBe(inbox[0]!.id);
    expect(events.some((x) => x.type === 'message.queued' && (x.data as { to: string }).to === A)).toBe(true);
    const again = store.resolveEscalation('ws', e.id, HUMAN, 'ignored');
    expect(again.resolution).toBe('sqlite');
    expect(store.listScope('ws')).toHaveLength(1);
    expect(() => store.resolveEscalation('ws', e.id, exB, 'x')).not.toThrow(); // resolved rows are idempotent for anyone
  });

  it('a peer ask delivers a request tagged with the escalation; the peer\'s ordinary reply resolves it', () => {
    const e = store.createEscalation(esc({ to: B, timeoutMs: 10_000 }));
    expect(e.expiresAt).toBe(clock.now + 10_000);
    const [ask] = store.pull('ws', B, 'exB').messages;
    expect(ask).toMatchObject({ kind: 'request', from: exA, to: B, body: 'postgres or sqlite?', escalationId: e.id });
    expect(e.askMessageId).toBe(ask!.id);
    const { receipt } = store.send(msg({ fromAgentId: B, fromExecutionId: 'exB', toAgentId: A, kind: 'reply', replyTo: ask!.id, body: 'sqlite' }));
    const after = store.getEscalation('ws', e.id);
    expect(after).toMatchObject({ status: 'resolved', resolvedBy: B, resolution: 'sqlite', replyMessageId: receipt.id });
    const types = events.map((x) => x.type);
    expect(types.indexOf('message.queued')).toBeLessThan(types.indexOf('escalation.resolved'));
    expect(store.pull('ws', A, 'exA').messages.map((m) => m.body)).toEqual(['sqlite']);
  });

  it('resolveEscalation by the target peer inserts the reply itself; a stranger is FORBIDDEN; a dismissed row is CONFLICT', () => {
    const e = store.createEscalation(esc({ to: B }));
    expect(() => store.resolveEscalation('ws', e.id, { agentId: C, executionId: 'exC' }, 'no')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    const r = store.resolveEscalation('ws', e.id, exB, 'sqlite');
    expect(r.status).toBe('resolved');
    const reply = store.pull('ws', A, 'exA').messages.find((m) => m.kind === 'reply');
    expect(reply).toMatchObject({ from: exB, replyTo: e.askMessageId, body: 'sqlite' });
    const d = store.createEscalation(esc());
    expect(store.dismissEscalation('ws', d.id).status).toBe('dismissed');
    expect(() => store.resolveEscalation('ws', d.id, HUMAN, 'x')).toThrow(expect.objectContaining({ code: 'CONFLICT', details: { reason: 'not_open' } }));
    expect(store.dismissEscalation('ws', d.id).status).toBe('dismissed');
  });

  it('retarget moves a peer ask to the human once and emits previousTo; the sweep retargets expired asks', () => {
    const e = store.createEscalation(esc({ to: B, timeoutMs: 5_000 }));
    const r = store.retargetEscalation('ws', e.id);
    expect(r).toMatchObject({ to: 'human', expiresAt: null, status: 'open' });
    expect(events.filter((x) => x.type === 'escalation.retargeted').map((x) => (x.data as { previousTo: string }).previousTo)).toEqual([B]);
    expect(store.retargetEscalation('ws', e.id).to).toBe('human'); // no second event
    expect(events.filter((x) => x.type === 'escalation.retargeted')).toHaveLength(1);
    const f = store.createEscalation(esc({ to: B, timeoutMs: 5_000 }));
    clock.now += 5_001;
    const s = store.sweep();
    expect(s.escalationsRetargeted).toBe(1);
    expect(store.getEscalation('ws', f.id).to).toBe('human');
  });

  it('pollEscalation retargets an overdue peer ask using the store\'s own clock, and leaves a not-yet-expired or human-bound row untouched', () => {
    const e = store.createEscalation(esc({ to: B, timeoutMs: 5_000 }));
    const h = store.createEscalation(esc());
    expect(store.pollEscalation('ws', e.id).to).toBe(B); // not yet expired
    expect(store.pollEscalation('ws', h.id).to).toBe('human'); // human-bound: untouched, no expiry check applies
    clock.now += 5_001;
    expect(store.pollEscalation('ws', e.id).to).toBe('human');
    expect(store.getEscalation('ws', e.id).expiresAt).toBeNull();
    expect(events.filter((x) => x.type === 'escalation.retargeted')).toHaveLength(1);
  });

  it('retargetOpenAsksTo leaves other scopes, human and closed rows alone', () => {
    const a = store.createEscalation(esc({ to: B }));
    const b = store.createEscalation(esc({ to: B, scopeId: 'other' }));
    const h = store.createEscalation(esc());
    const done = store.createEscalation(esc({ to: B }));
    store.resolveEscalation('ws', done.id, exB, 'ok');
    const moved = store.retargetOpenAsksTo('ws', B);
    expect(moved.map((x) => x.id)).toEqual([a.id]);
    expect(store.getEscalation('other', b.id).to).toBe(B);
    expect(store.getEscalation('ws', h.id).to).toBe('human');
    expect(store.getEscalation('ws', done.id).to).toBe(B);
  });

  it('lists open first then newest, filters by status, scope-bound get; sweep purges closed rows after retention', () => {
    const e1 = store.createEscalation(esc({ title: 'one' })); clock.now += 1;
    const e2 = store.createEscalation(esc({ title: 'two' })); clock.now += 1;
    store.resolveEscalation('ws', e1.id, HUMAN, 'x');
    expect(store.listEscalations('ws').map((x) => x.title)).toEqual(['two', 'one']);
    expect(store.listEscalations('ws', { status: 'open' }).map((x) => x.id)).toEqual([e2.id]);
    expect(() => store.getEscalation('other', e1.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    clock.now += RETENTION_MS + 1;
    const s = store.sweep();
    expect(s.escalationsDeleted).toBe(1);
    expect(store.listEscalations('ws').map((x) => x.id)).toEqual([e2.id]);
  });

  it('a reply to an ask whose escalation was already retargeted still lands as a plain reply and does not resolve it', () => {
    const e = store.createEscalation(esc({ to: B }));
    store.retargetEscalation('ws', e.id);
    store.send(msg({ fromAgentId: B, fromExecutionId: 'exB', toAgentId: A, kind: 'reply', replyTo: e.askMessageId!, body: 'late' }));
    expect(store.getEscalation('ws', e.id).status).toBe('open');
  });
});

describe('forks', () => {
  const exA = { agentId: A, executionId: 'exA' };
  const exB = { agentId: B, executionId: 'exB' };
  const fork = (over: Partial<ForkInput> = {}): ForkInput => ({ scopeId: 'ws', from: exA, source: { agentId: A, worktreePath: '/w/repo', mode: 'claude', sessionId: '1' }, target: { kind: 'peer', agentId: B }, notes: 'take over', ...over });
  beforeEach(async () => { store = await open(); });

  it('commits a package and delivery together and never duplicates it on retry', () => {
    const f = store.createFork(fork());
    store.forkSetSummary('ws', f.id, 'diary', 'summary');
    const delivered = store.deliverFork('ws', f.id, B, 'FORK HAND-OVER package', []);
    expect(delivered.status).toBe('delivered');
    expect(store.deliverFork('ws', f.id, B, 'retry', []).messageId).toBe(delivered.messageId);
    expect(store.peek('ws', B, 20)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'fork.delivered')).toHaveLength(1);
  });

  it('rolls back invalid delivery and leaves a cancelled fork without a package', () => {
    const f = store.createFork(fork());
    expect(() => store.deliverFork('ws', f.id, B, '', [])).toThrow();
    expect(store.getFork('ws', f.id).status).toBe('queued');
    expect(store.peek('ws', B, 20)).toEqual([]);
    store.cancelFork('ws', f.id);
    expect(store.deliverFork('ws', f.id, B, 'package', []).status).toBe('cancelled');
    expect(store.peek('ws', B, 20)).toEqual([]);
  });

  it('recovers an older package inserted before recording fork delivery', () => {
    const f = store.createFork(fork());
    const sent = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID,
      toAgentId: B, kind: 'request', body: 'FORK HAND-OVER original', forkId: f.id }));
    expect(store.deliverFork('ws', f.id, B, 'retry', []).messageId).toBe(sent.receipt.id);
    expect(store.peek('ws', B, 20)).toHaveLength(1);
  });

  it('does not mistake an unrecorded summary ask for a delivered package', () => {
    const f = store.createFork(fork());
    const ask = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID,
      toAgentId: A, kind: 'request', body: 'Strado is forking your work. Summarise it.', forkId: f.id }));
    const delivered = store.deliverFork('ws', f.id, B, 'FORK HAND-OVER package', []);
    expect(delivered.messageId).not.toBe(ask.receipt.id);
    expect(delivered.target.agentId).toBe(B);
    expect(store.peek('ws', B, 20)).toHaveLength(1);
  });

  it('creates queued, emits fork.created without notes', () => {
    const f = store.createFork(fork());
    expect(f).toMatchObject({ status: 'queued', summarySource: null, summary: null, target: { kind: 'peer', agentId: B } });
    const ev = events.find((e) => e.type === 'fork.created');
    expect(ev?.data).toEqual({ scopeId: 'ws', id: f.id, status: 'queued', source: A, target: B, targetKind: 'peer', summarySource: null });
    expect(JSON.stringify(ev)).not.toContain('take over');
  });

  it('summary request → summarising; the source\'s reply to it sets the summary and re-queues; a stranger\'s reply does not', () => {
    const f = store.createFork(fork());
    const req = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: A, kind: 'request', body: 'summarise', forkId: f.id }));
    const s = store.forkSummaryRequested('ws', f.id, req.receipt.id, clock.now + 60_000);
    expect(s).toMatchObject({ status: 'summarising', summaryMessageId: req.receipt.id, summaryDeadline: clock.now + 60_000 });
    store.send(msg({ fromAgentId: A, fromExecutionId: 'exA', toAgentId: STRADO_SENDER_ID, kind: 'reply', replyTo: req.receipt.id, body: 'goal: X; done: Y' }));
    const q = store.getFork('ws', f.id);
    expect(q).toMatchObject({ status: 'queued', summarySource: 'agent', summary: 'goal: X; done: Y' });
    expect(events.map((e) => e.type)).toContain('fork.queued');
    // The guard is the fork's own `source`, not merely "the request's recipient
    // replied": a summary ask that went to anyone else is ignored.
    const g = store.createFork(fork({ source: { agentId: B, worktreePath: '/w/repo', mode: 'claude', sessionId: '2' }, target: { kind: 'peer', agentId: C } }));
    const stray = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: A, kind: 'request', body: 'summarise', forkId: g.id }));
    store.forkSummaryRequested('ws', g.id, stray.receipt.id, clock.now + 60_000);
    store.send(msg({ fromAgentId: A, fromExecutionId: 'exA', toAgentId: STRADO_SENDER_ID, kind: 'reply', replyTo: stray.receipt.id, body: 'not my fork' }));
    expect(store.getFork('ws', g.id)).toMatchObject({ status: 'summarising', summarySource: null, summary: null });
  });

  it('a late summary reply after the fork moved on leaves the fork untouched', () => {
    const f = store.createFork(fork());
    const req = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: A, kind: 'request', body: 'summarise', forkId: f.id }));
    store.forkSummaryRequested('ws', f.id, req.receipt.id, clock.now + 60_000);
    store.forkSetSummary('ws', f.id, 'diary', 'from diary');
    store.send(msg({ fromAgentId: A, fromExecutionId: 'exA', toAgentId: STRADO_SENDER_ID, kind: 'reply', replyTo: req.receipt.id, body: 'late' }));
    expect(store.getFork('ws', f.id)).toMatchObject({ status: 'queued', summarySource: 'diary', summary: 'from diary' });
  });

  it('delivered → accepted on the target\'s ack, or on its reply; a stranger cannot', () => {
    const f = store.createFork(fork());
    const pkg = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: B, kind: 'request', body: 'FORK HAND-OVER', forkId: f.id }));
    const d = store.forkDelivered('ws', f.id, pkg.receipt.id, B, 1234);
    expect(d).toMatchObject({ status: 'delivered', messageId: pkg.receipt.id, packageBytes: 1234, deliveredAt: clock.now });
    store.pull('ws', B, 'exB');
    store.ack('ws', B, pkg.receipt.id);
    expect(store.getFork('ws', f.id)).toMatchObject({ status: 'accepted', acceptedAt: clock.now });
    expect(events.filter((e) => e.type === 'fork.accepted')).toHaveLength(1);
    const g = store.createFork(fork());
    const pkg2 = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: B, kind: 'request', body: 'FORK HAND-OVER', forkId: g.id }));
    store.forkDelivered('ws', g.id, pkg2.receipt.id, B, 10);
    store.send(msg({ fromAgentId: B, fromExecutionId: 'exB', toAgentId: STRADO_SENDER_ID, kind: 'reply', replyTo: pkg2.receipt.id, body: 'taken over' }));
    expect(store.getFork('ws', g.id).status).toBe('accepted');
    // Acceptance is gated on the fork's `target_agent`, not on whoever is
    // entitled to ack the message: a fork pointing at C stays delivered.
    const h = store.createFork(fork({ target: { kind: 'peer', agentId: C } }));
    const pkg3 = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: B, kind: 'request', body: 'FORK HAND-OVER', forkId: h.id }));
    store.forkDelivered('ws', h.id, pkg3.receipt.id, C, 10);
    store.pull('ws', B, 'exB');
    store.ack('ws', B, pkg3.receipt.id);
    expect(store.getFork('ws', h.id).status).toBe('delivered');
  });

  it('cancel only while summarising or queued; failed is terminal; list newest first with status filter; stale summarising surfaces; sweep purges closed', () => {
    const a = store.createFork(fork()); clock.now += 1;
    const b = store.createFork(fork({ target: { kind: 'new', mode: 'codex', worktreePath: '/w/repo', agentId: null } })); clock.now += 1;
    expect(store.cancelFork('ws', a.id).status).toBe('cancelled');
    expect(store.cancelFork('ws', a.id).status).toBe('cancelled');
    const req = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: A, kind: 'request', body: 's', forkId: b.id }));
    store.forkSummaryRequested('ws', b.id, req.receipt.id, clock.now + 10);
    clock.now += 11;
    expect(store.staleSummarising(clock.now).map((f) => f.id)).toEqual([b.id]);
    expect(store.forkFailed('ws', b.id, 'target did not register').status).toBe('failed');
    expect(() => store.cancelFork('ws', b.id)).toThrow(expect.objectContaining({ code: 'CONFLICT', details: { reason: 'not_cancellable' } }));
    expect(store.listForks('ws').map((f) => f.id)).toEqual([b.id, a.id]);
    expect(store.listForks('ws', { status: 'failed' }).map((f) => f.id)).toEqual([b.id]);
    clock.now += RETENTION_MS + 1;
    expect(store.sweep().forksDeleted).toBe(2);
  });

  it('ackAll accepts the delivered fork it acknowledges, once', () => {
    const f = store.createFork(fork());
    const pkg = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: B, kind: 'request', body: 'FORK HAND-OVER', forkId: f.id }));
    store.forkDelivered('ws', f.id, pkg.receipt.id, B, 10);
    const { batchId } = store.pull('ws', B, 'exB');
    store.confirm('ws', B, 'exB', batchId!);
    expect(store.ackAll('ws', B, 'exB')).toBe(1);
    expect(store.getFork('ws', f.id)).toMatchObject({ status: 'accepted', acceptedAt: clock.now });
    expect(events.filter((e) => e.type === 'fork.accepted')).toHaveLength(1);
    expect(store.ackAll('ws', B, 'exB')).toBe(0);
    expect(events.filter((e) => e.type === 'fork.accepted')).toHaveLength(1);
  });

  it('forkSetSummary fills a fork with no summary yet and never overwrites the one that got there first', () => {
    // A fork nobody was asked to summarise — the spec's "created", which is
    // `queued` in this schema — takes the sweeper's diary or `none` summary.
    const f = store.createFork(fork());
    expect(store.forkSetSummary('ws', f.id, 'diary', 'from diary')).toMatchObject({ status: 'queued', summarySource: 'diary', summary: 'from diary' });
    expect(events.filter((e) => e.type === 'fork.queued')).toHaveLength(1);
    // Summarised already: a second call changes nothing and emits nothing.
    expect(store.forkSetSummary('ws', f.id, 'none', null)).toMatchObject({ status: 'queued', summarySource: 'diary', summary: 'from diary' });
    expect(events.filter((e) => e.type === 'fork.queued')).toHaveLength(1);
    // The same guard is what makes a late diary fallback lose to the source's
    // own reply, which re-queued the fork with summarySource 'agent'.
    const g = store.createFork(fork());
    const req = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: A, kind: 'request', body: 's', forkId: g.id }));
    store.forkSummaryRequested('ws', g.id, req.receipt.id, clock.now + 60_000);
    store.send(msg({ fromAgentId: A, fromExecutionId: 'exA', toAgentId: STRADO_SENDER_ID, kind: 'reply', replyTo: req.receipt.id, body: 'agent summary' }));
    expect(store.forkSetSummary('ws', g.id, 'diary', 'from diary')).toMatchObject({ status: 'queued', summarySource: 'agent', summary: 'agent summary' });
    // Past queued there is nothing left to summarise.
    const h = store.createFork(fork());
    const pkg = store.send(msg({ fromAgentId: STRADO_SENDER_ID, fromExecutionId: STRADO_SENDER_ID, toAgentId: B, kind: 'request', body: 'FORK HAND-OVER', forkId: h.id }));
    store.forkDelivered('ws', h.id, pkg.receipt.id, B, 10);
    expect(store.forkSetSummary('ws', h.id, 'diary', 'too late')).toMatchObject({ status: 'delivered', summarySource: null, summary: null });
  });

  it('migrating a version-4 store keeps rows and adds forks + messages.fork_id', async () => {
    store.send(msg()); store.createTask({ scopeId: 'ws', by: exA, title: 't' });
    store.close();
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file); db.exec('DROP TABLE forks'); db.exec('PRAGMA user_version = 4'); db.close();
    store = await open();
    expect(store.listScope('ws')).toHaveLength(1);
    expect(store.listTasks('ws')).toHaveLength(1);
    expect(store.listForks('ws')).toEqual([]);
  });
});
