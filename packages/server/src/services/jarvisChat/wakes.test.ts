import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisChatStore, type JarvisChatStore } from './store.js';
import { createEventBus } from '../../events/bus.js';
import { INTERCOM_CHANNEL } from '../intercomStore.js';
import { appWakeSource, createJarvisWakes, type WakeAgent, type JarvisWakes } from './wakes.js';

let tmp: string;
let chat: JarvisChatStore;
let agents: Map<string, WakeAgent>;
let wakes: Array<[string, string, string]>;
let wakesOn: boolean;
let clock: number;
let timers: Array<{ at: number; fn: () => void }>;
let trigger: (ev: { scopeId: string; agentId: string } | { path: string }) => void;
let w: JarvisWakes;
let reply: (r: { scopeId: string; replyTo: string; from: string; body: string }) => void;

const FOCUSES = [{ id: 'f1' }, { id: 'f2' }];

function agent(over: Partial<WakeAgent> = {}): WakeAgent {
  return { agentId: 'a1', name: 'claude-1', mode: 'claude', worktreePath: '/repos/fleetx-api', sessionId: '1', lifecycle: 'working', lastResult: null, ...over };
}

/** Moves the fake clock and runs due timers. */
async function advance(ms: number): Promise<void> {
  clock += ms;
  for (const t of timers.filter((x) => x.at <= clock)) {
    timers.splice(timers.indexOf(t), 1);
    t.fn();
  }
  await w.idle();
}

/** The agent's state changes and the source says so. */
async function set(a: WakeAgent | null, agentId = 'a1'): Promise<void> {
  if (a) agents.set(agentId, a);
  else agents.delete(agentId);
  trigger({ scopeId: 'ws', agentId });
  await w.idle();
}

async function cardFor(focusId: string, tab = 'claude-1', worktree = 'fleetx-api'): Promise<void> {
  await chat.append(focusId, { type: 'action', turnId: 't', action: 'tab.open', summary: 'Opened claude', ok: true, card: { kind: 'claude', worktree, tab } });
}

