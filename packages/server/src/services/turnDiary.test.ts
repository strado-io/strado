import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConversationMessage } from './agentConversation.js';
import { createEventBus } from '../events/bus.js';
import { createIntercomStore, type IntercomStore } from './intercomStore.js';
import { claudeKey, shellKey } from './terminalManager.js';
import { createTurnDiary, splitTurns, stripInjected, type TurnDiary } from './turnDiary.js';
import { TURN_PROMPT_MAX, TURN_REPLY_MAX, TURN_SETTLE_MS } from './intercomSchema.js';

const NOW = 1_700_000_000_000;
const u = (content: string, over: Partial<ConversationMessage> = {}): ConversationMessage => ({ role: 'user', content, timestamp: null, meta: false, ...over });
const a = (content: string, over: Partial<ConversationMessage> = {}): ConversationMessage => ({ role: 'assistant', content, timestamp: null, meta: false, ...over });
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('stripInjected', () => {
  it('removes every <strado-intercom> block and trims', () => {
    expect(stripInjected('<strado-intercom>\nfrom A: hi\n</strado-intercom>\nfix login')).toBe('fix login');
    expect(stripInjected('a <strado-intercom>x</strado-intercom> b <strado-intercom>y</strado-intercom>')).toBe('a  b');
    expect(stripInjected('<strado-intercom>only</strado-intercom>')).toBe('');
  });
});

describe('splitTurns', () => {
  it('pairs each prompt with the last assistant text of its turn and indexes turns', () => {
    const turns = splitTurns([
      u('first', { timestamp: 1000 }), a("I'll look", { timestamp: 1500 }), a('Done: fixed.', { timestamp: 2000 }),
      u('second', { timestamp: 3000 }), a('Second answer', { timestamp: 3500 }),
    ], NOW);
    expect(turns).toEqual([
      { turnIndex: 0, prompt: 'first', promptTruncated: false, reply: 'Done: fixed.', replyTruncated: false, startedAt: 1000, endedAt: 2000 },
      { turnIndex: 1, prompt: 'second', promptTruncated: false, reply: 'Second answer', replyTruncated: false, startedAt: 3000, endedAt: 3500 },
    ]);
  });

  it('omits the final turn while it has no assistant text, and ignores assistant text before any prompt', () => {
    expect(splitTurns([a('stray'), u('q1'), a('a1'), u('q2')], NOW).map((t) => t.turnIndex)).toEqual([0]);
  });

  it('drops meta messages entirely', () => {
    const turns = splitTurns([u('q1'), u('<command-name>/clear</command-name>', { meta: true }), a('tool echo', { meta: true }), a('real')], NOW);
    expect(turns).toEqual([expect.objectContaining({ turnIndex: 0, prompt: 'q1', reply: 'real' })]);
  });

  it('skips a prompt that was only injected context but still counts it', () => {
    const turns = splitTurns([
      u('<strado-intercom>from B: hi</strado-intercom>'), a('noted'),
      u('<strado-intercom>from B: hi</strado-intercom>\nreal question'), a('real answer'),
    ], NOW);
    expect(turns).toEqual([expect.objectContaining({ turnIndex: 1, prompt: 'real question', reply: 'real answer' })]);
  });

  it('falls back to now for missing timestamps', () => {
    expect(splitTurns([u('q'), a('a')], NOW)[0]).toMatchObject({ startedAt: NOW, endedAt: NOW });
  });

  it('cuts prompt and reply at their byte caps on character boundaries and flags it', () => {
    const prompt = '€'.repeat(3000);                        // 9000 bytes > 6 KiB
    const reply = '😀'.repeat(4000);                        // 16000 bytes > 12 KiB
    const [t] = splitTurns([u(prompt), a(reply)], NOW);
    expect(t!.promptTruncated).toBe(true);
    expect(bytes(t!.prompt)).toBeLessThanOrEqual(TURN_PROMPT_MAX);
    expect(bytes(t!.prompt)).toBeGreaterThan(TURN_PROMPT_MAX - 3);
    expect(t!.replyTruncated).toBe(true);
    expect(bytes(t!.reply)).toBeLessThanOrEqual(TURN_REPLY_MAX);
    expect(bytes(t!.reply)).toBeGreaterThan(TURN_REPLY_MAX - 4);
    const exact = 'x'.repeat(TURN_PROMPT_MAX);
    expect(splitTurns([u(exact), a('y'.repeat(TURN_REPLY_MAX))], NOW)[0]).toMatchObject({ promptTruncated: false, replyTruncated: false });
  });
});

