import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJarvisChatStore, redactChat, type JarvisChatStore } from './store.js';
import { JARVIS_LIMITS, type ChatEntry } from './types.js';

let dir: string;
let store: JarvisChatStore;

const user = (text: string) => ({ type: 'user' as const, text, windowId: 'w1' });
const lines = async (f: string) => (await fs.readFile(path.join(dir, f), 'utf8')).split('\n').filter(Boolean);

beforeEach(async () => {
  dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-chat-')), 'jarvis');
  store = createJarvisChatStore(dir);
});
afterEach(async () => {
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

describe('jarvis chat store', () => {
  it('append then page returns newest-last, paged by before', async () => {
    const made: ChatEntry[] = [];
    for (let i = 0; i < 5; i++) made.push(await store.append('f1', user(`m${i}`)));
    expect(new Set(made.map((e) => e.id)).size).toBe(5);
    expect(made[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const all = await store.page('f1', {});
    expect(all.map((e) => (e as { text: string }).text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect((await store.page('f1', { limit: 2 })).map((e) => e.id)).toEqual([made[3]!.id, made[4]!.id]);
    expect((await store.page('f1', { before: made[3]!.id, limit: 2 })).map((e) => e.id)).toEqual([made[1]!.id, made[2]!.id]);
    expect(await store.page('f1', { before: made[0]!.id })).toEqual([]);
    expect(await store.page('f1', { before: 'gone' })).toEqual([]);
    expect(await store.page('other', {})).toEqual([]);
    // Survives a restart: a new store reads the same file.
    expect((await createJarvisChatStore(dir).page('f1', {})).map((e) => e.id)).toEqual(made.map((e) => e.id));
  });

  it('page limit is capped', async () => {
    for (let i = 0; i < JARVIS_LIMITS.pageMax + 5; i++) await store.append('f1', { type: 'event', text: `e${i}` });
    expect(await store.page('f1', { limit: 10_000 })).toHaveLength(JARVIS_LIMITS.pageMax);
  });

  it('upsert replaces by id and keeps order', async () => {
    const a = await store.append('f1', user('a'));
    const j = await store.append('f1', { type: 'jarvis', turnId: 't1', text: 'He', done: false });
    const b = await store.append('f1', user('b'));
    await store.upsert('f1', { ...j, text: 'Hello', done: true } as ChatEntry);
    const after = await createJarvisChatStore(dir).page('f1', {});
    expect(after.map((e) => e.id)).toEqual([a.id, j.id, b.id]);
    expect(after[1]).toMatchObject({ text: 'Hello', done: true });
    expect(await store.find('f1', j.id)).toMatchObject({ text: 'Hello' });
    expect(await store.find('f1', 'nope')).toBeNull();
  });

  it('upsert of an unknown id appends it; append with a known id is refused', async () => {
    const e = await store.upsert('f1', { id: 'x1', at: new Date().toISOString(), type: 'event', text: 'hi' });
    expect((await store.page('f1', {})).map((x) => x.id)).toEqual(['x1']);
    await expect(store.append('f1', { id: e.id, type: 'event', text: 'again' })).rejects.toThrow(/already/);
  });

  it('trims to 2000 entries', async () => {
    for (let i = 0; i < JARVIS_LIMITS.logEntries + 3; i++) await store.append('f1', { type: 'event', text: `e${i}` });
    const kept = await lines('f1.jsonl');
    expect(kept).toHaveLength(JARVIS_LIMITS.logEntries);
    expect(JSON.parse(kept[0]!).text).toBe('e3');
  });

  it('trims to 2 MB', async () => {
    const big = 'x'.repeat(JARVIS_LIMITS.messageMax);
    for (let i = 0; i < 140; i++) await store.append('f1', { type: 'event', text: `${i} ${big}` });
    const { size } = await fs.stat(path.join(dir, 'f1.jsonl'));
    expect(size).toBeLessThanOrEqual(JARVIS_LIMITS.logBytes);
    const kept = await store.page('f1', { limit: 1 });
    expect((kept[0] as { text: string }).text.startsWith('139 ')).toBe(true);
    expect((await lines('f1.jsonl')).length).toBeLessThan(140);
  });

  it('redacts secrets', async () => {
    const e = await store.append('f1', user('use token=abc123 and https://me:pw@x.io and ghp_' + 'a'.repeat(30)));
    const text = (e as { text: string }).text;
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain(':pw@');
    expect(text).not.toContain('aaaaaaaaaa');
    const raw = await fs.readFile(path.join(dir, 'f1.jsonl'), 'utf8');
    expect(raw).not.toContain('abc123');
    const ap = await store.append('f1', {
      type: 'approval', turnId: 't', action: 'shell.run', summary: 'Run export API_KEY=sekrit1', state: 'pending',
      args: { line: 'export API_KEY=sekrit1', nested: { pw: ['password: hunter2'] }, n: 3 },
    });
    expect(JSON.stringify(ap)).not.toMatch(/sekrit1|hunter2/);
    expect(ap).toMatchObject({ args: { n: 3 } });
    const j = await store.append('f1', { type: 'jarvis', turnId: 't', text: '', done: false });
    const up = await store.upsert('f1', { ...j, text: 'Bearer abcdefghijklmnop1234' } as ChatEntry);
    expect((up as { text: string }).text).not.toContain('abcdefghijklmnop1234');
  });

  it('redactChat leaves ordinary text alone', () => {
    expect(redactChat('start claude in fleetx-api to fix the token refresh bug')).toBe('start claude in fleetx-api to fix the token refresh bug');
    expect(redactChat('password: hunter2')).toBe('password: [redacted]');
  });

  it('load marks running turn interrupted', async () => {
    await store.append('f1', { type: 'turn', turnId: 't1', state: 'running' });
    await store.append('f1', { type: 'jarvis', turnId: 't1', text: 'half', done: false });
    await store.append('f1', { type: 'approval', turnId: 't0', action: 'shell.run', args: {}, summary: 's', state: 'pending' });
    expect((await store.meta('f1')).running).toBe(true);
    const fresh = createJarvisChatStore(dir);
    const entries = await fresh.page('f1', {});
    expect(entries[0]).toMatchObject({ type: 'turn', state: 'interrupted' });
    expect(entries[1]).toMatchObject({ type: 'jarvis', done: true });
    expect(entries[2]).toMatchObject({ type: 'approval', state: 'pending' });
    expect(await fresh.meta('f1')).toMatchObject({ running: false, pendingApprovals: 1 });
  });

  it('a corrupt line is skipped, not fatal', async () => {
    await store.append('f1', user('ok'));
    await fs.appendFile(path.join(dir, 'f1.jsonl'), '{not json\n');
    const fresh = createJarvisChatStore(dir);
    expect(await fresh.page('f1', {})).toHaveLength(1);
    await fresh.append('f1', user('next'));
    expect(await fresh.page('f1', {})).toHaveLength(2);
  });

  it('two concurrent appends both land', async () => {
    await Promise.all([store.append('f1', user('a')), store.append('f1', user('b')), store.append('f2', user('c'))]);
    expect(await createJarvisChatStore(dir).page('f1', {})).toHaveLength(2);
    expect(await createJarvisChatStore(dir).page('f2', {})).toHaveLength(1);
  });

  it('meta: defaults, setMeta persists, counts pending approvals and running', async () => {
    expect(await store.meta('f1')).toEqual({ focusId: 'f1', agent: 'claude', sessionId: null, lastActiveAt: null, pendingApprovals: 0, running: false });
    await store.setMeta('f1', { sessionId: 's-1' });
    const ap = await store.append('f1', { type: 'approval', turnId: 't', action: 'tab.close', args: {}, summary: 'Close', state: 'pending' });
    const m = await createJarvisChatStore(dir).meta('f1');
    expect(m).toMatchObject({ sessionId: 's-1', pendingApprovals: 1, running: false });
    expect(m.lastActiveAt).toBe(ap.at);
    await store.upsert('f1', { ...ap, state: 'approved' } as ChatEntry);
    expect((await store.meta('f1')).pendingApprovals).toBe(0);
    expect((await fs.stat(path.join(dir, 'f1.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dir, 'f1.jsonl'))).mode & 0o777).toBe(0o600);
  });

  it('onChange reports entries, and meta when it moves', async () => {
    const seen: Array<{ focusId: string; entry?: string; meta?: boolean }> = [];
    const off = store.onChange((focusId, c) => seen.push({ focusId, entry: c.entry?.type, meta: c.meta ? c.meta.running : undefined }));
    await store.append('f1', user('a'));
    await store.append('f1', { type: 'turn', turnId: 't', state: 'running' });
    await store.setMeta('f1', { sessionId: 's' });
    off();
    await store.append('f1', user('b'));
    expect(seen).toEqual([
      { focusId: 'f1', entry: 'user', meta: undefined },
      { focusId: 'f1', entry: 'turn', meta: true },
      { focusId: 'f1', entry: undefined, meta: true },
    ]);
  });

  it('remove deletes both files', async () => {
    await store.append('f1', user('a'));
    await store.setMeta('f1', { sessionId: 's' });
    const seen: unknown[] = [];
    store.onChange((id, c) => seen.push([id, c]));
    await store.remove('f1');
    expect(seen).toEqual([['f1', { removed: true }]]);
    await expect(fs.stat(path.join(dir, 'f1.jsonl'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'f1.json'))).rejects.toThrow();
    expect(await store.page('f1', {})).toEqual([]);
    expect((await store.meta('f1')).sessionId).toBeNull();
    await store.remove('never'); // no-op
  });

  it('writes after remove are refused, so a turn ending late cannot bring the chat back', async () => {
    const j = await store.append('f1', { type: 'jarvis', turnId: 't', text: 'half', done: false });
    await store.remove('f1');
    await expect(store.upsert('f1', { ...j, done: true } as ChatEntry)).rejects.toThrow(/deleted/);
    await expect(store.append('f1', user('late'))).rejects.toThrow(/deleted/);
    await expect(store.setMeta('f1', { sessionId: 's' })).rejects.toThrow(/deleted/);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await store.page('f1', {})).toEqual([]);
    // Other focuses are untouched.
    await store.append('f2', user('ok'));
  });

  it('refuses a focus id that could leave the directory', async () => {
    for (const bad of ['../x', 'a/b', '', '.', 'x'.repeat(65)]) {
      await expect(store.page(bad, {})).rejects.toThrow(/focus/);
      await expect(store.append(bad, user('a'))).rejects.toThrow(/focus/);
    }
  });
});