const events = async (focusId: string) => (await chat.page(focusId, {})).filter((e) => e.type === 'event').map((e) => (e as { text: string }).text);

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-wakes-'));
  chat = createJarvisChatStore(tmp);
  agents = new Map();
  wakes = [];
  wakesOn = true;
  clock = 1_000_000;
  timers = [];
  w = createJarvisWakes({
    subscribe(cb) {
      trigger = cb;
      return () => undefined;
    },
    replies(cb) {
      reply = cb;
      return () => undefined;
    },
    agent: async (_scope, id) => agents.get(id) ?? null,
    focuses: async () => FOCUSES,
    chat: async () => chat,
    wakesOn: async () => wakesOn,
    runner: { wake: (ws, focusId, text) => void wakes.push([ws, focusId, text]) },
    now: () => clock,
    setTimer: (fn, ms) => void timers.push({ at: clock + ms, fn }),
  });
  w.start();
});
afterEach(async () => {
  w.stop();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('jarvis wakes', () => {
  it('finish appends event and wakes', async () => {
    await cardFor('f1');
    await set(agent());
    await set(agent({ lifecycle: 'idle', lastResult: 'Fixed the redirect; 3 files changed.' }));
    expect(await events('f1')).toEqual(['claude-1 finished: Fixed the redirect; 3 files changed.']);
    expect(await events('f2')).toEqual([]);
    expect(wakes).toEqual([['ws', 'f1', 'claude-1 finished: Fixed the redirect; 3 files changed.']]);
  });

  it('an agent that exits mid-turn counts as finished; its last answer is trimmed', async () => {
    await cardFor('f1');
    await set(agent({ lastResult: 'x'.repeat(400) }));
    await set(null);
    const [text] = await events('f1');
    expect(text!.startsWith('claude-1 exited: ')).toBe(true);
    expect(text!.length).toBeLessThanOrEqual('claude-1 exited: '.length + 300);
    expect(wakes).toHaveLength(1);
  });

  it('events within 30s batch into one wake', async () => {
    await cardFor('f1');
    await cardFor('f1', 'claude-2');
    await set(agent());
    await set(agent({ lifecycle: 'idle', lastResult: 'one' }));
    expect(wakes).toHaveLength(1);
    // Two more finishes inside the gap: entries now, one wake when it ends.
    await set(agent({ agentId: 'a2', name: 'claude-2', sessionId: '2' }), 'a2');
    await set(agent({ agentId: 'a2', name: 'claude-2', sessionId: '2', lifecycle: 'idle', lastResult: 'two' }), 'a2');
    await set(agent());
    await set(agent({ lifecycle: 'idle', lastResult: 'three' }));
    expect(await events('f1')).toEqual(['claude-1 finished: one', 'claude-2 finished: two', 'claude-1 finished: three']);
    expect(wakes).toHaveLength(1);
    await advance(29_000);
    expect(wakes).toHaveLength(1);
    await advance(1_000);
    expect(wakes).toEqual([
      ['ws', 'f1', 'claude-1 finished: one'],
      ['ws', 'f1', 'claude-2 finished: two\nclaude-1 finished: three'],
    ]);
  });

  it('wakes off only appends', async () => {
    wakesOn = false;
    await cardFor('f1');
    await set(agent());
    await set(agent({ lifecycle: 'idle', lastResult: 'done' }));
    expect(await events('f1')).toEqual(['claude-1 finished: done']);
    expect(wakes).toEqual([]);
  });

  it('unrelated agent ignored', async () => {
    await cardFor('f1', 'claude-1', 'other-repo');
    await cardFor('f2', 'shell-1');
    await set(agent());
    await set(agent({ lifecycle: 'idle' }));
    expect(await events('f1')).toEqual([]);
    expect(await events('f2')).toEqual([]);
    expect(wakes).toEqual([]);
  });

  it('only working → idle/offline counts: a fresh idle agent, or idle → idle, is not a finish', async () => {
    await cardFor('f1');
    await set(agent({ lifecycle: 'ready' }));
    await set(agent({ lifecycle: 'idle' }));
    await set(agent({ lifecycle: 'idle' }));
    await set(agent({ lifecycle: 'needs_input' }));
    await set(agent({ lifecycle: 'idle' }));
    expect(wakes).toEqual([]);
    await set(agent());
    await set(agent({ lifecycle: 'idle', lastResult: null }));
    expect(await events('f1')).toEqual(['claude-1 finished']);
  });

  it('a status change for a worktree path rechecks the agents known there', async () => {
    await cardFor('f1');
    await set(agent());
    agents.set('a1', agent({ lifecycle: 'idle', lastResult: 'via path' }));
    trigger({ path: '/repos/other' });
    await w.idle();
    expect(wakes).toEqual([]);
    trigger({ path: '/repos/fleetx-api' });
    await w.idle();
    expect(await events('f1')).toEqual(['claude-1 finished: via path']);
  });

  it('an answer to a Jarvis ask appends and wakes', async () => {
    await w.answered('ws', 'f1', 'claude-1', 'The port is 4000.');
    expect(await events('f1')).toEqual(['claude-1 answered: The port is 4000.']);
    expect(wakes).toEqual([['ws', 'f1', 'claude-1 answered: The port is 4000.']]);
  });

  it('a reply to a Jarvis ask appends answered and wakes, once', async () => {
    agents.set('claude-1@x', agent({ agentId: 'claude-1@x', lifecycle: 'idle' }));
    w.asked('ws', 'f2', 'm1');
    reply({ scopeId: 'ws', replyTo: 'm1', from: 'claude-1@x', body: 'The port is 4000.' });
    await w.idle();
    expect(await events('f2')).toEqual(['claude-1 answered: The port is 4000.']);
    expect(wakes).toEqual([['ws', 'f2', 'claude-1 answered: The port is 4000.']]);
    reply({ scopeId: 'ws', replyTo: 'm1', from: 'claude-1@x', body: 'again' });
    await w.idle();
    expect(await events('f2')).toHaveLength(1);
  });

  it("replies to the box's own asks, or from another workspace, are ignored; a gone agent is named by its id", async () => {
    w.asked('ws', 'f1', 'm1');
    reply({ scopeId: 'ws', replyTo: 'box-ask', from: 'claude-1@x', body: 'not for jarvis' });
    reply({ scopeId: 'other', replyTo: 'm1', from: 'claude-1@x', body: 'wrong workspace' });
    await w.idle();
    expect(await events('f1')).toEqual([]);
    reply({ scopeId: 'ws', replyTo: 'm1', from: 'codex-2@y', body: 'x'.repeat(500) });
    await w.idle();
    const [text] = await events('f1');
    expect(text!.startsWith('codex-2 answered: ')).toBe(true);
    expect(text!.length).toBeLessThanOrEqual('codex-2 answered: '.length + 300);
  });

  it('remembers only the newest 500 asks', async () => {
    for (let i = 0; i < 501; i++) w.asked('ws', 'f1', `m${i}`);
    reply({ scopeId: 'ws', replyTo: 'm0', from: 'a@x', body: 'old' });
    reply({ scopeId: 'ws', replyTo: 'm500', from: 'a@x', body: 'new' });
    await w.idle();
    expect(await events('f1')).toEqual(['a answered: new']);
  });

  it('a focus deleted between the finish and the wake is skipped', async () => {
    await cardFor('f1');
    await set(agent());
    await set(agent({ lifecycle: 'idle', lastResult: 'a' }));
    await set(agent());
    await set(agent({ lifecycle: 'idle', lastResult: 'b' }));
    FOCUSES.splice(0, 1);
    try {
      await advance(30_000);
      expect(wakes).toHaveLength(1);
    } finally {
      FOCUSES.unshift({ id: 'f1' });
    }
  });
});

describe('appWakeSource', () => {
  it('turns bus events into id and path triggers, and reads an agent with its last result', async () => {
    const bus = createEventBus();
    const summary = { agentId: 'claude-1@x', alias: null, scopeId: 'ws', mode: 'claude' as const, worktreePath: '/r/api', sessionId: '1', lifecycle: 'idle' as const, executionId: 'e', live: true };
    const src = appWakeSource({
      bus,
      agents: { list: async (s) => (s === 'ws' ? [summary, { ...summary, agentId: 'shell-1@x', mode: 'shell' as const }] : []) },
      agentControl: { activityOf: () => ({ activity: null, lastResult: { text: 'done it', at: 1 } }) },
      intercom: { listScope: () => [] } as never,
    });
    const got: unknown[] = [];
    const off = src.subscribe((ev) => got.push(ev));
    bus.emit(INTERCOM_CHANNEL, { type: 'station.changed', data: { scopeId: 'ws', agentId: 'claude-1@x' } });
    bus.emit(INTERCOM_CHANNEL, { type: 'peer.dropped', data: { scopeId: 'ws', agentId: 'claude-1@x', executionId: 'e' } });
    bus.emit(INTERCOM_CHANNEL, { type: 'message.sent', data: { scopeId: 'ws', agentId: 'x' } });
    bus.emit('worktrees', { type: 'worktree.updated', data: { path: '/r/api', claudeStatus: 'idle', claudeStatusById: {} } });
    bus.emit('worktrees', { type: 'worktree.updated', data: { path: '/r/api', activitySeconds: 0 } });
    off();
    bus.emit(INTERCOM_CHANNEL, { type: 'station.changed', data: { scopeId: 'ws', agentId: 'late' } });
    expect(got).toEqual([{ scopeId: 'ws', agentId: 'claude-1@x' }, { scopeId: 'ws', agentId: 'claude-1@x' }, { path: '/r/api' }]);
    expect(await src.agent('ws', 'claude-1@x')).toEqual({
      agentId: 'claude-1@x', name: 'claude-1', mode: 'claude', worktreePath: '/r/api', sessionId: '1', lifecycle: 'idle', lastResult: 'done it',
    });
    expect(await src.agent('ws', 'shell-1@x')).toBeNull();
    // Replies to the human: read from the store, never pulled or acked.
    const msgs = [
      { id: 'r1', scopeId: 'ws', from: { agentId: 'claude-1@x', executionId: 'e' }, to: 'human', kind: 'reply', replyTo: 'm1', body: 'four thousand' },
    ];
    const listScope = vi.fn((_s: string, _o?: object) => msgs);
    const src2 = appWakeSource({ bus, agents: { list: async () => [] }, agentControl: { activityOf: () => ({ activity: null, lastResult: null }) }, intercom: { listScope } as never });
    const replies: unknown[] = [];
    const offR = src2.replies((r) => replies.push(r));
    bus.emit(INTERCOM_CHANNEL, { type: 'message.queued', data: { id: 'r1', scopeId: 'ws', from: 'claude-1@x', to: 'human', kind: 'reply', replyTo: 'm1' } });
    bus.emit(INTERCOM_CHANNEL, { type: 'message.queued', data: { id: 'r2', scopeId: 'ws', from: 'claude-1@x', to: 'claude-2@x', kind: 'reply', replyTo: 'm1' } });
    bus.emit(INTERCOM_CHANNEL, { type: 'message.queued', data: { id: 'r3', scopeId: 'ws', from: 'claude-1@x', to: 'human', kind: 'message' } });
    offR();
    expect(replies).toEqual([{ scopeId: 'ws', replyTo: 'm1', from: 'claude-1@x', body: 'four thousand' }]);
    expect(listScope).toHaveBeenCalledTimes(1);
    expect(listScope.mock.calls[0]![1]).toMatchObject({ agent: 'claude-1@x' });
    expect(await src.agent('ws', 'nope')).toBeNull();
  });
});