describe('createTurnDiary', () => {
  let home: string;
  let store: IntercomStore;
  let diary: TurnDiary;
  let transcript: string;
  let getGate: (() => void) | null;
  let getCalls: number;
  let scheduled: { fn: () => void; ms: number; cancelled: boolean }[];
  const cwd = '/Users/x/proj';
  const key = claudeKey(cwd, '2');
  const exec = { key, scopeId: 'ws', agentId: 'claude-2@proj', executionId: 'ex', token: 't', spawnedAt: 'x' };
  const reference = { mode: 'claude' as const, worktreePath: cwd, sessionId: '2', providerSessionId: 'sid', updatedAt: 'x' };
  const line = (role: 'user' | 'assistant', text: string, ts: string) =>
    JSON.stringify({ type: role, timestamp: ts, message: { role, content: [{ type: 'text', text }] } }) + '\n';

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-'));
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    await fs.mkdir(dir, { recursive: true });
    transcript = path.join(dir, 'sid.jsonl');
    await fs.writeFile(transcript, line('user', 'fix login', '2026-09-06T10:00:00.000Z') + line('assistant', "I'll investigate", '2026-09-06T10:00:01.000Z'));
    store = await createIntercomStore({ file: path.join(home, 'intercom.sqlite'), bus: createEventBus() });
    getGate = null;
    getCalls = 0;
    scheduled = [];
    diary = createTurnDiary({
      agents: { byKey: (k) => (k === key ? exec : null) },
      agentSessions: {
        get: async (mode, wt, sid) => {
          getCalls += 1;
          if (getGate) await new Promise<void>((resolve) => { getGate = resolve; });
          return mode === 'claude' && wt === cwd && sid === '2' ? reference : null;
        },
      },
      intercom: store,
      homeDir: home,
      schedule: (fn, ms) => { const entry = { fn, ms, cancelled: false }; scheduled.push(entry); return { cancel: () => { entry.cancelled = true; } }; },
    });
  });
  afterEach(async () => { store.close(); await fs.rm(home, { recursive: true, force: true }); });

  const replies = () => store.listTurns('ws', 'claude-2@proj', { limit: 10 }).map((t) => t.reply);

  it('records the turn, skips an unchanged file, and updates the row when the final reply lands', async () => {
    expect(await diary.refresh('claude', cwd, '2', 'working')).toBe(1);
    expect(replies()).toEqual(["I'll investigate"]);
    expect(await diary.refresh('claude', cwd, '2', 'working')).toBe(0);
    await fs.appendFile(transcript, line('assistant', 'Fixed: the redirect.', '2026-09-06T10:00:09.000Z'));
    expect(await diary.refresh('claude', cwd, '2', 'working')).toBe(1);
    const [t] = store.listTurns('ws', 'claude-2@proj', { limit: 10 });
    expect(t).toMatchObject({ reply: 'Fixed: the redirect.', endedAt: Date.parse('2026-09-06T10:00:09.000Z'), turnIndex: 0 });
  });

  it('an agent launched inside a Shell tab is looked up under shellKey, not a per-mode key', async () => {
    const shellExec = { key: shellKey(cwd, '3'), scopeId: 'ws', agentId: 'shell-3@proj', executionId: 'ex2', token: 't2', spawnedAt: 'x' };
    const shellDiary = createTurnDiary({
      agents: { byKey: (k) => (k === shellExec.key ? shellExec : null) },
      agentSessions: {
        get: async (mode, wt, sid) => (mode === 'claude' && wt === cwd && sid === 'shell:3' ? reference : null),
      },
      intercom: store,
      homeDir: home,
      schedule: (fn, ms) => { const entry = { fn, ms, cancelled: false }; scheduled.push(entry); return { cancel: () => { entry.cancelled = true; } }; },
    });
    expect(await shellDiary.refresh('claude', cwd, 'shell:3', 'idle')).toBe(1);
    expect(store.listTurns('ws', 'shell-3@proj', { limit: 10 }).map((t) => t.reply)).toEqual(["I'll investigate"]);
  });

  it('reruns exactly once when a call arrives mid-refresh, and the rerun sees the appended text', async () => {
    getGate = () => {};                                  // arm: the first get() blocks until released
    const first = diary.refresh('claude', cwd, '2', 'working');
    await new Promise((r) => setTimeout(r, 5));          // let refresh reach the gate
    await fs.appendFile(transcript, line('assistant', 'Final answer', '2026-09-06T10:00:09.000Z'));
    const second = diary.refresh('claude', cwd, '2', 'working');
    expect(second).toBe(first);                          // coalesced onto the in-flight promise
    const release = getGate as unknown as () => void;
    getGate = null;
    release();
    await first;
    await diary.settle();
    expect(getCalls).toBe(2);                            // one run + exactly one trailing rerun
    expect(replies()).toEqual(['Final answer']);
  });

  it('a Stop schedules one settle refresh; a newer Stop replaces it; firing it picks up a late flush', async () => {
    await diary.refresh('claude', cwd, '2', 'idle');
    expect(scheduled.map((s) => s.ms)).toEqual([TURN_SETTLE_MS]);
    await diary.refresh('claude', cwd, '2', 'idle');
    expect(scheduled.map((s) => s.cancelled)).toEqual([true, false]);
    await fs.appendFile(transcript, line('assistant', 'Flushed after Stop', '2026-09-06T10:00:09.000Z'));
    scheduled[1]!.fn();
    await diary.settle();
    expect(replies()).toEqual(['Flushed after Stop']);
    expect(scheduled).toHaveLength(2);                   // the settle run itself schedules nothing
  });

  it('a waiting trigger arms the settle timer like idle; working does not', async () => {
    await diary.refresh('claude', cwd, '2', 'waiting');
    expect(scheduled).toHaveLength(1);
    await diary.refresh('claude', cwd, '2', 'working');
    expect(scheduled).toHaveLength(1);
  });

  it('considers only the newest 50 turns on every refresh, never backfilling older ones', async () => {
    let raw = '';
    for (let i = 0; i < 60; i++) raw += line('user', `q${i}`, '2026-09-06T10:00:00.000Z') + line('assistant', `a${i}`, '2026-09-06T10:00:01.000Z');
    await fs.writeFile(transcript, raw);
    expect(await diary.refresh('claude', cwd, '2', 'working')).toBe(50);
    const idx = () => store.listTurns('ws', 'claude-2@proj', { limit: 100 }).map((t) => t.turnIndex);
    expect(idx()[0]).toBe(59);
    expect(idx()).toHaveLength(50);
    expect(idx().includes(9)).toBe(false);
    await fs.appendFile(transcript, line('user', 'q60', '2026-09-06T10:00:00.000Z') + line('assistant', 'a60', '2026-09-06T10:00:01.000Z'));
    expect(await diary.refresh('claude', cwd, '2', 'working')).toBe(1);
    expect(idx()).toHaveLength(51);
    expect(idx().includes(60)).toBe(true);
    expect(idx().includes(10)).toBe(true);
    expect(idx().includes(9)).toBe(false);
  });

  it('resolves 0 and never throws for an unknown tab, a missing reference, or a closed store', async () => {
    expect(await diary.refresh('claude', cwd, '9', 'working')).toBe(0);
    expect(await diary.refresh('codex', cwd, '2', 'working')).toBe(0);
    store.close();
    expect(await diary.refresh('claude', cwd, '2', 'working')).toBe(0);
    store = await createIntercomStore({ file: path.join(home, 'intercom.sqlite'), bus: createEventBus() }); // afterEach closes this one
  });
});
